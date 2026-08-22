import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, openJson, sealJson } from '@shared/crypto'
import {
  REMOTE_COMMAND_FAILED,
  REMOTE_IPC,
  REMOTE_TRUNCATED_MARK,
  type RemoteAttachment,
  type RemoteCommandPayload,
  type RemoteCommandResult,
  type RemoteTranscriptQuery
} from '@shared/remote'
import { IPC, type ChatItem } from '@shared/types'
import { invokeCommand } from '../commandRegistry'
import { appendFileDurable } from '../fsutil'
import { log } from '../logger'
import { getTranscripts } from '../transcripts'
import { validateRemoteCommand } from './allowlist'
import { fromPgBytea, toPgBytea } from './bytea'
import type { RemoteKeystore } from './keystore'
import { pendingPermissions } from './permissions'
import { RemoteUploads, resolveRemoteAttachments } from './uploads'

const FRESHNESS_MS = 5 * 60_000
export const REMOTE_WATCH_TTL_MS = 60_000
const RESULT_CT_MAX_BYTES = 256 * 1024
/** AEAD 태그(16B)와 `{"ok":true,"value":…}` 봉투를 빼고 남는 평문 예산. */
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
  /**
   * 폰이 워크스페이스를 열었다(또는 닫아서 null). watch 는 "지금 이 화면을 보고 있다"는
   * 뜻이므로, 데스크톱의 미확인 표시를 푸는 신호로 그대로 쓸 수 있다.
   */
  onWatch?: (workspaceId: string | null) => void
  /** 다른 기기를 끊을 수 없도록 기기 id 는 복호화한 페이로드가 아니라 명령 행에서만 가져온다. */
  onUnpairSelf?: (deviceId: string) => Promise<void>
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
  private readonly uploads: RemoteUploads

  constructor(options: RemoteCommandBridgeOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.uploads = new RemoteUploads(this.now)
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
    this.uploads.clear()
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

    const workspaceId = workspaceFrom(payload.channel, payload.args)
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
        pendingPermissionTool: (requestId) => pendingPermissions.toolFor(requestId)
      })
      accepted = true
      const value = await this.dispatch(payload.channel, args, row.device_id)
      await this.finish(row, keys.laptopToPhone, { ok: true, value }, 'done')
      this.audit(row.device_id, payload.channel, workspaceId, 'accepted', 'done')
    } catch (err) {
      log.error('원격 명령 처리 실패', payload.channel, errorText(err))
      await this.finish(row, keys.laptopToPhone, failure(REMOTE_COMMAND_FAILED), 'error')
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
      this.options.onWatch?.(workspaceId)
      return {
        watching: workspaceId,
        expiresAt: workspaceId === null ? null : this.now() + REMOTE_WATCH_TTL_MS
      }
    }
    if (channel === REMOTE_IPC.transcript) {
      return transcriptPage(args[0] as string, args[1] as RemoteTranscriptQuery)
    }
    if (channel === REMOTE_IPC.upload) {
      return this.uploads.chunk(
        deviceId,
        args[0] as string,
        args[1] as number,
        args[2] as number,
        args[3] as string
      )
    }
    if (channel === REMOTE_IPC.unpairSelf) {
      this.watches.delete(deviceId)
      this.uploads.forget(deviceId)
      await this.options.onUnpairSelf?.(deviceId)
      return { unpaired: true }
    }
    if (channel === IPC.chatSend && args.length === 3) {
      return await invokeCommand(channel, this.withAttachments(deviceId, args))
    }
    return await invokeCommand(channel, args)
  }

  /**
   * 첨부 명세를 실제 첨부로 바꾼다. 이미지는 모델에 인라인으로 실리고, 나머지는 디스크에
   * 떨어진 뒤 `@경로` 로 본문 끝에 붙는다(uploads.ts).
   *
   * 조각이 하나라도 비면 여기서 throw 해서 전송 자체를 실패시킨다 — 첨부가 조용히 빠진 채로
   * 프롬프트만 가면, 사용자는 보낸 줄 알고 엉뚱한 답을 받는다.
   */
  private withAttachments(deviceId: string, args: unknown[]): unknown[] {
    const workspaceId = args[0] as string
    const text = args[1] as string
    const { images, mentions } = resolveRemoteAttachments(
      this.uploads,
      deviceId,
      workspaceId,
      args[2] as RemoteAttachment[]
    )
    const prompt = [text.trim(), ...mentions].filter((part) => part.length > 0).join(' ')
    return [workspaceId, prompt, images.length > 0 ? images : undefined]
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

/**
 * 트랜스크립트 한 페이지.
 *
 * 예산을 아이템 수로 **균등 분배하지 않는다.** 예전에는 그랬는데, 폰이 100개를 달라고 하면
 * 아이템 하나에 2.5KiB 밖에 돌아가지 않아 조금만 긴 답변·도구 결과가 전부 표식 한 줄로
 * 바뀌었다 — 대화의 알맹이만 골라 지우는 셈이었다.
 *
 * 대신 최신 것부터 실제 크기만큼 담고 예산이 떨어지면 거기서 끊는다. 담긴 것은 **전부
 * 온전하고**, 못 담은 것은 폰이 `beforeTs` 로 다음 페이지를 당겨 가면 된다. 한 번에 오는
 * 아이템 수는 줄지만 내용이 살아 있는 쪽이 낫다(폰은 이미 위로 당겨 더 읽는다).
 */
export function transcriptPage(workspaceId: string, query: RemoteTranscriptQuery): unknown[] {
  const eligible = getTranscripts()
    .load(workspaceId)
    .filter((item) => query.beforeTs === undefined || item.ts < query.beforeTs)
  const page: ChatItem[] = []
  // 배열 구분자(쉼표)와 대괄호까지 감안해 조금 남긴다.
  let budget = RESULT_PLAINTEXT_BUDGET - 64
  for (let index = eligible.length - 1; index >= 0 && page.length < query.limit; index--) {
    const item = eligible[index]
    const size = jsonBytes(item) + 1
    if (size <= budget) {
      page.push(item)
      budget -= size
      continue
    }
    // 이미 담은 것이 있으면 이 아이템은 **온전한 채로 다음 페이지에 넘긴다.**
    if (page.length > 0) break
    // 아이템 하나가 봉투 하나보다 크다. 에이전트 출력은 512KiB 까지 남기므로(claude/clamp.ts)
    // 실제로 생긴다 — 이때만 자르고, 그래도 앞부분은 최대한 남긴다.
    page.push(truncateItem(item, budget - 1))
    break
  }
  return page.reverse()
}

/**
 * 아이템 하나를 `budget` 바이트 안에 들어가게 줄인다.
 *
 * 본문 **앞부분을 최대한 남기고** 끝에 표식을 붙인다. 통째로 표식으로 바꾸면 폰에서는 그
 * 메시지를 영영 못 보지만, 앞 200KiB 를 보내면 사실상 다 읽는다. 식별자와 타입별 필수
 * 필드는 그대로 둔다 — id/type/ts 만 남기면 폰의 ChatItem 검증을 통과하지 못해, 큰 메시지
 * 하나가 트랜스크립트 전체를 읽지 못하게 만든다.
 */
export function truncateItem(item: ChatItem, budget = 0): ChatItem {
  switch (item.type) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'error':
    case 'system':
    case 'tool_result':
      return fitBody(budget, item.text, (text) => ({ ...item, text }))
    case 'bash':
      return fitBody(budget, item.output, (output) => ({ ...item, output }))
    case 'tool_use':
      return fitInput(budget, item)
    default:
      // 나머지 타입은 본문이 크지 않다 — 그대로 둔다(잘라 봐야 얻을 것이 없다).
      return item
  }
}

