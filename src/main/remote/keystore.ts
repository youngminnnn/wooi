import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { RemoteDevicePlatform } from '@shared/remote'
import { writeFileAtomic } from '../fsutil'
import { log } from '../logger'
import { fromBase64Url, toBase64Url, KEY_BYTES } from '@shared/crypto'

/**
 * 원격 접근의 비밀들을 디스크에 영속한다 — 머신 신원, 기기별 세션키 `K_dev`,
 * Supabase 익명 세션.
 *
 * 이 파일 하나를 읽을 수 있으면 페어링된 폰이 할 수 있는 모든 것을 할 수 있다.
 * 그래서 평문으로는 절대 쓰지 않는다 — 전체를 `safeStorage` 로 봉인해서 macOS Keychain 이
 * 쥔 키가 있어야만 열리게 한다. 기기 이름이나 개수 같은 메타데이터도 새지 않게
 * **파일 전체**를 한 덩어리로 암호화한다.
 *
 * 경로는 `app.getPath('userData')` 아래이므로 `applyDevPaths()` 를 그대로 탄다 —
 * `npm run dev` 로 띄운 앱과 설치본의 페어링이 자동으로 분리된다(공짜로 얻는 중요한 속성이다:
 * dev 에서 실험하다 실제 폰의 페어링을 깨뜨리는 일이 없다).
 */

/** 파일 봉투 버전. 안쪽 페이로드 스키마와 별개로 올린다. */
const ENVELOPE_VERSION = 1
/** 봉인된 페이로드 스키마 버전. */
const DATA_VERSION = 1

const FILE_NAME = 'remote.json'

// ── 타입 ──────────────────────────────────────────────────────────────────

/** 이 랩탑 설치본의 신원. Supabase `machines` 행과 1:1 대응한다. */
export interface RemoteIdentity {
  /** `machines.id`. 한 번 정해지면 바뀌지 않는다. */
  machineId: string
  createdAt: number
}

/** 페어링된 기기 하나와 공유하는 비밀. */
export interface RemoteDeviceKey {
  /** `devices.id`. */
  deviceId: string
  name: string
  platform: RemoteDevicePlatform
  /** 세션키 `K_dev`(base64url). 방향별 키는 여기서 그때그때 파생한다 — 파생 결과는 저장하지 않는다. */
  sessionKey: string
  createdAt: number
}

/** 봉인되어 저장되는 전체 내용. */
export interface RemoteKeystoreData {
  version: number
  identity: RemoteIdentity | null
  /**
   * supabase-js 가 영속시키는 익명 세션(access + refresh token). 이게 곧 `auth.uid()`
   * 소유권의 증명이다 — 이걸 잃으면 새 uid 가 발급되고 기존 `machines` 행은 고아가 된다.
   */
  authSession: string | null
  devices: RemoteDeviceKey[]
}

/**
 * 키스토어를 쓸 수 없거나 읽을 수 없는 상태.
 *
 * 호출자는 이걸 잡아서 **원격 기능을 끄고 사용자에게 알려야 한다.** 조용히 빈 상태로
 * 시작하면(= store.ts 의 복구 전략) 사용자는 이유도 모른 채 폰 연결이 끊긴 것을 보게 된다.
 */
export class RemoteKeystoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteKeystoreError'
  }
}

// ── 가용성 ────────────────────────────────────────────────────────────────

/**
 * OS 가 암호화 저장소를 제공하는가.
 *
 * false 면 **평문으로 대신 저장하지 않고 원격 기능 자체를 거부한다.** 로그인 키체인이 잠긴
 * 리눅스 세션 등에서 발생하는데, 그때 평문 폴백을 두면 "안전하다고 말한 것"이 조용히
 * 거짓이 된다. keytar 같은 대체 의존도 두지 않는다.
 */
export function isRemoteStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

// ── 키스토어 ──────────────────────────────────────────────────────────────

