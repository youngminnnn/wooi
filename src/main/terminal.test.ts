import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, TerminalDataEvent, Workspace } from '@shared/types'
import { IPC } from '@shared/types'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

/** node-pty 를 대신하는 가짜 셸. 출력은 테스트가 직접 밀어 넣고, kill 여부를 기록한다. */
class FakePty {
  killed = false
  written: string[] = []
  size: { cols: number; rows: number }
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null

  constructor(cols: number, rows: number) {
    this.size = { cols, rows }
  }

  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
  }
  kill(): void {
    this.killed = true
  }
  /** 테스트에서 셸 출력을 흘려보낸다. */
  emit(data: string): void {
    this.dataCb?.(data)
  }
  exit(code: number): void {
    this.exitCb?.({ exitCode: code })
  }
}

const spawned: FakePty[] = []

vi.mock('node-pty', () => ({
  spawn: (_shell: string, _args: string[], opts: { cols: number; rows: number }) => {
    const proc = new FakePty(opts.cols, opts.rows)
    spawned.push(proc)
    return proc
  }
}))

vi.mock('./transcripts', () => ({ getTranscripts: () => ({ upsert: vi.fn() }) }))

const WS_ID = 'ws-1'

async function seedWorkspace(): Promise<void> {
  const { getStore } = await import('./store')
  getStore().update((s: AppState) => {
    s.workspaces = [{ id: WS_ID, worktreePath: '/tmp/ws-1' } as Workspace]
  })
}

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-terminal-test-'))
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

beforeEach(async () => {
  spawned.length = 0
  await seedWorkspace()
})

async function makeManager(dispatch = vi.fn()): Promise<{
  manager: import('./terminal').TerminalManager
  dispatch: ReturnType<typeof vi.fn>
}> {
  const { TerminalManager } = await import('./terminal')
  return { manager: new TerminalManager(dispatch), dispatch }
}

describe('TerminalManager 탭', () => {
  it('탭이 없으면 하나 만들어 영속하고, 그 탭을 활성으로 잡는다', async () => {
    const { manager } = await makeManager()

    const state = manager.tabs(WS_ID)

    expect(state.tabs).toHaveLength(1)
    expect(state.activeId).toBe(state.tabs[0].id)
    const { getStore } = await import('./store')
    expect(getStore().getState().workspaces[0].terminalTabs).toEqual(state.tabs)
  })

  it('탭마다 PTY 를 따로 띄우고, 입력·출력이 서로 섞이지 않는다', async () => {
    const { manager, dispatch } = await makeManager()
    const first = manager.tabs(WS_ID).activeId
    const second = manager.createTab(WS_ID).activeId

    manager.start(WS_ID, first, '/tmp/ws-1', 80, 24)
    manager.start(WS_ID, second, '/tmp/ws-1', 100, 30)
    expect(spawned).toHaveLength(2)

    manager.write(WS_ID, second, 'echo hi\r')
    expect(spawned[0].written).toEqual([])
    expect(spawned[1].written).toEqual(['echo hi\r'])

    // 출력은 낸 탭의 id 를 달고 나간다.
    dispatch.mockClear()
    spawned[1].emit('hi\n')
    await vi.waitFor(() => {
      const evt = dispatch.mock.calls.find(([channel]) => channel === IPC.evtTerminalData)
      expect((evt?.[1] as TerminalDataEvent).terminalId).toBe(second)
    })
  })

  it('버퍼 상한은 PTY 별로 걸려, 한 탭의 폭주가 다른 탭의 재생 버퍼를 갉아먹지 않는다', async () => {
    const { manager, dispatch } = await makeManager()
    const first = manager.tabs(WS_ID).activeId
    const second = manager.createTab(WS_ID).activeId
    manager.start(WS_ID, first, '/tmp/ws-1', 80, 24)
    manager.start(WS_ID, second, '/tmp/ws-1', 80, 24)

    spawned[0].emit('quiet')
    spawned[1].emit('x'.repeat(512 * 1024)) // BUFFER_LIMIT(256KiB) 을 넘기는 폭주

    dispatch.mockClear()
    manager.start(WS_ID, first, '/tmp/ws-1', 80, 24)
    const replay = dispatch.mock.calls.find(
      ([channel, payload]) =>
        channel === IPC.evtTerminalData && (payload as TerminalDataEvent).reset === true
    )
    expect((replay?.[1] as TerminalDataEvent).data).toBe('quiet')
  })

  it('목록에 없는 탭은 띄우지 않는다(닫힌 탭의 PTY 가 유령으로 남지 않게)', async () => {
    const { manager } = await makeManager()

    manager.start(WS_ID, 'gone', '/tmp/ws-1', 80, 24)

    expect(spawned).toHaveLength(0)
  })

  it('탭을 닫으면 그 PTY 만 종료하고, 활성 탭은 이웃으로 옮긴다', async () => {
    const { manager } = await makeManager()
    const first = manager.tabs(WS_ID).activeId
    const second = manager.createTab(WS_ID).activeId
    manager.start(WS_ID, first, '/tmp/ws-1', 80, 24)
    manager.start(WS_ID, second, '/tmp/ws-1', 80, 24)

    const state = manager.closeTab(WS_ID, second)

    expect(spawned[0].killed).toBe(false)
    expect(spawned[1].killed).toBe(true)
    expect(state.tabs.map((t) => t.id)).toEqual([first])
    expect(state.activeId).toBe(first)
  })

  it('마지막 탭을 닫으면 빈 탭 하나가 대신 생긴다', async () => {
    const { manager } = await makeManager()
    const only = manager.tabs(WS_ID).activeId
    manager.start(WS_ID, only, '/tmp/ws-1', 80, 24)

    const state = manager.closeTab(WS_ID, only)

    expect(spawned[0].killed).toBe(true)
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).not.toBe(only)
    expect(state.activeId).toBe(state.tabs[0].id)
  })

  it('이름을 붙이고 지운다(빈 이름은 기본 이름으로 되돌린다)', async () => {
    const { manager } = await makeManager()
    const id = manager.tabs(WS_ID).activeId

    expect(manager.renameTab(WS_ID, id, '  build  ').tabs[0].title).toBe('build')
    expect(manager.renameTab(WS_ID, id, '   ').tabs[0].title).toBeUndefined()
  })

  it('workspace 정리는 탭이 몇 개든 PTY 를 남기지 않는다', async () => {
    const { manager } = await makeManager()
    const first = manager.tabs(WS_ID).activeId
    const second = manager.createTab(WS_ID).activeId
    const third = manager.createTab(WS_ID).activeId
    for (const id of [first, second, third]) manager.start(WS_ID, id, '/tmp/ws-1', 80, 24)

    manager.disposeWorkspace(WS_ID)

    expect(spawned.map((p) => p.killed)).toEqual([true, true, true])
    // 같은 workspace 를 다시 열면 PTY 는 새로 뜬다.
    manager.start(WS_ID, first, '/tmp/ws-1', 80, 24)
    expect(spawned).toHaveLength(4)
  })

  it('`!명령` 은 지금 보고 있는 탭에서 돌아간다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)
    const second = manager.createTab(WS_ID).activeId
    manager.selectTab(WS_ID, second)

    manager.runCommand(WS_ID, '/tmp/ws-1', 'npm test')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].written).toEqual(['npm test\r'])
  })
})
