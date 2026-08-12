import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type ChatEvent } from '@shared/types'

/**
 * 턴 종료 훅([[agent/backend]] TurnEndHook)을 **모든 백엔드가 같게** 지키는지.
 *
 * 여기서 지키는 계약은 한 줄이다: 훅이 true 를 돌려주면 그 턴 종료는 없던 일이 된다 — 상태를
 * idle 로 적지도, 렌더러에 방송하지도 않는다. 그래야 턴과 턴 사이에 사용자가 "쉬고 있다" 고 볼
 * 틈이 생기지 않고, 그 틈이 없어야 사용자가 친 말이 사용자가 시작하지 않은 턴에 섞이지 않는다
 * ([[agent/orchestrator]] handleTurnEnd, 그리고 그 실패를 겪고 되돌린 [[shared/handoff]]).
 *
 * 두 백엔드를 한 파일에서 같은 표로 도는 이유: 턴의 끝을 아는 자리가 백엔드마다 따로라 한쪽만
 * 고쳐지기 쉽다. 그러면 백엔드에 따라 자동 이어가기가 되기도 안 되기도 하는데, 그건 사용자가
 * 재현하지도 설명하지도 못하는 종류의 고장이다.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as { id: string; status: string; lastActiveAt?: number }[],
  settings: { notifications: {} },
  rateLimitsByAgent: {}
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp/wooi-turn-end-test' },
  utilityProcess: { fork: (): never => new Error('no host in this test') as never },
  // 창이 없으므로 알림은 어차피 뜨지 않지만, 지원하지 않는다고 잘라 두면 확실하다.
  Notification: { isSupported: (): boolean => false }
}))
vi.mock('../store', () => ({
  getStore: () => ({
    getState: () => state,
    update: (fn: (draft: typeof state) => void) => fn(state)
  })
}))
vi.mock('../transcripts', () => ({ getTranscripts: () => ({ upsert: () => {}, load: () => [] }) }))
vi.mock('../logger', () => ({ log: { info: () => {}, error: () => {}, warn: () => {} } }))
vi.mock('../mcpSettings', () => ({ wooiMcpSettings: () => ({}), codexMcpServerEnv: () => ({}) }))
vi.mock('./tools', () => ({ runAgentTool: () => Promise.resolve({}) }))
vi.mock('./tools/subagent', () => ({ abortSubAgents: () => {}, abortAllSubAgents: () => {} }))

type Manager = { emit: (workspaceId: string, event: ChatEvent) => void }
type Dispatch = (channel: string, payload: unknown) => void
type Hook = (workspaceId: string, status: 'idle' | 'error') => boolean

const BACKENDS = ['claude', 'codex'] as const

async function manager(
  label: (typeof BACKENDS)[number],
  onTurnEnd: Hook,
  dispatch: Dispatch = () => {}
): Promise<Manager> {
  if (label === 'codex') {
    const { CodexSessionManager } = await import('../codex/manager')
    return new CodexSessionManager(dispatch, () => null, onTurnEnd) as unknown as Manager
  }
  const { SessionManager } = await import('../claude/manager')
  return new SessionManager(dispatch, () => null, onTurnEnd) as unknown as Manager
}

/** 이 워크스페이스에 대해 렌더러로 나간 상태 이벤트만 추린다. */
function statusEvents(calls: [string, unknown][]): string[] {
  return calls
    .filter(([channel]) => channel === IPC.evtChat)
    .map(([, payload]) => (payload as { event: ChatEvent }).event)
    .filter((event) => event.type === 'status')
    .map((event) => (event as { status: string }).status)
}

beforeEach(() => {
  // 턴 종료 뒤 예약되는 레이트리밋 조회가 테스트 밖에서 호스트를 띄우려 들지 않게 묶어 둔다.
  vi.useFakeTimers()
  state.workspaces = [{ id: 'ws-1', status: 'running' }]
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(BACKENDS)('턴 종료 훅 (%s)', (label) => {
  it('훅이 가져갔으면 상태를 적지도 방송하지도 않는다', async () => {
    const calls: [string, unknown][] = []
    const backend = await manager(
      label,
      () => true,
      (c, p) => calls.push([c, p])
    )

    backend.emit('ws-1', { type: 'status', status: 'idle' })

    expect(statusEvents(calls)).toEqual([])
    // store 까지 idle 로 적으면 사이드바가 잠깐 쉬는 것처럼 보인다 — 방송만 막아서는 부족하다.
    expect(state.workspaces[0].status).toBe('running')
  })

  it('훅이 가져가지 않으면 평소대로 끝난다', async () => {
    const calls: [string, unknown][] = []
    const backend = await manager(
      label,
      () => false,
      (c, p) => calls.push([c, p])
    )

    backend.emit('ws-1', { type: 'status', status: 'idle' })

    expect(statusEvents(calls)).toEqual(['idle'])
    expect(state.workspaces[0].status).toBe('idle')
  })

  it('오류로 끝난 것도 알린다 — 소유자가 들고 있던 예약을 접어야 한다', async () => {
    const seen: [string, string][] = []
    const backend = await manager(label, (workspaceId, status) => {
      seen.push([workspaceId, status])
      return false
    })

    backend.emit('ws-1', { type: 'status', status: 'error' })

    expect(seen).toEqual([['ws-1', 'error']])
  })

  it('턴이 시작될 때는 부르지 않는다 — 끝의 훅이다', async () => {
    const seen: string[] = []
    const backend = await manager(label, (_id, status) => {
      seen.push(status)
      return true
    })

    backend.emit('ws-1', { type: 'status', status: 'running' })

    expect(seen).toEqual([])
    expect(state.workspaces[0].status).toBe('running')
  })

  // 훅이 없는 백엔드(오케스트레이터를 거치지 않고 만든 경우)도 평소대로 돌아야 한다.
  it('훅이 없어도 턴은 끝난다', async () => {
    const calls: [string, unknown][] = []
    const backend = await manager(label, undefined as unknown as Hook, (c, p) => calls.push([c, p]))

    backend.emit('ws-1', { type: 'status', status: 'idle' })

    expect(statusEvents(calls)).toEqual(['idle'])
  })
})
