import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shared/types'

/**
 * 사용자가 끊은 턴에 남는 표시([[shared/types]] InterruptedTurn)의 수명.
 *
 * 지키는 계약은 셋이다.
 *  1. 표시는 **실제 중단 경로에서만** 찍힌다 — 상태를 보고 "중단인 것 같다" 고 추론하지 않는다.
 *  2. 표시를 지우는 자리는 다음 턴의 **시작**이다. 끝이 아니다 — 중단하면 그 턴의 idle 이
 *     뒤늦게 한 번 더 올라오는데, 끝에서 지우면 방금 찍은 표시를 그 신호가 바로 지운다.
 *  3. 세션이 바뀌면 옛 표시는 남의 것이다(그 판정은 순수 함수 wasInterrupted 에 있다).
 *
 * 두 백엔드를 같은 표로 도는 이유는 [[agent/turnEnd]] 와 같다 — 턴의 시작을 아는 자리가
 * 백엔드마다 따로라 한쪽만 고쳐지기 쉽고, 그러면 에이전트에 따라 표시가 남기도 안 남기도 한다.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as {
    id: string
    status: string
    sessionId: string | null
    agentBackend?: string
    interruptedTurn?: { at: number; sessionId: string | null } | null
    lastActiveAt?: number
  }[],
  settings: { notifications: {} },
  rateLimitsByAgent: {}
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp/wooi-interrupted-test' },
  utilityProcess: { fork: (): never => new Error('no host in this test') as never },
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

const BACKENDS = ['claude', 'codex'] as const

async function manager(label: (typeof BACKENDS)[number]): Promise<Manager> {
  if (label === 'codex') {
    const { CodexSessionManager } = await import('../codex/manager')
    return new CodexSessionManager(
      () => {},
      () => null,
      () => false
    ) as unknown as Manager
  }
  const { SessionManager } = await import('../claude/manager')
  return new SessionManager(
    () => {},
    () => null,
    () => false
  ) as unknown as Manager
}

const workspace = (): (typeof state.workspaces)[number] => state.workspaces[0]

beforeEach(() => {
  vi.useFakeTimers()
  state.workspaces = [{ id: 'ws-1', status: 'running', sessionId: 'sess-1' }]
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(BACKENDS)('중단 표시의 수명 (%s)', (label) => {
  it('새 턴이 시작하면 지난 턴의 중단 표시를 지운다', async () => {
    const backend = await manager(label)
    workspace().interruptedTurn = { at: 1, sessionId: 'sess-1' }

    backend.emit('ws-1', { type: 'status', status: 'running' })

    expect(workspace().interruptedTurn).toBeNull()
  })

  it('중단 뒤 뒤늦게 올라온 idle 은 표시를 지우지 않는다', async () => {
    const backend = await manager(label)
    workspace().interruptedTurn = { at: 1, sessionId: 'sess-1' }

    // 중단하면 forceIdle 로 이미 idle 이 되고, 끊긴 턴의 진짜 종료가 그 뒤에 한 번 더 올라온다.
    backend.emit('ws-1', { type: 'status', status: 'idle' })

    expect(workspace().interruptedTurn).toEqual({ at: 1, sessionId: 'sess-1' })
  })

  it('그냥 끝난 턴에는 표시를 만들지 않는다', async () => {
    const backend = await manager(label)

    backend.emit('ws-1', { type: 'status', status: 'idle' })

    expect(workspace().interruptedTurn ?? null).toBeNull()
  })
})

describe('중단 경로', () => {
  it('중단하면 지금 세션 id 와 함께 표시를 남긴다', async () => {
    const { AgentOrchestrator } = await import('./orchestrator')
    const orchestrator = new AgentOrchestrator(
      () => {},
      () => null
    )

    await orchestrator.interrupt('ws-1')

    expect(workspace().interruptedTurn).toEqual({
      at: expect.any(Number),
      sessionId: 'sess-1'
    })
    // 중단은 "그만" 이므로 상태는 idle 로 확정된다.
    expect(workspace().status).toBe('idle')
  })

  it('모르는 워크스페이스면 아무것도 남기지 않는다', async () => {
    const { AgentOrchestrator } = await import('./orchestrator')
    const orchestrator = new AgentOrchestrator(
      () => {},
      () => null
    )

    await orchestrator.interrupt('ws-gone')

    expect(workspace().interruptedTurn ?? null).toBeNull()
  })
})
