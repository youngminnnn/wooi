import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { IPC } from '@shared/types'
import type { RemoteCommandPayload, RemoteCommandResult } from '@shared/remote'
import type { RemoteKeystore } from './keystore'

let userData = ''
const invokeCommand = vi.fn<(channel: string, args: readonly unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../commandRegistry', () => ({ invokeCommand }))
const transcripts = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('../transcripts', () => ({ getTranscripts: () => ({ load: () => transcripts.items }) }))

const { deriveDirectionKeys, generateSessionKey, openJson, sealJson, toBase64Url } =
  await import('@shared/crypto')
const { REMOTE_IPC } = await import('@shared/remote')
const { RemoteCommandBridge, REMOTE_WATCH_TTL_MS, transcriptPage, truncateItem } =
  await import('./bridge')
const { fromPgBytea, toPgBytea } = await import('./bytea')

const machineId = 'machine-1'
const deviceId = 'device-1'
let sessionKey: Uint8Array
let now: number
let relay: FakeSupabase
let bridge: InstanceType<typeof RemoteCommandBridge>

interface StoredCommand {
  id: string
  machine_id: string
  device_id: string
  nonce: string
  payload_ct: string
  status: string
  result_nonce: string | null
  result_ct: string | null
  created_at: string
  completed_at: string | null
}

type Filter = { op: 'eq' | 'lt'; column: string; value: unknown }

class Query implements PromiseLike<{ data: unknown[] | null; error: null }> {
  private filters: Filter[] = []
  private updateValue: Record<string, unknown> | null = null
  private operation: 'select' | 'update' = 'select'

  constructor(
    private readonly relay: FakeSupabase,
    private readonly table: string
  ) {}

  select(_columns?: string): this {
    if (!this.updateValue) this.operation = 'select'
    return this
  }

  update(value: Record<string, unknown>): this {
    this.operation = 'update'
    this.updateValue = value
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ op: 'eq', column, value })
    return this
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ op: 'lt', column, value })
    return this
  }

  order(_column: string, _options: { ascending: boolean }): this {
    return this
  }

  then<TResult1 = { data: unknown[] | null; error: null }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown[] | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private execute(): { data: unknown[]; error: null } {
    if (this.table === 'commands') {
      const rows = this.relay.commands.filter((row) => this.matches(row))
      if (this.operation === 'update' && this.updateValue) {
        for (const row of rows) Object.assign(row, this.updateValue)
      }
      return { data: rows, error: null }
    }
    const devices = [...this.relay.lastSeq.entries()].map(([id, last_seq]) => ({
      id,
      machine_id: machineId,
      last_seq
    }))
    const rows = devices.filter((row) => this.matches(row))
    if (this.operation === 'update' && this.updateValue) {
      for (const row of rows) this.relay.lastSeq.set(row.id, this.updateValue.last_seq as number)
    }
    return { data: rows, error: null }
  }

  private matches(row: object): boolean {
    const values = row as Record<string, unknown>
    return this.filters.every(({ op, column, value }) =>
      op === 'eq' ? values[column] === value : Number(values[column]) < Number(value)
    )
  }
}

class FakeSupabase {
  commands: StoredCommand[] = []
  lastSeq = new Map([[deviceId, 0]])
  private wake: (() => void) | null = null

  from(table: string): Query {
    return new Query(this, table)
  }

  channel(): {
    on: (
      _type: string,
      _filter: object,
      callback: () => void
    ) => ReturnType<FakeSupabase['channel']>
    subscribe: (callback: (status: string) => void) => ReturnType<FakeSupabase['channel']>
  } {
    const channel = {
      on: (_type: string, _filter: object, callback: () => void) => {
        this.wake = callback
        return channel
      },
      subscribe: (callback: (status: string) => void) => {
        queueMicrotask(() => callback('SUBSCRIBED'))
        return channel
      }
    }
    return channel
  }

  removeChannel(): Promise<'ok'> {
    this.wake = null
    return Promise.resolve('ok')
  }

  ping(): void {
    this.wake?.()
  }
}

function keystore(devices = [deviceId]): RemoteKeystore {
  return {
    getDevice: (id: string) =>
      devices.includes(id)
        ? {
            deviceId: id,
            name: 'Pixel',
            platform: 'android',
            sessionKey: toBase64Url(sessionKey),
            createdAt: 1
          }
        : undefined
  } as RemoteKeystore
}

