import { randomUUID } from 'node:crypto'
import type { RemoteDevicePlatform, RemotePairingPhase, RemotePairingState } from '@shared/remote'

import { log } from '../logger'
import {
  computeSas,
  derivePairingKek,
  fromBase64Url,
  generateKeyPair,
  generatePairingCode,
  generateSessionKey,
  seal,
  sharedSecret,
  toBase64Url,
  type KeyPair,
  type RemoteHeader
} from '@shared/crypto'
// **타입만** 가져온다. 값으로 import 하면 keystore 가 electron 을 끌고 들어와
// 이 모듈이 Electron 밖(헤드리스 프로브·테스트)에서 돌지 못하게 된다.
import type { RemoteKeystore } from './keystore'

/** 재수출 — main 안에서는 짧은 이름을 쓴다. */
export type PairingPhase = RemotePairingPhase
export type PairingState = RemotePairingState

/**
 * 데스크톱 쪽 페어링 흐름. `scripts/remote-probe.ts` 가 증명한 순서를 그대로 main 에 옮긴 것이다.
 *
 * 핵심 불변식 하나: **사용자가 SAS 를 확인하기 전에는 세션키가 만들어지지도, 전송되지도 않는다.**
 * QR 을 촬영한 공격자가 먼저 claim 하더라도, 랩탑 화면에 뜨는 숫자와 기기 이름이 달라지므로
 * 사용자가 거부한다. 그 확인이 이 프로토콜의 실질적 인증이고, 그래서 자동 완료 경로를 두지 않는다.
 */

/** claim 을 기다리는 폴링 주기. 사람이 QR 을 스캔하는 시간 규모라 촘촘할 이유가 없다. */
export const PAIRING_POLL_INTERVAL_MS = 1_500
/** 서버의 `pairings.expires_at` 기본값과 같아야 한다(5분). */
export const PAIRING_TTL_MS = 5 * 60_000

const IDLE: PairingState = {
  phase: 'idle',
  qr: null,
  sas: null,
  deviceName: null,
  devicePlatform: null,
  expiresAt: null,
  error: null
}

/** `pair` Edge Function 호출자. `RemoteClient.pair` 를 그대로 받는다. */
export type PairCaller = (body: Record<string, unknown>) => Promise<{
  status: number
  json: unknown
}>

export interface PairingManagerOptions {
  call: PairCaller
  keystore: RemoteKeystore
  /** QR 에 실을 릴레이 접속 정보. 폰이 이걸 보고 같은 프로젝트에 붙는다. */
  relay: { url: string; anonKey: string }
  machineId: string
  machineName: string
  onChange: (state: PairingState) => void
  now?: () => number
}

/** 진행 중인 한 번의 페어링에 대한 비밀들. 완료·취소와 함께 사라진다. */
interface Attempt {
  code: string
  keys: KeyPair
  expiresAt: number
  shared: Uint8Array | null
  deviceName: string | null
  devicePlatform: RemoteDevicePlatform | null
}

