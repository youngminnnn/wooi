import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { app, powerMonitor } from 'electron'
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
import type { AppState, NotificationEvent, PermissionRequest } from '@shared/types'
import { pendingPermissions } from './permissions'
import { RemotePush, type RemotePushRequest } from './push'

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
  private push: RemotePush | null = null
  private readonly getAppState: () => AppState | null
  private readonly onWorkspaceRead: (workspaceId: string) => void
  private unsubscribe: (() => void) | null = null
  private resumeListener: (() => void) | null = null
  private enabled = false
  private fault: string | null = null
  /**
   * 지금 미확인인 워크스페이스 id. **렌더러가 소유하고 여기로 올려 준다**(`remote:setUnread`) —
   * 미확인은 AppState 가 아니라 렌더러 zustand 메모리에 있어서 투영이 직접 볼 수 없다.
   *
   * 프로세스 메모리에만 두고 영속하지 않는다. 랩탑을 재시작하면 렌더러의 미확인도 함께
   * 사라지므로, 여기만 살아남으면 폰에 존재하지 않는 미확인이 남는다.
   */
  private unread: ReadonlySet<string> = new Set()
  /**
   * 이 기능이 열려 있는가. 원격 플래그(공지 파일)와 로컬 override 중 하나라도 참이면 열린다.
   * 기동 시점에는 마지막으로 알던 값에서 시작한다 — 네트워크를 기다리는 동안 UI 가 깜빡이지
   * 않게 하기 위해서다.
   */
  private available = false

  constructor(
    onChange: (status: RemoteStatus) => void,
    config = resolveRemoteConfig(),
    // 기본값이 null 을 돌려준다 — 테스트가 상태 없이 브리지만 만들 수 있어야 하고,
    // 그때는 초기 스냅샷을 건너뛰는 것이 맞다(가짜 빈 AppState 를 지어내면 폰이 그걸 본다).
    getAppState: () => AppState | null = () => null,
    /** 마지막으로 알던 가용성. 기동 직후 UI 가 깜빡이지 않게 여기서 시작한다. */
    initiallyAvailable = false,
    // 폰이 워크스페이스를 열면 데스크톱의 미확인 표시를 푼다. 기본값은 no-op —
    // 테스트가 이 배선까지 준비할 필요는 없다.
    onWorkspaceRead: (workspaceId: string) => void = () => {}
  ) {
    this.config = config
    this.onChange = onChange
    this.getAppState = getAppState
    this.available = initiallyAvailable
    this.onWorkspaceRead = onWorkspaceRead
  }

  /**
   * 기능 가용성을 갱신한다. 닫히는 방향이면 **이미 켜져 있던 연결도 끊는다** — 잠갔다고
   * 말해 놓고 계속 붙어 있으면 잠근 것이 아니다.
   */
  setAvailable(next: boolean): void {
    if (next === this.available) return
    this.available = next
    if (!next && this.enabled) void this.setEnabled(false)
    else this.emit()
  }

  /** 지금 상태 스냅샷. 렌더러가 언제든 물어볼 수 있다. */
  status(): RemoteStatus {
    return {
      available: this.available,
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

    // UI 를 숨기는 것만으로는 부족하다 — IPC 는 렌더러 밖에서도 부를 수 있다.
    if (next && !this.available) {
      this.enabled = false
      this.fault = 'remote access is not available yet'
      return this.emit()
    }

    if (!next) {
      this.commandBridge?.dispose()
      this.commandBridge = null
      this.push?.dispose()
      this.push = null
      this.mirror?.dispose()
      this.mirror = null
      this.pairing?.dispose()
      this.pairing = null
      await this.client?.dispose()
      this.client = null
      this.detachResume()
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
      // 랩탑이 깨어나면 곧바로 다시 붙는다. 그냥 두면 다음 heartbeat 까지 최대 1분 동안
      // 폰에는 여전히 자고 있는 것으로 보이고, 그 사이 보낸 커맨드는 이유 없이 대기한다.
      // 소켓도 수면 중에 죽어 있으므로 어차피 다시 세워야 한다.
      this.resumeListener = () => {
        void client.connect()
      }
      powerMonitor.on('resume', this.resumeListener)
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
        machineId,
        onWatch: (workspaceId) => {
          if (workspaceId !== null) this.onWorkspaceRead(workspaceId)
        },
        onUnpairSelf: async (deviceId) => {
          await this.revokeDevice(deviceId)
        }
      })
      this.push = new RemotePush({
        supabase: () => client.supabase(),
        keystore,
        machineId: () => client.getState().machineId,
        enabled: () =>
          this.enabled &&
          client.getState().status === 'online' &&
          this.getAppState()?.settings.remotePushEnabled === true,
        call: (request) => this.callPush(request)
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
      this.push?.dispose()
      this.push = null
      this.mirror?.dispose()
      this.mirror = null
      this.pairing?.dispose()
      this.pairing = null
      await this.client?.dispose()
      this.client = null
      this.detachResume()
      this.unsubscribe?.()
      this.unsubscribe = null
      log.error('원격 활성화 실패', this.fault)
    }
    return this.emit()
  }

  // ── 페어링 ──────────────────────────────────────────────────────────────

  publishState(appState: AppState, pendingPermissions: PermissionRequest[]): void {
    this.mirror?.publish(appState, pendingPermissions, this.unread)
  }

  /**
   * 렌더러의 미확인 목록을 갈아 끼우고 곧바로 다시 발행한다.
   *
   * 미확인은 AppState 와 무관하게 바뀐다(턴이 끝나거나 사용자가 워크스페이스를 열 때). 여기서
   * 발행하지 않으면 다음 AppState 방송이 올 때까지 폰의 점이 그대로 남는데, idle 인 랩탑에서는
   * 그게 몇 분일 수도 있다. 미러가 내용 동일 발행을 걸러 주므로 중복 호출은 공짜다.
   */
  setUnread(workspaceIds: readonly string[]): void {
    this.unread = new Set(workspaceIds)
    const appState = this.getAppState()
    if (appState) this.publishState(appState, pendingPermissions.list())
  }

  notifyPush(workspaceId: string, workspaceName: string, kind: NotificationEvent): void {
    void this.push?.notify({ workspaceId, workspaceName, kind })
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
    if (current) this.mirror?.publishNow(current, pendingPermissions.list(), this.unread)
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
    this.push?.dispose()
    this.mirror?.dispose()
    this.pairing?.dispose()
    this.detachResume()
    this.unsubscribe?.()
    await this.client?.dispose()
    this.client = null
    this.pairing = null
    this.mirror = null
    this.commandBridge = null
    this.push = null
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private detachResume(): void {
    if (this.resumeListener) powerMonitor.off('resume', this.resumeListener)
    this.resumeListener = null
  }

  private ensureKeystore(): RemoteKeystore {
    this.keystore ??= getRemoteKeystore()
    return this.keystore
  }

  private async callPush(request: RemotePushRequest): Promise<void> {
    const client = this.client
    if (!client || !this.config) throw new Error('remote client is not connected')
    const { data } = await client.supabase().auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('remote client has no session')

    const response = await fetch(`${this.config.url}/functions/v1/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.config.anonKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(request)
    })
    if (!response.ok) throw new Error(`push Edge Function returned ${response.status}`)
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

/**
 * 원격 플래그를 무시하고 이 설치본에서 기능을 여는 로컬 탈출구.
 *
 * 플래그가 열리기 전에도 만든 사람은 써야 한다 — 그런데 배포된 앱에는 터미널로 환경변수를
 * 넘길 방법이 마땅치 않다(`open` 은 환경을 전달하지 않는다). 그래서 파일 하나의 **존재**로
 * 판단한다:
 *
 *   touch "$HOME/Library/Application Support/Wooi/remote-access.enabled"
 *
 * 설정 파일에 두지 않는 이유는 스토어가 주기적으로 통째로 덮어쓰기 때문이다 — 앱이 켜져
 * 있는 동안 고치면 지워진다. 별도 파일은 그 경합이 없다. 내용은 보지 않는다.
 */
export function hasLocalRemoteOverride(): boolean {
  try {
    return existsSync(join(app.getPath('userData'), 'remote-access.enabled'))
  } catch {
    return false
  }
}

// ── 싱글턴 ────────────────────────────────────────────────────────────────

let bridge: RemoteBridge | null = null

/** main 엔트리가 한 번 호출한다. `onChange` 는 `evt:remote` 방송으로 이어진다. */
export function initRemote(
  onChange: (status: RemoteStatus) => void,
  getAppState: () => AppState,
  onWorkspaceRead: (workspaceId: string) => void,
  initiallyAvailable = false
): RemoteBridge {
  bridge ??= new RemoteBridge(
    onChange,
    resolveRemoteConfig(),
    getAppState,
    initiallyAvailable,
    onWorkspaceRead
  )
  return bridge
}

/** 초기화 이후에만 유효하다. */
export function getRemoteBridge(): RemoteBridge {
  if (!bridge) throw new Error('remote bridge has not been initialised')
  return bridge
}

export function notifyRemotePush(
  workspaceId: string,
  workspaceName: string,
  kind: NotificationEvent
): void {
  bridge?.notifyPush(workspaceId, workspaceName, kind)
}

export async function disposeRemote(): Promise<void> {
  await bridge?.dispose()
  bridge = null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