function addCommand(
  payload: RemoteCommandPayload,
  options: { id?: string; deviceId?: string } = {}
): StoredCommand {
  const targetDevice = options.deviceId ?? deviceId
  const { phoneToLaptop } = deriveDirectionKeys(sessionKey, targetDevice)
  const box = sealJson(
    phoneToLaptop,
    { v: 1, machineId, deviceId: targetDevice, kind: 'command' },
    payload
  )
  const row: StoredCommand = {
    id: options.id ?? `command-${relay.commands.length + 1}`,
    machine_id: machineId,
    device_id: targetDevice,
    nonce: toPgBytea(box.nonce),
    payload_ct: toPgBytea(box.ct),
    status: 'pending',
    result_nonce: null,
    result_ct: null,
    created_at: new Date(now + relay.commands.length).toISOString(),
    completed_at: null
  }
  relay.commands.push(row)
  return row
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

function openResult(row: StoredCommand): RemoteCommandResult {
  expect(row.result_nonce).toMatch(/^\\x/)
  expect(row.result_ct).toMatch(/^\\x/)
  const { laptopToPhone } = deriveDirectionKeys(sessionKey, row.device_id)
  return openJson(
    laptopToPhone,
    { v: 1, machineId, deviceId: row.device_id, kind: 'result' },
    { nonce: fromPgBytea(row.result_nonce), ct: fromPgBytea(row.result_ct) }
  ) as RemoteCommandResult
}

function start(store = keystore(), onUnpairSelf?: (deviceId: string) => Promise<void>): void {
  bridge = new RemoteCommandBridge({
    supabase: () => relay as unknown as SupabaseClient,
    keystore: store,
    machineId,
    now: () => now,
    onUnpairSelf
  })
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-command-bridge-'))
  sessionKey = generateSessionKey()
  now = 1_800_000_000_000
  relay = new FakeSupabase()
  invokeCommand.mockReset()
  invokeCommand.mockResolvedValue({ sent: true })
})

afterEach(() => {
  bridge?.dispose()
  rmSync(userData, { recursive: true, force: true })
})