export class PairingManager {
  private readonly options: PairingManagerOptions
  private state: PairingState = IDLE
  private attempt: Attempt | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PairingManagerOptions) {
    this.options = options
  }

  getState(): PairingState {
    return this.state
  }

  /** QR 을 띄우기 시작한다. 이미 진행 중이면 이전 시도는 버려진다. */
  async start(): Promise<PairingState> {
    this.stopTimer()

    const keys = generateKeyPair()
    const code = generatePairingCode()
    const { machineId, machineName, relay } = this.options

    const res = await this.options.call({
      action: 'begin',
      machineId,
      machineName,
      machinePubKey: toBase64Url(keys.publicKey),
      code
    })
    if (res.status !== 200) return this.fail(`pairing could not start: ${describe(res)}`)

    const expiresAt = this.now() + PAIRING_TTL_MS
    this.attempt = {
      code,
      keys,
      expiresAt,
      shared: null,
      deviceName: null,
      devicePlatform: null
    }

    // QR 에는 **세션키가 들어가지 않는다.** 공개키와 1회용 코드뿐이라,
    // 이 화면을 촬영당해도 정당한 폰이 코드를 소진하면 사진은 무용지물이 된다.
    const qr = JSON.stringify({
      v: 1,
      url: relay.url,
      anonKey: relay.anonKey,
      machineId,
      machineName,
      mpk: toBase64Url(keys.publicKey),
      code
    })

    this.schedulePoll()
    return this.set({ ...IDLE, phase: 'waiting', qr, expiresAt })
  }

  /**
   * 사용자가 "내 폰이 맞다"를 눌렀다. 여기서 **처음으로** 세션키가 만들어진다.
   *
   * `confirming` 이 아닐 때 호출되면 거부한다 — UI 의 경합(확인 버튼 연타, 만료 직후 클릭)이
   * 확인 없는 완료로 새면 프로토콜의 유일한 인증이 무너진다.
   */
  async confirm(): Promise<PairingState> {
    const attempt = this.attempt
    if (this.state.phase !== 'confirming' || !attempt?.shared) {
      return this.fail('nothing to confirm')
    }
    if (this.now() >= attempt.expiresAt) return this.fail('pairing expired')

    this.stopTimer()
    this.set({ phase: 'completing' })

    // deviceId 를 여기서 정한다 — 봉인의 AAD 에 들어가야 하는데 서버가 만들면 알 수 없다.
    const deviceId = randomUUID()
    const sessionKey = generateSessionKey()
    const header: RemoteHeader = {
      v: 1,
      machineId: this.options.machineId,
      deviceId,
      kind: 'result'
    }
    const wrapped = seal(derivePairingKek(attempt.shared, attempt.code), header, sessionKey)

    const res = await this.options.call({
      action: 'complete',
      code: attempt.code,
      deviceId,
      wrappedKey: toBase64Url(wrapped.ct),
      wrappedNonce: toBase64Url(wrapped.nonce)
    })
    if (res.status !== 200) return this.fail(`pairing could not complete: ${describe(res)}`)

    // 서버가 확정한 id 를 쓴다. 재시도로 이미 완료된 페어링이라면 우리가 보낸 것과 다를 수 있다.
    const confirmedId = readString(res.json, 'deviceId') ?? deviceId

    // 같은 폰을 다시 페어링했다면 서버가 옛 기기 행을 지웠다. 로컬 키도 같이 버려야
    // 설정 화면에 다시 연결되지 않는 유령 기기가 남지 않는다.
    const replaced = readString(res.json, 'replacedDeviceId')
    if (replaced && replaced !== confirmedId) this.options.keystore.removeDevice(replaced)

    this.options.keystore.addDevice({
      deviceId: confirmedId,
      name: attempt.deviceName ?? 'phone',
      platform: attempt.devicePlatform ?? 'ios',
      sessionKey: toBase64Url(sessionKey),
      createdAt: this.now()
    })
    log.info(`원격: 기기를 페어링했습니다 (${confirmedId.slice(0, 8)}).`)

    this.attempt = null
    return this.set({ ...IDLE, phase: 'done' })
  }

  /**
   * 사용자가 취소했다(또는 창을 닫았다).
   *
   * 서버 행을 지우지 않아도 안전하다: 세션키는 확인 이후에만 만들어지므로, 남은 코드로
   * 누군가 claim 해 봐야 아무것도 얻지 못한 채 5분 뒤 만료된다. 다음 `start()` 가
   * 그 머신의 이전 페어링 행을 지우기도 한다.
   */
  cancel(): PairingState {
    this.stopTimer()
    this.attempt = null
    return this.set(IDLE)
  }

  /** 창이 닫히거나 원격이 꺼질 때. */
  dispose(): void {
    this.stopTimer()
    this.attempt = null
    this.state = IDLE
  }

  // ── 폴링 ────────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    this.stopTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, PAIRING_POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  private async poll(): Promise<void> {
    const attempt = this.attempt
    if (!attempt || this.state.phase !== 'waiting') return

    if (this.now() >= attempt.expiresAt) {
      this.attempt = null
      this.fail('pairing code expired — start again')
      return
    }

    let res: { status: number; json: unknown }
    try {
      res = await this.options.call({ action: 'status', code: attempt.code })
    } catch (err) {
      // 네트워크가 잠깐 끊긴 것뿐일 수 있다. 만료가 이 루프의 종료 조건이므로 계속 시도한다.
      log.error('페어링 폴링 실패 — 재시도합니다.', err)
      this.schedulePoll()
      return
    }

    if (res.status !== 200) {
      this.attempt = null
      this.fail(`pairing was lost: ${describe(res)}`)
      return
    }

    const devicePubKey = readString(res.json, 'devicePubKey')
    if (!devicePubKey) {
      this.schedulePoll()
      return
    }

    // claim 이 왔다. 여기서 SAS 가 결정되고, 이후로는 사용자의 판단만 남는다.
    try {
      attempt.shared = sharedSecret(attempt.keys.secretKey, fromBase64Url(devicePubKey))
    } catch (err) {
      // 저차 점이나 망가진 키. 정당한 폰은 이런 값을 보내지 않는다.
      this.attempt = null
      this.fail(`the phone sent an unusable public key (${errorText(err)})`)
      return
    }
    attempt.deviceName = readString(res.json, 'deviceName')
    attempt.devicePlatform = readPlatform(res.json)

    this.set({
      phase: 'confirming',
      qr: null,
      sas: computeSas(attempt.shared, attempt.code),
      deviceName: attempt.deviceName,
      devicePlatform: attempt.devicePlatform
    })
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private fail(message: string): PairingState {
    this.stopTimer()
    return this.set({ ...IDLE, phase: 'error', error: message })
  }

  private set(patch: Partial<PairingState>): PairingState {
    this.state = { ...this.state, ...patch }
    try {
      this.options.onChange(this.state)
    } catch (err) {
      log.error('페어링 상태 리스너 실패', err)
    }
    return this.state
  }
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

function readString(json: unknown, key: string): string | null {
  if (typeof json !== 'object' || json === null) return null
  const value = (json as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}

function readPlatform(json: unknown): RemoteDevicePlatform | null {
  const value = readString(json, 'devicePlatform')
  return value === 'ios' || value === 'android' ? value : null
}

/** 서버 오류를 사용자에게 보여 줄 한 줄로. 상태 코드는 진단에 필요하므로 남긴다. */
function describe(res: { status: number; json: unknown }): string {
  const message = readString(res.json, 'error')
  return message ? `${message} (${res.status})` : `HTTP ${res.status}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
