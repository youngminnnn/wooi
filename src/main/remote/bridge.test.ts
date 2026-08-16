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
vi.mock('../transcripts', () => ({ getTranscripts: () => ({ load: () => [] }) }))

const { deriveDirectionKeys, generateSessionKey, openJson, sealJson, toBase64Url } =
  await import('@shared/crypto')
const { REMOTE_IPC } = await import('@shared/remote')
const { RemoteCommandBridge, REMOTE_WATCH_TTL_MS, truncateItem } = await import('./bridge')
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

function start(store = keystore()): void {
  bridge = new RemoteCommandBridge({
    supabase: () => relay as unknown as SupabaseClient,
    keystore: store,
    machineId,
    now: () => now
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
    row.payload_ct = `${row.payload_ct.slice(0, -2)}00`
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

describe('트랜스크립트 잘림', () => {
  it('큰 아이템의 본문만 바꾸고 타입 필수 필드는 남긴다', () => {
    // id/type/ts 만 남기면 폰의 ChatItem 검증을 통과하지 못해, 큰 메시지 하나가
    // 트랜스크립트 전체를 못 읽게 만든다 — 실기기에서 실제로 그렇게 실패했다.
    const huge = 'x'.repeat(300_000)
    const cut = truncateItem({ id: 'a', type: 'assistant', text: huge, ts: 1 }) as {
      id: string
      type: string
      ts: number
      text: string
    }
    expect(cut.id).toBe('a')
    expect(cut.type).toBe('assistant')
    expect(cut.ts).toBe(1)
    expect(typeof cut.text).toBe('string')
    expect(cut.text).not.toBe(huge)

    const toolResult = truncateItem({
      id: 'b',
      type: 'tool_result',
      toolId: 't',
      text: huge,
      isError: false,
      ts: 2
    }) as { toolId: string; isError: boolean; text: string }
    // 폰은 tool_result 에 toolId·isError 를 요구한다 — 잘라도 남아 있어야 한다.
    expect(toolResult.toolId).toBe('t')
    expect(toolResult.isError).toBe(false)
    expect(toolResult.text).not.toBe(huge)
  })
})
