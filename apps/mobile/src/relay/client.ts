import { AppState, type AppStateStatus } from 'react-native'
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, openJson, sealJson } from '@shared/crypto'
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommandPayload,
  type RemoteCommandResult,
  type RemoteState
} from '@shared/remote'
import { nextCommandSequence, secureAuthStorage, type StoredPairing } from '../storage/secure'
import { decodePostgresBytea, encodePostgresBytea } from './bytea'
import type { ConnectionStatus } from '../state/store'

interface MachineStateRow {
  machine_id: string
  rev: number
  nonce: string
  state_ct: string
  updated_at: string
}

interface CommandResultRow {
  id: string
  status: string
  result_nonce: string | null
  result_ct: string | null
}

export type RemoteCommandChannel =
  | 'remote:transcript'
  | 'remote:watch'
  | 'remote:ping'
  | 'chat:send'
  | 'chat:interrupt'
  | 'permission:respond'

export class RemoteCommandTimeoutError extends Error {
  constructor() {
    super('The laptop has not responded yet. The command is still queued and may run later.')
    this.name = 'RemoteCommandTimeoutError'
  }
}

const COMMAND_TIMEOUT_MS = 20_000
const COMMAND_POLL_MS = 750
const COMMAND_CT_MAX_BYTES = 64 * 1024

/**
 * 랩탑 생존 확인 주기. 브로드캐스트에 얹을 수 없다 — 랩탑이 죽으면 브로드캐스트도 멈추므로,
 * 정확히 알아야 할 순간에 아무 신호도 오지 않는다. 그래서 별도 타이머로 직접 확인한다.
 */
const LIVENESS_POLL_MS = 30_000

export interface RelayClientHandlers {
  onStatus: (status: ConnectionStatus) => void
  /** 랩탑이 마지막으로 heartbeat 를 찍은 시각(ms). 행이 없으면 null. */
  onLaptopSeen: (seenAt: number | null) => void
  /** 랩탑이 이 기기를 끊었다. 저장된 페어링을 버려야 한다. */
  onRevoked: () => void
  onState: (state: RemoteState | null) => void
  onUpdatedAt: (updatedAt: number | null) => void
  onError: (message: string | null) => void
  onActivity: () => void
}

function isMachineStateRow(value: unknown): value is MachineStateRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.machine_id === 'string' &&
    typeof row.rev === 'number' &&
    typeof row.nonce === 'string' &&
    typeof row.state_ct === 'string' &&
    typeof row.updated_at === 'string'
  )
}

function isRemoteState(value: unknown): value is RemoteState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.rev === 'number' &&
    typeof state.machine === 'object' &&
    state.machine !== null &&
    Array.isArray(state.repos) &&
    Array.isArray(state.workspaces) &&
    Array.isArray(state.pendingPermissions)
  )
}

export class RelayClient {
  private readonly client: SupabaseClient
  private readonly keys: ReturnType<typeof deriveDirectionKeys>
  private channel: RealtimeChannel | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private appStateSubscription: { remove: () => void } | null = null
  private reconnectAttempt = 0
  private stopped = false
  private currentStatus: ConnectionStatus = 'offline'

  get status(): ConnectionStatus {
    return this.currentStatus
  }

  constructor(
    private readonly pairing: StoredPairing,
    private readonly handlers: RelayClientHandlers
  ) {
    this.client = createClient(pairing.url, pairing.anonKey, {
      auth: { storage: secureAuthStorage, persistSession: true, autoRefreshToken: true }
    })
    this.keys = deriveDirectionKeys(fromBase64Url(pairing.sessionKey), pairing.deviceId)
  }

