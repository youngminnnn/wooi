import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, openJson, sealJson } from '@shared/crypto'
import {
  REMOTE_IPC,
  REMOTE_MAX_EVENT_BYTES,
  type RemoteCommandPayload,
  type RemoteCommandResult,
  type RemoteTranscriptQuery
} from '@shared/remote'
import { invokeCommand } from '../commandRegistry'
import { appendFileDurable } from '../fsutil'
import { log } from '../logger'
import { getTranscripts } from '../transcripts'
import { validateRemoteCommand } from './allowlist'
import { fromPgBytea, toPgBytea } from './bytea'
import type { RemoteKeystore } from './keystore'

const FRESHNESS_MS = 5 * 60_000
export const REMOTE_WATCH_TTL_MS = 60_000
const RESULT_CT_MAX_BYTES = 256 * 1024
const RESULT_PLAINTEXT_BUDGET = RESULT_CT_MAX_BYTES - 1024

interface CommandRow {
  id: string
  machine_id: string
  device_id: string
  nonce: unknown
  payload_ct: unknown
  created_at: string
}

export interface RemoteCommandBridgeOptions {
  supabase: () => SupabaseClient
  keystore: RemoteKeystore
  machineId: string
  now?: () => number
}

interface WatchLease {
  workspaceId: string
  expiresAt: number
}

export class RemoteCommandBridge {
  private readonly options: RemoteCommandBridgeOptions
  private readonly now: () => number
  private readonly auditPath: string
  private channel: RealtimeChannel | null = null
  private disposed = false
  private draining: Promise<void> | null = null
  private rerun = false
  private readonly watches = new Map<string, WatchLease>()

  constructor(options: RemoteCommandBridgeOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    const logDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    this.auditPath = join(logDir, 'remote.log')
    this.subscribe()
  }

  isWatching(workspaceId: string): boolean {
    const now = this.now()
    for (const [deviceId, lease] of this.watches) {
      if (lease.expiresAt <= now) this.watches.delete(deviceId)
    }
    return [...this.watches.values()].some((lease) => lease.workspaceId === workspaceId)
  }

  dispose(): void {
    this.disposed = true
    this.watches.clear()
    const channel = this.channel
    this.channel = null
    if (channel) void this.options.supabase().removeChannel(channel)
  }

