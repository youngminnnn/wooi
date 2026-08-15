import { hostname } from 'node:os'
import { app } from 'electron'
import type { RemoteDeviceSummary, RemoteStatus } from '@shared/remote'

export type { RemoteDeviceSummary, RemoteStatus }
import { log } from '../logger'
import {
  RemoteClient,
  resolveRemoteConfig,
  type RemoteConfig,
  type RemoteConnectionState
} from './client'
import {
  getRemoteKeystore,
  isRemoteStorageAvailable,
  RemoteKeystoreError,
  type RemoteKeystore
} from './keystore'
import { PairingManager, type PairingState } from './pairing'
import { StateMirror } from './mirror'
import { RemoteCommandBridge } from './bridge'
import type { AppState, PermissionRequest } from '@shared/types'
import { pendingPermissions } from './permissions'

/**
 * 원격 접근 기능의 파사드. main 의 나머지 부분은 이 파일만 안다.
 *
 * 기능이 꺼져 있을 때의 비용을 0으로 유지하는 것이 이 모듈의 주된 책임이다:
 * `enable()` 이 불리기 전에는 Supabase 클라이언트도, 소켓도, 타이머도 존재하지 않는다.
 * `disable()` 은 그 상태로 정확히 되돌린다.
 */

const OFFLINE: RemoteConnectionState = {
  status: 'offline',
  lastError: null,
  needsCaptcha: false,
  machineId: null
}

const IDLE_PAIRING: PairingState = {
  phase: 'idle',
  qr: null,
  sas: null,
  deviceName: null,
  devicePlatform: null,
  expiresAt: null,
  error: null
}

export class RemoteBridge {
  private readonly config: RemoteConfig | null
  private readonly onChange: (status: RemoteStatus) => void
  private keystore: RemoteKeystore | null = null
  private client: RemoteClient | null = null
  private pairing: PairingManager | null = null
  private mirror: StateMirror | null = null
  private commandBridge: RemoteCommandBridge | null = null
  private readonly getAppState: () => AppState | null
  private unsubscribe: (() => void) | null = null
  private enabled = false
  private fault: string | null = null

  constructor(
    onChange: (status: RemoteStatus) => void,
    config = resolveRemoteConfig(),
    // 기본값이 null 을 돌려준다 — 테스트가 상태 없이 브리지만 만들 수 있어야 하고,
    // 그때는 초기 스냅샷을 건너뛰는 것이 맞다(가짜 빈 AppState 를 지어내면 폰이 그걸 본다).
    getAppState: () => AppState | null = () => null
  ) {
    this.config = config
    this.onChange = onChange
    this.getAppState = getAppState
  }

  /** 지금 상태 스냅샷. 렌더러가 언제든 물어볼 수 있다. */
  status(): RemoteStatus {
    return {
      configured: this.config !== null,
      storageAvailable: isRemoteStorageAvailable(),
      enabled: this.enabled,
      connection: this.client?.getState() ?? OFFLINE,
      pairing: this.pairing?.getState() ?? IDLE_PAIRING,
      devices: this.devices(),
      fault: this.fault
    }
  }

  /**
   * 마스터 스위치. 켜면 릴레이에 붙고, 끄면 **모든 자원을 놓는다** —
   * 토글이 "UI 만 숨기는" 것이 아니라 실제로 네트워크를 끊는 것이어야 한다.
   */
  async setEnabled(next: boolean): Promise<RemoteStatus> {
    if (next === this.enabled) return this.status()
    this.enabled = next
    this.fault = null

    if (!next) {
      this.commandBridge?.dispose()
      this.commandBridge = null
      this.mirror?.dispose()
      this.mirror = null
      this.pairing?.dispose()
      this.pairing = null
      await this.client?.dispose()
      this.client = null
      this.unsubscribe?.()
      this.unsubscribe = null
      return this.emit()
    }

    if (!this.config) {
      this.fault = 'remote access is not configured in this build'
      this.enabled = false
      return this.emit()
    }

    try {
      const keystore = this.ensureKeystore()
      const client = new RemoteClient({
        config: this.config,
        keystore,
        appVersion: app.getVersion(),
        machineName: hostname()
      })
      this.unsubscribe = client.onChange(() => this.emit())
      this.client = client
      await client.connect()
      this.mirror = new StateMirror({
        supabase: () => client.supabase(),
        keystore,
        machine: () => client.getMachine()
      })
      const machineId = client.getState().machineId
      if (!machineId) throw new Error('remote client connected without a machine id')
      this.commandBridge = new RemoteCommandBridge({
        supabase: () => client.supabase(),
        keystore,
        machineId
      })
      // 붙자마자 현재 상태를 한 번 밀어 준다. 미러는 **변화**에만 반응하므로 이게 없으면
      // 방금 페어링한 폰은 랩탑에서 뭔가 일어날 때까지 빈 화면을 본다.
      const initial = this.getAppState()
      if (initial) this.publishState(initial, pendingPermissions.list())
    } catch (err) {
      // 키스토어 복호화 실패가 가장 흔하다 — 조용히 꺼진 것처럼 보이면 안 된다.
      this.fault = errorText(err)
      this.enabled = false
      this.commandBridge?.dispose()
      this.commandBridge = null
      this.mirror?.dispose()
      this.mirror = null
      this.pairing?.dispose()
      this.pairing = null
      await this.client?.dispose()
      this.client = null
      this.unsubscribe?.()
      this.unsubscribe = null
      log.error('원격 활성화 실패', this.fault)
    }
    return this.emit()
  }