export class RemoteKeystore {
  private readonly filePath: string
  private data: RemoteKeystoreData | null = null

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, FILE_NAME)
  }

  /** 저장된 내용을 읽는다(없으면 빈 상태). 결과는 메모리에 캐시된다. */
  read(): RemoteKeystoreData {
    if (this.data) return this.data
    this.data = this.loadFromDisk()
    return this.data
  }

  /** 머신 신원을 반환하고, 없으면 새로 만들어 저장한다. */
  identity(): RemoteIdentity {
    const data = this.read()
    if (data.identity) return data.identity
    const identity: RemoteIdentity = { machineId: randomUUID(), createdAt: Date.now() }
    this.write({ ...data, identity })
    return identity
  }

  /** supabase-js 가 영속시키는 세션 blob. 형식은 라이브러리 소유이므로 우리는 해석하지 않는다. */
  getAuthSession(): string | null {
    return this.read().authSession
  }

  setAuthSession(value: string | null): void {
    this.write({ ...this.read(), authSession: value })
  }

  listDevices(): RemoteDeviceKey[] {
    return this.read().devices
  }

  getDevice(deviceId: string): RemoteDeviceKey | undefined {
    return this.read().devices.find((d) => d.deviceId === deviceId)
  }

  /**
   * 기기를 추가하거나 같은 `deviceId` 를 덮어쓴다(재페어링).
   * 세션키는 반드시 32바이트여야 한다 — 길이가 틀린 키는 나중에 복호화 실패로만 드러나므로
   * 저장 시점에 거부한다.
   */
  addDevice(device: RemoteDeviceKey): void {
    const key = fromBase64Url(device.sessionKey)
    if (key.length !== KEY_BYTES) {
      throw new RemoteKeystoreError(`session key must be ${KEY_BYTES} bytes, got ${key.length}`)
    }
    const data = this.read()
    const devices = data.devices.filter((d) => d.deviceId !== device.deviceId)
    devices.push(device)
    this.write({ ...data, devices })
  }

  /** 기기 하나의 비밀을 지운다. 릴레이 쪽 revoke(`devices.revoked_at`)와 짝을 이룬다. */
  removeDevice(deviceId: string): void {
    const data = this.read()
    this.write({ ...data, devices: data.devices.filter((d) => d.deviceId !== deviceId) })
  }

  /**
   * 모든 원격 비밀을 지운다 — 설정의 "Delete all remote data" 와 복호화 불가 상태의 복구 경로.
   * 머신 신원까지 지우므로 다음 활성화는 새 `machines` 행으로 시작한다.
   */
  clear(): void {
    this.data = empty()
    try {
      rmSync(this.filePath, { force: true })
    } catch (err) {
      throw new RemoteKeystoreError(`failed to delete ${FILE_NAME}: ${errorText(err)}`)
    }
  }

  /** 디스크에 파일이 존재하는가(= 이 설치본이 한 번이라도 원격을 켰는가). */
  exists(): boolean {
    return existsSync(this.filePath)
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private write(next: RemoteKeystoreData): void {
    assertAvailable()
    const sealed = safeStorage.encryptString(JSON.stringify(next))
    const envelope = JSON.stringify({
      version: ENVELOPE_VERSION,
      // base64 로 감싸는 이유: JSON 파일 하나로 유지해 봉투 버전을 나중에 올릴 수 있게 한다.
      payload: sealed.toString('base64')
    })
    writeFileAtomic(this.filePath, envelope)
    // 내용이 이미 봉인되어 있어도 권한을 좁힌다 — 다중 사용자 머신에서의 심층 방어.
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // 권한 설정 실패가 저장 자체를 무효로 만들지는 않는다.
    }
    this.data = next
  }

  private loadFromDisk(): RemoteKeystoreData {
    if (!existsSync(this.filePath)) return empty()
    assertAvailable()

    let payload: string
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>
      if (typeof raw.payload !== 'string') throw new Error('missing payload')
      payload = raw.payload
    } catch (err) {
      throw new RemoteKeystoreError(
        `${FILE_NAME} is unreadable (${errorText(err)}) — remote access must be re-paired`
      )
    }

    let decrypted: string
    try {
      decrypted = safeStorage.decryptString(Buffer.from(payload, 'base64'))
    } catch {
      // 가장 흔한 원인은 손상이 아니라 **키체인 항목 상실**이다(다른 머신으로 복원, 키체인 초기화).
      // 그 경우 정답은 재페어링이므로, 조용히 빈 상태로 시작해 원인을 감추지 않는다.
      throw new RemoteKeystoreError(
        `${FILE_NAME} could not be decrypted — the OS keychain entry is missing or belongs to another machine; re-pair to continue`
      )
    }

    try {
      return normalize(JSON.parse(decrypted))
    } catch (err) {
      throw new RemoteKeystoreError(`${FILE_NAME} contains invalid data (${errorText(err)})`)
    }
  }
}

