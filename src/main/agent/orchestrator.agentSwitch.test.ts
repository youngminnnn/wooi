import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../storeSchema'
import type { Workspace } from '@shared/types'

type Hook = (workspaceId: string, status: 'idle' | 'error') => boolean
const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  settings: {} as typeof DEFAULT_SETTINGS
}))
const hooks = vi.hoisted(() => new Map<string, Hook>())
const backends = vi.hoisted(() => ({
  claude: {
    sendMessage: vi.fn(),
    dispose: vi.fn(),
    interrupt: vi.fn(async () => {}),
    meta: { id: 'claude', capabilities: {} }
  },
  codex: {
    sendMessage: vi.fn(),
    dispose: vi.fn(),
    interrupt: vi.fn(async () => {}),
    meta: { id: 'codex', capabilities: {} }
  }
}))

vi.mock('../store', () => ({
  getStore: () => ({
    getState: () => state,
    update: (fn: (value: typeof state) => void) => fn(state)
  })
}))
vi.mock('../transcripts', () => ({
  getTranscripts: () => ({
    load: () => [
      { id: 'u', type: 'user', text: 'finish the migration', ts: 1 },
      { id: 'a', type: 'assistant', text: 'updated schema.ts', ts: 2 }
    ]
  })
}))
vi.mock('./registry', () => ({
  createBackend: (id: 'claude' | 'codex', deps: { onTurnEnd: Hook }) => {
    hooks.set(id, deps.onTurnEnd)
    return backends[id]
  },
  backendAvailability: vi.fn()
}))
vi.mock('./tools/peer', () => ({
  detachBufferedPeerMessages: vi.fn(() => null),
  flushBufferedPeerMessages: vi.fn(() => false),
  forgetPeerSessionRules: vi.fn(),
  resetPeerSession: vi.fn(),
  resetAllPeerSessions: vi.fn()
}))
vi.mock('../contextUsageCache', () => ({ forgetContextUsage: vi.fn() }))
vi.mock('../usageLedger', () => ({ forgetWorkspaceUsage: vi.fn() }))
vi.mock('../runningAgentsCache', () => ({ forgetRunningAgents: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  hooks.clear()
  state.settings = { ...DEFAULT_SETTINGS }
  state.workspaces = [
    {
      id: 'ws-1',
      agentBackend: 'claude',
      sessionId: 'claude-session',
      status: 'running',
      archived: false
    }
  ]
})

describe('switchAgentAfterTurn', () => {
  it('현재 턴 동안은 옛 세션을 유지하고, idle 뒤 새 에이전트를 체크포인트와 함께 시작한다', async () => {
    const { AgentOrchestrator } = await import('./orchestrator')
    const dispatch = vi.fn()
    const agents = new AgentOrchestrator(dispatch, () => null)
    agents.metaFor('ws-1')

    agents.switchAgentAfterTurn('ws-1', 'codex')
    expect(state.workspaces[0].agentBackend).toBe('claude')
    expect(backends.claude.dispose).not.toHaveBeenCalled()

    expect(hooks.get('claude')?.('ws-1', 'idle')).toBe(true)
    expect(backends.claude.dispose).toHaveBeenCalledWith('ws-1')
    expect(state.workspaces[0]).toMatchObject({ agentBackend: 'codex', sessionId: null })
    expect(backends.codex.sendMessage).toHaveBeenCalledWith(
      'ws-1',
      expect.stringContaining('Wooi switched this workspace to Codex'),
      undefined,
      expect.objectContaining({
        silent: true,
        prefix: expect.stringContaining('## Goal and recent user intent')
      })
    )
    expect(dispatch).toHaveBeenCalled()
  })

  it('현재 턴이 오류로 끝나면 자동 전환하지 않는다', async () => {
    const { AgentOrchestrator } = await import('./orchestrator')
    const agents = new AgentOrchestrator(
      () => {},
      () => null
    )
    agents.metaFor('ws-1')
    agents.switchAgentAfterTurn('ws-1', 'codex')

    expect(hooks.get('claude')?.('ws-1', 'error')).toBe(false)
    expect(state.workspaces[0].agentBackend).toBe('claude')
    expect(backends.codex.sendMessage).not.toHaveBeenCalled()
  })

  it('승인 뒤라도 사용자가 턴을 중단하면 예약된 전환을 취소한다', async () => {
    const { AgentOrchestrator } = await import('./orchestrator')
    const agents = new AgentOrchestrator(
      () => {},
      () => null
    )
    agents.metaFor('ws-1')
    agents.switchAgentAfterTurn('ws-1', 'codex')

    await agents.interrupt('ws-1')
    expect(hooks.get('claude')?.('ws-1', 'idle')).toBe(false)
    expect(state.workspaces[0].agentBackend).toBe('claude')
    expect(backends.codex.sendMessage).not.toHaveBeenCalled()
  })

  it('새 에이전트 자동 시작이 실패하면 idle 방송을 허용해 다음 메시지로 복구할 수 있다', async () => {
    backends.codex.sendMessage.mockImplementationOnce(() => {
      throw new Error('host unavailable')
    })
    const { AgentOrchestrator } = await import('./orchestrator')
    const agents = new AgentOrchestrator(
      () => {},
      () => null
    )
    agents.metaFor('ws-1')
    agents.switchAgentAfterTurn('ws-1', 'codex')

    expect(hooks.get('claude')?.('ws-1', 'idle')).toBe(false)
    expect(state.workspaces[0]).toMatchObject({ agentBackend: 'codex', sessionId: null })
  })
})
