import { AppState, type AppStateStatus } from 'react-native'
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient
} from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, openJson } from '@shared/crypto'
import { REMOTE_PROTOCOL_VERSION, type RemoteState } from '@shared/remote'
import { secureAuthStorage, type StoredPairing } from '../storage/secure'
import { decodePostgresBytea } from './bytea'
import type { ConnectionStatus } from '../state/store'

interface MachineStateRow {
  machine_id: string
  rev: number
  nonce: string
  state_ct: string
  updated_at: string
}

export interface RelayClientHandlers {
  onStatus: (status: ConnectionStatus) => void
  onState: (state: RemoteState | null) => void
  onUpdatedAt: (updatedAt: number | null) => void
  onError: (message: string | null) => void
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
      else void this.refresh().catch(() => this.scheduleReconnect())
      return
    }
    if (this.backgroundTimer === null) {
      this.backgroundTimer = setTimeout(() => {
        this.backgroundTimer = null
        void this.dropChannel()
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

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer)
    this.reconnectTimer = null
    this.backgroundTimer = null
  }
}