// ── 싱글턴 ────────────────────────────────────────────────────────────────

let instance: RemoteKeystore | null = null

/** 프로세스 전역 키스토어. `applyDevPaths()` 이후에 처음 호출되어야 한다. */
export function getRemoteKeystore(): RemoteKeystore {
  if (!instance) instance = new RemoteKeystore(app.getPath('userData'))
  return instance
}

/** 테스트 전용. */
export function __resetRemoteKeystore(): void {
  instance = null
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

function empty(): RemoteKeystoreData {
  return { version: DATA_VERSION, identity: null, authSession: null, devices: [] }
}

function assertAvailable(): void {
  if (!isRemoteStorageAvailable()) {
    throw new RemoteKeystoreError(
      'OS encrypted storage is unavailable — remote access is disabled rather than storing keys in plaintext'
    )
  }
}

/**
 * 복호화된 JSON 을 신뢰하지 않고 형태를 검사한다.
 *
 * 이 데이터는 우리가 썼지만 버전이 다른 우리일 수 있다(다운그레이드·부분 마이그레이션).
 * 모양이 어긋난 기기 항목은 **버리는 대신 예외로 만든다** — 조용히 사라진 기기는
 * "폰이 갑자기 연결을 잃었다"로 나타나고, 그때 원인을 찾을 단서가 남지 않는다.
 */
function normalize(raw: unknown): RemoteKeystoreData {
  if (!isRecord(raw)) throw new Error('root is not an object')

  const identity = raw.identity
  let parsedIdentity: RemoteIdentity | null = null
  if (identity !== null && identity !== undefined) {
    if (!isRecord(identity) || typeof identity.machineId !== 'string') {
      throw new Error('identity is malformed')
    }
    parsedIdentity = {
      machineId: identity.machineId,
      createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : 0
    }
  }

  const rawDevices = raw.devices
  if (rawDevices !== undefined && !Array.isArray(rawDevices)) {
    throw new Error('devices is not an array')
  }
  const devices = (rawDevices ?? []).map((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.deviceId !== 'string' ||
      typeof entry.sessionKey !== 'string' ||
      (entry.platform !== 'ios' && entry.platform !== 'android')
    ) {
      throw new Error(`device[${i}] is malformed`)
    }
    return {
      deviceId: entry.deviceId,
      name: typeof entry.name === 'string' ? entry.name : entry.deviceId,
      platform: entry.platform,
      sessionKey: entry.sessionKey,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0
    } satisfies RemoteDeviceKey
  })

  const version = typeof raw.version === 'number' ? raw.version : DATA_VERSION
  if (version > DATA_VERSION) {
    // 앞으로의 버전이 남긴 파일을 구버전 앱이 덮어쓰면 최신 필드가 소실된다.
    log.error(`remote.json 이 미래 버전(${version})입니다 — 원격 기능을 비활성화합니다.`)
    throw new Error(`unsupported keystore version ${version}`)
  }

  return {
    version: DATA_VERSION,
    identity: parsedIdentity,
    authSession: typeof raw.authSession === 'string' ? raw.authSession : null,
    devices
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 오류 메시지만 뽑는다 — 스택에 비밀이 실려 로그로 새는 것을 막는다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 세션키 바이트를 저장 형식으로. */
export function encodeSessionKey(key: Uint8Array): string {
  return toBase64Url(key)
}

/** 저장 형식의 세션키를 바이트로. */
export function decodeSessionKey(encoded: string): Uint8Array {
  return fromBase64Url(encoded)
}
