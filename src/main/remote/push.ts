import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, sealJson, toBase64Url } from '@shared/crypto'
import type { NotificationEvent } from '@shared/types'
import { log } from '../logger'
import type { RemoteKeystore } from './keystore'

export type RemotePushKind = NotificationEvent
type PushKind = RemotePushKind | 'summary'

export const REMOTE_PUSH_BODIES: Readonly<Record<PushKind, string>> = {
  needsInput: 'A workspace needs your permission',
  completed: 'A workspace finished',
  error: 'A workspace encountered an error',
  summary: 'Several workspaces need your attention'
}

export const REMOTE_PUSH_BURST_MS = 10_000

export interface RemotePushNotification {
  workspaceId: string
  workspaceName: string
  kind: RemotePushKind
}

interface PushDeviceRow {
  id: string
  expo_push_token: string | null
}

interface PushMessage {
  deviceId: string
  n: string
  p: string
}

export interface RemotePushRequest {
  machineId: string
  kind: PushKind
  dedupeKey: string
  body: string
  messages: PushMessage[]
}

export interface RemotePushOptions {
  supabase: () => SupabaseClient
  keystore: RemoteKeystore
  machineId: () => string | null
  enabled: () => boolean
  call: (request: RemotePushRequest) => Promise<void>
  now?: () => number
  burstMs?: number
}

interface PendingPush extends RemotePushNotification {
  resolve: () => void
}

export class RemotePush {
  private readonly now: () => number
  private readonly burstMs: number
  private pending: PendingPush[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly sent = new Set<string>()

  constructor(private readonly options: RemotePushOptions) {
    this.now = options.now ?? Date.now
    this.burstMs = options.burstMs ?? REMOTE_PUSH_BURST_MS
  }

  notify(notification: RemotePushNotification): Promise<void> {
    if (!this.options.enabled() || !this.options.machineId()) return Promise.resolve()

    return new Promise((resolve) => {
      this.pending.push({ ...notification, resolve })
      if (new Set(this.pending.map((item) => item.workspaceId)).size >= 3) {
        this.clearTimer()
        void this.flush(true)
        return
      }
      if (this.burstMs <= 0) {
        void this.flush(false)
        return
      }
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush(false)
        }, this.burstMs)
        this.timer.unref?.()
      }
    })
  }

  dispose(): void {
    this.clearTimer()
    const pending = this.pending
    this.pending = []
    for (const item of pending) item.resolve()
  }

  private async flush(summary: boolean): Promise<void> {
    const pending = this.pending
    this.pending = []
    if (pending.length === 0) return

    try {
      if (summary || new Set(pending.map((item) => item.workspaceId)).size >= 3) {
        await this.send(pending[pending.length - 1], 'summary')
      } else {
        for (const item of pending) await this.send(item, item.kind)
      }
    } catch (err) {
      // 알림 전송은 데스크톱 작업의 부가 기능이라 실패가 세션 이벤트 경로를 깨면 안 된다.
      log.error('원격 푸시 전송 실패', errorText(err))
    } finally {
      for (const item of pending) item.resolve()
    }
  }

  private async send(notification: RemotePushNotification, kind: PushKind): Promise<void> {
    if (!this.options.enabled()) return
    const machineId = this.options.machineId()
    if (!machineId) return

    const dedupeKey =
      kind === 'summary'
        ? `summary:${Math.floor(this.now() / 60_000)}`
        : `${notification.workspaceId}:${kind}:${Math.floor(this.now() / 60_000)}`
    if (this.sent.has(dedupeKey)) return

    const { data, error } = await this.options
      .supabase()
      .from('devices')
      .select('id,expo_push_token')
      .eq('machine_id', machineId)
      .is('revoked_at', null)
      .not('expo_push_token', 'is', null)
    if (error) throw error

    const rows = (data ?? []) as PushDeviceRow[]
    const tokenDeviceIds = new Set(
      rows.filter((row) => row.expo_push_token !== null).map((row) => row.id)
    )
    if (tokenDeviceIds.size === 0) return

    const messages = this.options.keystore
      .listDevices()
      .filter((device) => tokenDeviceIds.has(device.deviceId))
      .map((device) => {
        const header = { v: 1, machineId, deviceId: device.deviceId, kind: 'push' } as const
        const { laptopToPhone } = deriveDirectionKeys(
          fromBase64Url(device.sessionKey),
          device.deviceId
        )
        const box = sealJson(laptopToPhone, header, {
          workspaceId: notification.workspaceId,
          workspaceName: notification.workspaceName
        })
        return {
          deviceId: device.deviceId,
          n: toBase64Url(box.nonce),
          p: toBase64Url(box.ct)
        }
      })
    if (messages.length === 0) return

    this.sent.add(dedupeKey)
    try {
      await this.options.call({
        machineId,
        kind,
        dedupeKey,
        body: REMOTE_PUSH_BODIES[kind],
        messages
      })
    } catch (err) {
      this.sent.delete(dedupeKey)
      throw err
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