  private subscribe(): void {
    const channel = this.options
      .supabase()
      .channel(`machine:${this.options.machineId}`, { config: { private: true } })
      .on('broadcast', { event: 'command' }, () => this.wake())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.wake()
      })
    this.channel = channel
  }

  private wake(): void {
    if (this.disposed) return
    if (this.draining) {
      this.rerun = true
      return
    }
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.rerun) {
        this.rerun = false
        this.wake()
      }
    })
  }

  private async drain(): Promise<void> {
    try {
      do {
        const { data, error } = await this.options
          .supabase()
          .from('commands')
          .select('id,machine_id,device_id,nonce,payload_ct,created_at')
          .eq('machine_id', this.options.machineId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
        if (error) throw error
        const rows = (data ?? []) as CommandRow[]
        for (const row of rows) {
          if (this.disposed) return
          await this.process(row)
        }
        if (rows.length === 0) return
      } while (!this.disposed)
    } catch (err) {
      log.error('원격 명령 조회 실패', errorText(err))
    }
  }

  private async process(row: CommandRow): Promise<void> {
    const device = this.options.keystore.getDevice(row.device_id)
    if (!device) {
      await this.finishWithoutKey(row, 'This device is not paired.', 'unknown', 'rejected')
      return
    }

    const keys = deriveDirectionKeys(fromBase64Url(device.sessionKey), device.deviceId)
    let payload: RemoteCommandPayload
    try {
      const opened = openJson(
        keys.phoneToLaptop,
        {
          v: 1,
          machineId: this.options.machineId,
          deviceId: device.deviceId,
          kind: 'command'
        },
        { nonce: fromPgBytea(row.nonce), ct: fromPgBytea(row.payload_ct) }
      )
      payload = parsePayload(opened)
    } catch (err) {
      log.error('원격 명령 복호화 실패', row.id, errorText(err))
      await this.finish(
        row,
        keys.laptopToPhone,
        failure('The command could not be verified.'),
        'error'
      )
      this.audit(row.device_id, 'unknown', null, 'rejected', 'error')
      return
    }

    const workspaceId = workspaceFrom(payload.args)
    if (Math.abs(this.now() - payload.ts) > FRESHNESS_MS) {
      await this.reject(
        row,
        keys.laptopToPhone,
        payload.channel,
        workspaceId,
        'The command has expired.'
      )
      return
    }

    if (!(await this.advanceSequence(row.device_id, payload.seq))) {
      await this.reject(
        row,
        keys.laptopToPhone,
        payload.channel,
        workspaceId,
        'The command was already processed.'
      )
      return
    }

    let accepted = false
    try {
      const args = validateRemoteCommand(payload.channel, payload.args, {
        // M5에서 중앙 권한 요청 레지스트리를 연결한다. 지금은 모르는 입력 변경을 거절하는 쪽이 안전하다.
        pendingPermissionTool: () => undefined
      })
      accepted = true
      const value = await this.dispatch(payload.channel, args, row.device_id)
      await this.finish(row, keys.laptopToPhone, { ok: true, value }, 'done')
      this.audit(row.device_id, payload.channel, workspaceId, 'accepted', 'done')
    } catch (err) {
      log.error('원격 명령 처리 실패', payload.channel, errorText(err))
      await this.finish(
        row,
        keys.laptopToPhone,
        failure('The command could not be completed.'),
        'error'
      )
      this.audit(
        row.device_id,
        payload.channel,
        workspaceId,
        accepted ? 'accepted' : 'rejected',
        'error'
      )
    }
  }

  private async advanceSequence(deviceId: string, seq: number): Promise<boolean> {
    const { data, error } = await this.options
      .supabase()
      .from('devices')
      .update({ last_seq: seq })
      .eq('id', deviceId)
      .eq('machine_id', this.options.machineId)
      .lt('last_seq', seq)
      .select('id')
    if (error) throw error
    return (data ?? []).length === 1
  }

  private async dispatch(channel: string, args: unknown[], deviceId: string): Promise<unknown> {
    if (channel === REMOTE_IPC.ping) return { ok: true, at: this.now() }
    if (channel === REMOTE_IPC.watch) {
      const workspaceId = args[0] as string | null
      if (workspaceId === null) this.watches.delete(deviceId)
      else this.watches.set(deviceId, { workspaceId, expiresAt: this.now() + REMOTE_WATCH_TTL_MS })
      return {
        watching: workspaceId,
        expiresAt: workspaceId === null ? null : this.now() + REMOTE_WATCH_TTL_MS
      }
    }
    if (channel === REMOTE_IPC.transcript) {
      return transcriptPage(args[0] as string, args[1] as RemoteTranscriptQuery)
    }
    return await invokeCommand(channel, args)
  }

  private async reject(
    row: CommandRow,
    key: Uint8Array,
    channel: string,
    workspaceId: string | null,
    message: string
  ): Promise<void> {
    await this.finish(row, key, failure(message), 'error')
    this.audit(row.device_id, channel, workspaceId, 'rejected', 'error')
  }

  private async finish(
    row: CommandRow,
    key: Uint8Array,
    result: RemoteCommandResult,
    status: 'done' | 'error'
  ): Promise<void> {
    let box = sealJson(key, resultHeader(this.options.machineId, row.device_id), result)
    if (box.ct.length > RESULT_CT_MAX_BYTES) {
      box = sealJson(
        key,
        resultHeader(this.options.machineId, row.device_id),
        failure('The result was too large to return.')
      )
      status = 'error'
    }
    const { error } = await this.options
      .supabase()
      .from('commands')
      .update({
        result_nonce: toPgBytea(box.nonce),
        result_ct: toPgBytea(box.ct),
        status,
        completed_at: new Date(this.now()).toISOString()
      })
      .eq('id', row.id)
      .eq('machine_id', this.options.machineId)
      .eq('status', 'pending')
    if (error) throw error
  }

  private async finishWithoutKey(
    row: CommandRow,
    _message: string,
    channel: string,
    decision: 'rejected'
  ): Promise<void> {
    const { error } = await this.options
      .supabase()
      .from('commands')
      .update({ status: 'error', completed_at: new Date(this.now()).toISOString() })
      .eq('id', row.id)
      .eq('machine_id', this.options.machineId)
      .eq('status', 'pending')
    if (error) log.error('알 수 없는 원격 기기 명령 종료 실패', row.id, error.message)
    this.audit(row.device_id, channel, null, decision, 'error')
  }

  private audit(
    deviceId: string,
    channel: string,
    workspaceId: string | null,
    decision: 'accepted' | 'rejected',
    outcome: 'done' | 'error'
  ): void {
    const workspace = workspaceId ?? '-'
    try {
      appendFileDurable(
        this.auditPath,
        `${new Date(this.now()).toISOString()} device=${auditField(deviceId)} channel=${auditField(channel)} workspace=${auditField(workspace)} ${decision} outcome=${outcome}\n`
      )
    } catch (err) {
      log.error('원격 감사 로그 기록 실패', errorText(err))
    }
  }
}

function parsePayload(value: unknown): RemoteCommandPayload {
  if (!isRecord(value)) throw new Error('invalid command payload')
  if (typeof value.channel !== 'string' || !Array.isArray(value.args))
    throw new Error('invalid command payload')
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0)
    throw new Error('invalid command payload')
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts))
    throw new Error('invalid command payload')
  return { channel: value.channel, args: value.args, seq: value.seq, ts: value.ts }
}

function transcriptPage(workspaceId: string, query: RemoteTranscriptQuery): unknown[] {
  const eligible = getTranscripts()
    .load(workspaceId)
    .filter((item) => query.beforeTs === undefined || item.ts < query.beforeTs)
  const page = eligible.slice(-query.limit)
  const perItemBudget = Math.max(
    256,
    Math.floor(RESULT_PLAINTEXT_BUDGET / Math.max(1, page.length))
  )
  return page.map((item) => {
    if (jsonBytes(item) <= Math.min(REMOTE_MAX_EVENT_BYTES, perItemBudget)) return item
    return { id: item.id, type: item.type, ts: item.ts }
  })
}

function resultHeader(machineId: string, deviceId: string) {
  return { v: 1, machineId, deviceId, kind: 'result' } as const
}

function failure(error: string): RemoteCommandResult {
  return { ok: false, error }
}

function workspaceFrom(args: unknown[]): string | null {
  return typeof args[0] === 'string' ? args[0] : null
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function auditField(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, '_').slice(0, 160)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
