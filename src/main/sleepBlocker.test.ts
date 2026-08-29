import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { AppState } from '@shared/types'

/**
 * electron 의 전원 API 만 목킹한다(commandRegistry.test 가 ipcMain 을 목킹하는 방식과 같다).
 * 실제로 맥을 재워 볼 수는 없으므로, 검증하는 것은 "언제 붙잡고 언제 놓아주는가" 다.
 */
const blocker = {
  nextId: 1,
  active: new Set<number>(),
  startedTypes: [] as string[]
}
const resumeListeners: (() => void)[] = []

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: (type: string) => {
      blocker.startedTypes.push(type)
      const id = blocker.nextId++
      blocker.active.add(id)
      return id
    },
    stop: (id: number) => void blocker.active.delete(id),
    isStarted: (id: number) => blocker.active.has(id)
  },
  powerMonitor: {
    on: (_event: string, listener: () => void) => void resumeListeners.push(listener),
    off: (_event: string, listener: () => void) => {
      const at = resumeListeners.indexOf(listener)
      if (at >= 0) resumeListeners.splice(at, 1)
    }
  }
}))

vi.mock('./logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

const { initSleepBlocker, setSleepBlockerEnabled, noteSleepBlockerEvent, disposeSleepBlocker } =
  await import('./sleepBlocker')

const T0 = new Date('2026-01-01T00:00:00Z').getTime()
const HOUR = 60 * 60 * 1000

/** 지금 시스템을 붙잡고 있는가. */
function holding(): boolean {
  return blocker.active.size > 0
}

function chat(workspaceId: string, event: unknown): void {
  noteSleepBlockerEvent(IPC.evtChat, { workspaceId, event })
}

function status(workspaceId: string, value: 'running' | 'idle' | 'error'): void {
  chat(workspaceId, { type: 'status', status: value })
}

function state(workspaces: { id: string; status: string; archived?: boolean }[]): void {
  noteSleepBlockerEvent(IPC.evtState, { workspaces } as unknown as AppState)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  blocker.active.clear()
  blocker.startedTypes.length = 0
  blocker.nextId = 1
  resumeListeners.length = 0
  initSleepBlocker(true)
})

afterEach(() => {
  disposeSleepBlocker()
  vi.useRealTimers()
})

describe('수면 방지', () => {
  it('도는 워크스페이스가 생기면 앱 서스펜션만 막는다', () => {
    expect(holding()).toBe(false)

    status('ws-1', 'running')

    expect(holding()).toBe(true)
    // 화면까지 켜 두지 않는다 — 자리를 뜬 맥이 밤새 밝아 있으면 안 된다.
    expect(blocker.startedTypes).toEqual(['prevent-app-suspension'])
  })

  it('마지막 워크스페이스가 멈추면 놓아준다', () => {
    status('ws-1', 'running')
    status('ws-2', 'running')

    status('ws-1', 'idle')
    expect(holding()).toBe(true)

    status('ws-2', 'idle')
    expect(holding()).toBe(false)
  })

  it('설정이 꺼져 있으면 붙잡지 않고, 도는 중에 끄면 즉시 놓아준다', () => {
    setSleepBlockerEnabled(false)
    status('ws-1', 'running')
    expect(holding()).toBe(false)

    setSleepBlockerEnabled(true)
    expect(holding()).toBe(true)

    setSleepBlockerEnabled(false)
    expect(holding()).toBe(false)
  })

  it('상태 이벤트 없이 사라진 워크스페이스는 상태 방송으로 놓아준다', () => {
    status('ws-1', 'running')
    expect(holding()).toBe(true)

    // 아카이브·세션 정리는 status 이벤트 없이 상태만 고쳐 방송한다.
    state([{ id: 'ws-1', status: 'running', archived: true }])
    expect(holding()).toBe(false)
  })

  it('상태 방송에만 나타난 running 도 붙잡는다', () => {
    state([{ id: 'ws-1', status: 'running' }])
    expect(holding()).toBe(true)
  })

  it('2시간 동안 아무 신호도 없으면 굳은 것으로 보고 놓아준다', () => {
    status('ws-1', 'running')
    expect(holding()).toBe(true)

    // 'idle' 전이를 영영 놓친 상황 — 여기서 안 풀면 맥은 영원히 잠들지 못한다.
    vi.advanceTimersByTime(2 * HOUR + 1)
    expect(holding()).toBe(false)
  })

  it('턴이 살아서 무엇이든 말하는 동안에는 2시간이 넘어도 붙잡는다', () => {
    status('ws-1', 'running')

    vi.advanceTimersByTime(HOUR)
    // 전이가 아닌 보통의 대화 이벤트도 "살아 있다" 는 증거다.
    chat('ws-1', { type: 'item', id: 'tool-1' })

    // 시작 시각으로부터는 2시간을 넘겼지만, 마지막 신호로부터는 아직 1시간 반이다.
    vi.advanceTimersByTime(HOUR + HOUR / 2)
    expect(holding()).toBe(true)
  })

  it('잠에서 깨면 상태를 다시 확인한다', () => {
    status('ws-1', 'running')
    expect(resumeListeners).toHaveLength(1)

    // 절전 중 블로커가 사라진 상태를 흉내 낸다 — 깨어난 뒤 다시 잡아야 한다.
    blocker.active.clear()
    resumeListeners[0]()

    expect(holding()).toBe(true)
  })

  it('dispose 하면 붙잡은 것을 놓아준다', () => {
    status('ws-1', 'running')
    expect(holding()).toBe(true)

    disposeSleepBlocker()
    expect(holding()).toBe(false)
  })
})