describe('RemoteCommandBridge', () => {
  it('hex wire 명령을 열고 검증·실행한 뒤 폰 방향 키로 결과를 봉인한다', async () => {
    const row = addCommand({ channel: IPC.chatSend, args: ['ws-1', 'hello'], seq: 1, ts: now })
    start()
    await settle()

    expect(invokeCommand).toHaveBeenCalledWith(IPC.chatSend, ['ws-1', 'hello'])
    expect(row.status).toBe('done')
    expect(openResult(row)).toEqual({ ok: true, value: { sent: true } })
  })

  it('같은 seq를 다시 실행하지 않는다', async () => {
    addCommand({ channel: IPC.chatSend, args: ['ws-1', 'first'], seq: 1, ts: now })
    const replay = addCommand({ channel: IPC.chatSend, args: ['ws-1', 'again'], seq: 1, ts: now })
    start()
    await settle()

    expect(invokeCommand).toHaveBeenCalledTimes(1)
    expect(openResult(replay)).toEqual({ ok: false, error: 'The command was already processed.' })
  })

  it('10분 지난 명령을 거절한다', async () => {
    const row = addCommand({
      channel: IPC.chatSend,
      args: ['ws-1', 'old'],
      seq: 1,
      ts: now - 600_000
    })
    start()
    await settle()
    expect(invokeCommand).not.toHaveBeenCalled()
    expect(openResult(row).ok).toBe(false)
  })

  it('allowlist에 없는 채널을 거절한다', async () => {
    const row = addCommand({ channel: IPC.repoRemove, args: ['repo-1'], seq: 1, ts: now })
    start()
    await settle()
    expect(invokeCommand).not.toHaveBeenCalled()
    expect(row.status).toBe('error')
  })

  it('알 수 없는 기기는 오류로 끝내고 계속 동작한다', async () => {
    const row = addCommand(
      { channel: REMOTE_IPC.ping, args: [], seq: 1, ts: now },
      { deviceId: 'unknown' }
    )
    start(keystore([]))
    await settle()
    expect(row.status).toBe('error')
    expect(row.result_ct).toBeNull()
  })

  it('손상된 암호문은 오류 결과로 끝낸다', async () => {
    const row = addCommand({ channel: REMOTE_IPC.ping, args: [], seq: 1, ts: now })
    // 마지막 바이트를 **뒤집는다**. `00` 으로 덮어쓰면 원래 값이 0x00 일 때 암호문이 그대로라
    // Poly1305 가 통과하고 상태가 done 으로 끝난다 — 256번에 한 번 깨지는 테스트가 된다.
    const flipped = Number.parseInt(row.payload_ct.slice(-2), 16) ^ 0xff
    row.payload_ct = `${row.payload_ct.slice(0, -2)}${flipped.toString(16).padStart(2, '0')}`
    start()
    await settle()
    expect(row.status).toBe('error')
    expect(openResult(row).ok).toBe(false)
  })

  it('ping과 watch가 왕복하고 watch lease가 60초 뒤 만료된다', async () => {
    const ping = addCommand({ channel: REMOTE_IPC.ping, args: [], seq: 1, ts: now })
    const watch = addCommand({ channel: REMOTE_IPC.watch, args: ['ws-1'], seq: 2, ts: now })
    start()
    await settle()
    expect(openResult(ping)).toEqual({ ok: true, value: { ok: true, at: now } })
    expect(openResult(watch).ok).toBe(true)
    expect(bridge.isWatching('ws-1')).toBe(true)
    now += REMOTE_WATCH_TTL_MS + 1
    expect(bridge.isWatching('ws-1')).toBe(false)
  })

  it('자기 해제는 명령 행의 기기를 끊고 watch를 지운 뒤 IPC로 내려가지 않는다', async () => {
    addCommand({ channel: REMOTE_IPC.watch, args: ['ws-1'], seq: 1, ts: now })
    const unpair = addCommand({ channel: REMOTE_IPC.unpairSelf, args: [], seq: 2, ts: now })
    const onUnpairSelf = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
    start(keystore(), onUnpairSelf)
    await settle()

    expect(onUnpairSelf).toHaveBeenCalledOnce()
    expect(onUnpairSelf).toHaveBeenCalledWith(unpair.device_id)
    expect(bridge.isWatching('ws-1')).toBe(false)
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('행을 순서대로 하나씩 실행한다', async () => {
    addCommand({ channel: IPC.chatSend, args: ['ws-1', 'first'], seq: 1, ts: now })
    addCommand({ channel: IPC.chatSend, args: ['ws-1', 'second'], seq: 2, ts: now })
    let release: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    invokeCommand.mockImplementationOnce(async () => {
      await first
      return 'first-done'
    })
    start()
    await settle()
    expect(invokeCommand).toHaveBeenCalledTimes(1)
    release?.()
    await settle()
    expect(invokeCommand.mock.calls.map((call) => call[1][1])).toEqual(['first', 'second'])
  })
})

describe('트랜스크립트 페이지', () => {
  const item = (id: string, ts: number, text: string): unknown => ({
    id,
    type: 'assistant',
    text,
    ts
  })

  afterEach(() => {
    transcripts.items = []
  })

  it('긴 메시지가 섞여도 담긴 것은 온전하다', () => {
    // 예전에는 예산을 아이템 수로 균등 분배해서, 100개를 달라고 하면 하나에 2.5KiB 밖에
    // 돌아가지 않았다 — 조금만 긴 답변이 전부 표식 한 줄이 됐다.
    const long = 'ㄱ'.repeat(20_000)
    transcripts.items = [item('a', 1, 'short'), item('b', 2, long), item('c', 3, 'short')]
    const page = transcriptPage('ws-1', { limit: 100 }) as { id: string; text: string }[]
    expect(page.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(page[1].text).toBe(long)
  })

  it('예산이 떨어지면 개수를 줄이고 최신 것부터 온전히 보낸다', () => {
    // 담을 수 없는 것은 자르지 않고 다음 페이지로 미룬다 — 폰이 beforeTs 로 당겨 간다.
    const big = 'x'.repeat(120_000)
    transcripts.items = [item('a', 1, big), item('b', 2, big), item('c', 3, big)]
    const page = transcriptPage('ws-1', { limit: 100 }) as { id: string; text: string }[]
    expect(page.map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(page.every((entry) => entry.text === big)).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(256 * 1024)
  })

  it('아이템 하나가 봉투보다 크면 앞부분을 남겨서 보낸다', () => {
    const huge = 'y'.repeat(400_000)
    transcripts.items = [item('a', 1, huge)]
    const page = transcriptPage('ws-1', { limit: 100 }) as { id: string; text: string }[]
    expect(page).toHaveLength(1)
    // 통째로 표식이 되면 폰에서는 그 메시지를 영영 못 본다 — 앞부분이 살아 있어야 한다.
    expect(page[0].text.startsWith('yyyy')).toBe(true)
    expect(page[0].text.length).toBeGreaterThan(200_000)
    expect(page[0].text).toContain('truncated')
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(256 * 1024)
  })

  it('beforeTs 보다 오래된 것만 돌려준다', () => {
    transcripts.items = [item('a', 1, 'one'), item('b', 2, 'two'), item('c', 3, 'three')]
    const page = transcriptPage('ws-1', { beforeTs: 3, limit: 100 }) as { id: string }[]
    expect(page.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('더 오래된 것이 없으면 빈 페이지다', () => {
    transcripts.items = [item('a', 5, 'one')]
    expect(transcriptPage('ws-1', { beforeTs: 5, limit: 100 })).toEqual([])
  })
})

describe('트랜스크립트 잘림', () => {
  const huge = 'x'.repeat(300_000)

  it('큰 아이템의 본문만 바꾸고 타입 필수 필드는 남긴다', () => {
    // id/type/ts 만 남기면 폰의 ChatItem 검증을 통과하지 못해, 큰 메시지 하나가
    // 트랜스크립트 전체를 못 읽게 만든다 — 실기기에서 실제로 그렇게 실패했다.
    const cut = truncateItem({ id: 'a', type: 'assistant', text: huge, ts: 1 }, 1024) as {
      id: string
      type: string
      ts: number
      text: string
    }
    expect(cut.id).toBe('a')
    expect(cut.type).toBe('assistant')
    expect(cut.ts).toBe(1)
    expect(cut.text).not.toBe(huge)
    expect(cut.text.startsWith('xxxx')).toBe(true)

    const toolResult = truncateItem(
      {
        id: 'b',
        type: 'tool_result',
        toolId: 't',
        text: huge,
        isError: false,
        ts: 2
      },
      1024
    ) as { toolId: string; isError: boolean; text: string }
    // 폰은 tool_result 에 toolId·isError 를 요구한다 — 잘라도 남아 있어야 한다.
    expect(toolResult.toolId).toBe('t')
    expect(toolResult.isError).toBe(false)
    expect(toolResult.text).not.toBe(huge)
  })

  it('예산을 넘지 않으면서 최대한 남긴다', () => {
    const cut = truncateItem({ id: 'a', type: 'assistant', text: huge, ts: 1 }, 4096)
    const size = new TextEncoder().encode(JSON.stringify(cut)).length
    expect(size).toBeLessThanOrEqual(4096)
    expect(size).toBeGreaterThan(3500)
  })

  it('tool_use 는 인자의 앞부분을 남긴다', () => {
    // Write 한 번이 카드 전체를 지우면, 폰에서는 무엇을 쓰려는 것인지조차 볼 수 없다.
    const cut = truncateItem(
      {
        id: 'c',
        type: 'tool_use',
        toolId: 't',
        name: 'Write',
        input: { file_path: '/tmp/a.txt', content: huge },
        ts: 3
      },
      2048
    ) as { name: string; input: { file_path: string; content: string } }
    expect(cut.name).toBe('Write')
    expect(cut.input.file_path).toBe('/tmp/a.txt')
    expect(cut.input.content.startsWith('xxxx')).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(cut)).length).toBeLessThanOrEqual(2048)
  })

  it('서러게이트 쌍을 반으로 가르지 않는다', () => {
    const emoji = '🙂'.repeat(50_000)
    const cut = truncateItem({ id: 'd', type: 'assistant', text: emoji, ts: 1 }, 4096) as {
      text: string
    }
    expect(cut.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