  // ── 페어링 ──────────────────────────────────────────────────────────────

  publishState(appState: AppState, pendingPermissions: PermissionRequest[]): void {
    this.mirror?.publish(appState, pendingPermissions)
  }

  async startPairing(): Promise<RemoteStatus> {
    const client = this.client
    const machineId = client?.getState().machineId
    if (!client || !machineId || !this.config) {
      this.fault = 'connect to the relay before pairing'
      return this.emit()
    }

    this.pairing ??= new PairingManager({
      call: (body) => client.pair(body),
      keystore: this.ensureKeystore(),
      relay: { url: this.config.url, anonKey: this.config.anonKey },
      machineId,
      machineName: hostname(),
      onChange: () => this.emit()
    })
    await this.pairing.start()
    return this.emit()
  }

  async confirmPairing(): Promise<RemoteStatus> {
    await this.pairing?.confirm()
    // 새 기기는 직전 발행의 수신자가 아니었다. 중복 제거를 우회해 곧바로 한 번 더 보낸다.
    const current = this.getAppState()
    if (current) this.mirror?.publishNow(current, pendingPermissions.list())
    return this.emit()
  }

  cancelPairing(): RemoteStatus {
    this.pairing?.cancel()
    return this.emit()
  }

  // ── 기기 ────────────────────────────────────────────────────────────────

  /**
   * 기기 하나를 끊는다. **릴레이가 먼저다** — 로컬 키를 먼저 지우면 revoke 요청을 보낼
   * 자격은 남아 있지만 순서가 뒤집혀, 릴레이 실패 시 "로컬엔 없는데 서버엔 살아 있는" 기기가 된다.
   */
  async revokeDevice(deviceId: string): Promise<RemoteStatus> {
    const client = this.client
    if (client && client.getState().status === 'online') {
      const { error } = await client
        .supabase()
        .from('devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', deviceId)
      if (error) {
        this.fault = `could not revoke on the relay: ${error.message}`
        return this.emit()
      }
    } else {
      // 오프라인에서도 로컬 키는 지운다. 서버 쪽은 다음 연결에서 정리한다 —
      // 그때까지 폰이 커맨드를 넣을 수 있지만, 우리가 키를 버렸으므로 아무것도 열리지 않는다.
      log.error('원격: 오프라인 상태에서 기기를 끊습니다 — 릴레이 revoke 는 보류됩니다.')
    }

    try {
      this.ensureKeystore().removeDevice(deviceId)
    } catch (err) {
      this.fault = errorText(err)
    }
    return this.emit()
  }

  /** 모든 원격 데이터를 지운다. 되돌릴 수 없고, 모든 폰이 재페어링해야 한다. */
  async clearData(): Promise<RemoteStatus> {
    const client = this.client
    const machineId = client?.getState().machineId
    if (client && machineId && client.getState().status === 'online') {
      // 머신 행을 지우면 devices·machine_state·commands 가 cascade 로 함께 사라진다.
      const { error } = await client.supabase().from('machines').delete().eq('id', machineId)
      if (error) log.error('원격 데이터 삭제(릴레이) 실패', error.message)
    }
    await this.setEnabled(false)
    try {
      this.ensureKeystore().clear()
      this.fault = null
    } catch (err) {
      this.fault = errorText(err)
    }
    return this.emit()
  }

  async dispose(): Promise<void> {
    this.commandBridge?.dispose()
    this.mirror?.dispose()
    this.pairing?.dispose()
    this.unsubscribe?.()
    await this.client?.dispose()
    this.client = null
    this.pairing = null
    this.mirror = null
    this.commandBridge = null
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private ensureKeystore(): RemoteKeystore {
    this.keystore ??= getRemoteKeystore()
    return this.keystore
  }

  private devices(): RemoteDeviceSummary[] {
    if (!this.keystore) return []
    try {
      return this.keystore.listDevices().map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        platform: d.platform,
        createdAt: d.createdAt
      }))
    } catch (err) {
      // 여기서 던지면 설정 화면 전체가 죽는다. 상태로 보고하고 목록은 비운다.
      if (err instanceof RemoteKeystoreError) this.fault = err.message
      return []
    }
  }

  private emit(): RemoteStatus {
    const status = this.status()
    try {
      this.onChange(status)
    } catch (err) {
      log.error('원격 상태 방송 실패', err)
    }
    return status
  }
}

// ── 싱글턴 ────────────────────────────────────────────────────────────────

let bridge: RemoteBridge | null = null

/** main 엔트리가 한 번 호출한다. `onChange` 는 `evt:remote` 방송으로 이어진다. */
export function initRemote(
  onChange: (status: RemoteStatus) => void,
  getAppState: () => AppState
): RemoteBridge {
  bridge ??= new RemoteBridge(onChange, resolveRemoteConfig(), getAppState)
  return bridge
}

/** 초기화 이후에만 유효하다. */
export function getRemoteBridge(): RemoteBridge {
  if (!bridge) throw new Error('remote bridge has not been initialised')
  return bridge
}

export async function disposeRemote(): Promise<void> {
  await bridge?.dispose()
  bridge = null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