  async connect(): Promise<void> {
    this.stopped = false
    this.setStatus('connecting')
    try {
      const existing = await this.client.auth.getSession()
      let token = existing.data.session?.access_token
      if (!token) {
        const signedIn = await this.client.auth.signInAnonymously()
        if (signedIn.error || !signedIn.data.session?.access_token) {
          throw new Error('Could not sign in to the relay')
        }
        token = signedIn.data.session.access_token
      }
      await this.client.realtime.setAuth(token)
      await this.refresh()
      await this.pollLiveness()
      this.startLiveness()
      this.subscribe()
      if (this.appStateSubscription === null) {
        this.appStateSubscription = AppState.addEventListener('change', this.handleAppState)
      }
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : 'Could not connect')
      this.scheduleReconnect()
    }
  }

  subscribe(): void {
    if (this.channel !== null || this.stopped) return
    const channel = this.client.channel(`machine:${this.pairing.machineId}`, {
      config: { private: true }
    })
    this.channel = channel
    channel
      .on('broadcast', { event: '*' }, () => {
        this.handlers.onActivity()
        void this.refresh().catch((error: unknown) => {
          this.handlers.onError(error instanceof Error ? error.message : 'Could not refresh state')
          this.scheduleReconnect()
        })
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.reconnectAttempt = 0
          this.handlers.onError(null)
          this.setStatus('online')
          return
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (!this.stopped && AppState.currentState === 'active') this.scheduleReconnect()
        }
      })
  }

  async refresh(): Promise<void> {
    const response = await this.client
      .from('machine_state')
      .select('machine_id, rev, nonce, state_ct, updated_at')
      .eq('machine_id', this.pairing.machineId)
      // 상태 행은 기기별로 봉인된다(0006). 이 필터가 없으면 기기가 둘 이상일 때
      // maybeSingle() 이 여러 행을 보고 실패하고, 남의 키로 봉인된 암호문을 잡을 수도 있다.
      .eq('device_id', this.pairing.deviceId)
      .maybeSingle()
    if (response.error) throw new Error('Could not load laptop state')
    if (response.data === null) {
      this.handlers.onState(null)
      this.handlers.onUpdatedAt(null)
      return
    }
    if (!isMachineStateRow(response.data) || response.data.machine_id !== this.pairing.machineId) {
      throw new Error('The relay returned an invalid laptop state')
    }
    const state = openJson(
      this.keys.laptopToPhone,
      {
        v: REMOTE_PROTOCOL_VERSION,
        machineId: this.pairing.machineId,
        deviceId: this.pairing.deviceId,
        kind: 'state'
      },
      {
        nonce: decodePostgresBytea(response.data.nonce),
        ct: decodePostgresBytea(response.data.state_ct)
      }
    )
    if (!isRemoteState(state) || state.rev !== response.data.rev) {
      throw new Error('The laptop state could not be verified')
    }
    this.handlers.onState(state)
    const updatedAt = Date.parse(response.data.updated_at)
    this.handlers.onUpdatedAt(Number.isFinite(updatedAt) ? updatedAt : null)
    this.handlers.onError(null)
  }

  async command(channel: RemoteCommandChannel, args: unknown[]): Promise<unknown> {
    const seq = await nextCommandSequence(this.pairing.deviceId)
    const payload: RemoteCommandPayload = { channel, args, seq, ts: Date.now() }
    const header = {
      v: REMOTE_PROTOCOL_VERSION,
      machineId: this.pairing.machineId,
      deviceId: this.pairing.deviceId,
      kind: 'command'
    } as const
    const box = sealJson(this.keys.phoneToLaptop, header, payload)
    if (box.ct.length > COMMAND_CT_MAX_BYTES) {
      throw new Error('This command is too large to send')
    }
    const inserted = await this.client
      .from('commands')
      .insert({
        machine_id: this.pairing.machineId,
        device_id: this.pairing.deviceId,
        nonce: encodePostgresBytea(box.nonce),
        payload_ct: encodePostgresBytea(box.ct)
      })
      .select('id, status, result_nonce, result_ct')
      .single()
    if (inserted.error || !isCommandResultRow(inserted.data)) {
      throw new Error('Could not queue the command. Check your relay connection and try again.')
    }
    return this.pollCommand(inserted.data.id)
  }

  /**
   * 푸시 토큰을 릴레이에 올린다. 매 실행마다 한 번 — Edge Function 이 죽은 토큰을 null 로
   * 지우기 때문에(DeviceNotRegistered) 재등록이 곧 자가 치유다.
   */
  async savePushToken(token: string | null): Promise<void> {
    const { error } = await this.client
      .from('devices')
      .update({ expo_push_token: token })
      .eq('id', this.pairing.deviceId)
    if (error) throw new Error('Could not register this phone for notifications')
  }

  disconnect(): void {
    this.stopped = true
    this.clearTimers()
    this.appStateSubscription?.remove()
    this.appStateSubscription = null
    void this.dropChannel()
    this.setStatus('offline')
  }

  private readonly handleAppState = (next: AppStateStatus): void => {
    if (next === 'active') {
      if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer)
      this.backgroundTimer = null
      if (this.channel === null) void this.connect()
      else {
        void this.refresh().catch(() => this.scheduleReconnect())
        void this.pollLiveness()
        this.startLiveness()
      }
      return
    }
    if (this.backgroundTimer === null) {
      this.backgroundTimer = setTimeout(() => {
        this.backgroundTimer = null
        void this.dropChannel()
        this.stopLiveness()
        this.setStatus('offline')
      }, 30_000)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.setStatus('offline')
    const cap = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    const delay = Math.random() * cap
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.dropChannel().then(() => this.connect())
    }, delay)
  }

  private async dropChannel(): Promise<void> {
    if (this.channel === null) return
    const channel = this.channel
    this.channel = null
    await this.client.removeChannel(channel)
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status
    this.handlers.onStatus(status)
  }

  private async pollCommand(id: string): Promise<unknown> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    while (Date.now() < deadline) {
      const response = await this.client
        .from('commands')
        .select('id, status, result_nonce, result_ct')
        .eq('id', id)
        .eq('device_id', this.pairing.deviceId)
        .maybeSingle()
      if (response.error) throw new Error('Could not check the command result')
      if (response.data !== null && isCommandResultRow(response.data)) {
        if (response.data.status !== 'pending') return this.openCommandResult(response.data)
      }
      await wait(COMMAND_POLL_MS)
    }
    throw new RemoteCommandTimeoutError()
  }

  private openCommandResult(row: CommandResultRow): unknown {
    if (row.result_nonce === null || row.result_ct === null) {
      throw new Error('The laptop rejected the command without a readable result')
    }
    const opened = openJson(
      this.keys.laptopToPhone,
      {
        v: REMOTE_PROTOCOL_VERSION,
        machineId: this.pairing.machineId,
        deviceId: this.pairing.deviceId,
        kind: 'result'
      },
      {
        nonce: decodePostgresBytea(row.result_nonce),
        ct: decodePostgresBytea(row.result_ct)
      }
    )
    if (!isRemoteCommandResult(opened)) throw new Error('The laptop returned an invalid result')
    if (!opened.ok) throw new Error(opened.error)
    return opened.value
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer)
    this.reconnectTimer = null
    this.backgroundTimer = null
    this.stopLiveness()
  }

  private startLiveness(): void {
    this.stopLiveness()
    this.livenessTimer = setInterval(() => {
      void this.pollLiveness()
    }, LIVENESS_POLL_MS)
  }

  private stopLiveness(): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  /**
   * 이 기기가 아직 끊기지 않았는지 확인한다.
   *
   * `devices_self_read` 정책이 `revoked_at is null` 을 요구하므로, 랩탑이 끊는 순간 폰은
   * **자기 행조차 보지 못한다**. 즉 "조회는 성공했는데 행이 없다" 가 곧 끊겼다는 뜻이다.
   *
   * 오류(네트워크·토큰)일 때는 아무것도 하지 않는다 — 잠깐 끊긴 것으로 페어링을 버리면
   * 지하철에 들어갔다 나올 때마다 다시 QR 을 찍어야 한다. **확정적인 답일 때만** 버린다.
   */
  private async checkStillPaired(): Promise<boolean> {
    const response = await this.client
      .from('devices')
      .select('id')
      .eq('id', this.pairing.deviceId)
      .maybeSingle()
    if (response.error) return true
    if (response.data !== null) return true
    this.handlers.onRevoked()
    return false
  }

  /** 실패해도 조용히 넘긴다 — 생존 표시가 없다고 화면이 죽을 이유는 없다. */
  private async pollLiveness(): Promise<void> {
    if (!(await this.checkStillPaired())) return
    const response = await this.client
      .from('machines')
      .select('last_seen_at')
      .eq('id', this.pairing.machineId)
      .maybeSingle()
    if (response.error || response.data === null) return
    const seenAt = Date.parse((response.data as { last_seen_at: string }).last_seen_at)
    this.handlers.onLaptopSeen(Number.isFinite(seenAt) ? seenAt : null)
  }
}

function isCommandResultRow(value: unknown): value is CommandResultRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.status === 'string' &&
    (typeof row.result_nonce === 'string' || row.result_nonce === null) &&
    (typeof row.result_ct === 'string' || row.result_ct === null)
  )
}

function isRemoteCommandResult(value: unknown): value is RemoteCommandResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return result.ok === true || (result.ok === false && typeof result.error === 'string')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