/**
 * 예산에 들어가는 가장 긴 앞부분을 찾는다.
 *
 * 길이를 계산하지 않고 **실제로 직렬화해 재면서 이분 탐색한다.** JSON 이스케이프와 UTF-8
 * 때문에 문자 수와 바이트 수가 비례하지 않아서, 계산으로 맞추려 들면 어림값에 여유를
 * 두게 되고 그만큼 본문이 덜 간다.
 */
function fitBody<T extends ChatItem>(budget: number, body: string, build: (body: string) => T): T {
  // 그대로 들어가면 표식을 붙이지 않는다 — 안 잘렸는데 잘렸다고 말하지 않기 위해서다.
  if (jsonBytes(build(body)) <= budget) return build(body)
  let low = 0
  let high = body.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(build(head(body, mid) + REMOTE_TRUNCATED_MARK)) <= budget) low = mid
    else high = mid - 1
  }
  return build(low > 0 ? head(body, low) + REMOTE_TRUNCATED_MARK : REMOTE_TRUNCATED_MARK)
}

/** 서러게이트 쌍을 반으로 가르지 않는 앞부분. 가르면 폰에서 깨진 글자가 남는다. */
function head(text: string, length: number): string {
  const code = text.charCodeAt(length - 1)
  const splits = code >= 0xd800 && code <= 0xdbff
  return text.slice(0, splits ? length - 1 : length)
}

/**
 * tool_use 의 input 을 예산에 맞춘다. 문자열 리프의 앞부분만 남겨서 **어떤 도구를 어떤
 * 인자로 불렀는지는 보이게 한다** — 큰 파일을 쓰는 Write 한 번이 카드 전체를 지우지 않도록.
 */
function fitInput(budget: number, item: Extract<ChatItem, { type: 'tool_use' }>): ChatItem {
  let low = 0
  let high = longestLeaf(item.input)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes({ ...item, input: clampLeaves(item.input, mid) }) <= budget) low = mid
    else high = mid - 1
  }
  const clamped = { ...item, input: clampLeaves(item.input, low) }
  // 구조 자체가 예산보다 크면(리프를 다 지워도) 더 줄일 방법이 없다 — 그때만 통째로 버린다.
  return jsonBytes(clamped) <= budget ? clamped : { ...item, input: { truncated: true } }
}

function longestLeaf(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length
  if (depth > 6 || value === null || typeof value !== 'object') return 0
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (longest, child) => Math.max(longest, longestLeaf(child, depth + 1)),
    0
  )
}

function clampLeaves(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= max ? value : head(value, max) + REMOTE_TRUNCATED_MARK
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((child) => clampLeaves(child, max, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clampLeaves(child, max, depth + 1)
  }
  return out
}

function resultHeader(machineId: string, deviceId: string) {
  return { v: 1, machineId, deviceId, kind: 'result' } as const
}

function failure(error: string): RemoteCommandResult {
  return { ok: false, error }
}

/**
 * 감사 로그에 적을 워크스페이스 id.
 *
 * `permission:respond` 의 첫 인자는 workspaceId 가 아니라 requestId 다 — 그대로 적으면
 * "이 폰이 어느 워크스페이스를 건드렸나"를 답하려는 로그가 거짓을 적게 된다.
 */
function workspaceFrom(channel: string, args: unknown[]): string | null {
  if (channel === IPC.permissionRespond) return null
  // 업로드의 첫 인자는 uploadId 다 — 워크스페이스로 읽으면 감사 로그가 거짓말을 한다.
  if (channel === REMOTE_IPC.upload) return null
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
