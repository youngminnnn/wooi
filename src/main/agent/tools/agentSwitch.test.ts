import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@shared/types'
import type { AgentToolDeps } from './registry'

const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))

const ensureToolApproved = vi.hoisted(() => vi.fn())
vi.mock('./permission', () => ({ ensureToolApproved }))

const switchAgentAfterTurn = vi.fn()
const deps = {
  listBackends: vi.fn(async () => [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex', label: 'Codex', available: true }
  ]),
  sessions: { switchAgentAfterTurn }
} as unknown as AgentToolDeps

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ id: 'ws-1', agentBackend: 'claude', archived: false }]
})

describe('switch_workspace_agent', () => {
  it('반드시 승인을 받은 뒤 턴 종료 교체를 예약한다', async () => {
    const { switchWorkspaceAgent } = await import('./agentSwitch')
    await expect(
      switchWorkspaceAgent(deps, 'ws-1', { agentBackend: 'codex', reason: 'Use Codex.' })
    ).resolves.toMatchObject({ changed: true, from: 'claude', to: 'codex' })

    expect(ensureToolApproved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-1' }),
      'switch_workspace_agent',
      expect.objectContaining({ agentBackend: 'codex' }),
      { always: true }
    )
    expect(ensureToolApproved.mock.invocationCallOrder[0]).toBeLessThan(
      switchAgentAfterTurn.mock.invocationCallOrder[0]
    )
    expect(switchAgentAfterTurn).toHaveBeenCalledWith('ws-1', 'codex')
  })

  it('사용자가 거절하면 아무 전환도 예약하지 않는다', async () => {
    ensureToolApproved.mockRejectedValueOnce(new Error('The user declined this action.'))
    const { switchWorkspaceAgent } = await import('./agentSwitch')

    await expect(
      switchWorkspaceAgent(deps, 'ws-1', { agentBackend: 'codex', reason: 'Use Codex.' })
    ).rejects.toThrow(/declined/)
    expect(switchAgentAfterTurn).not.toHaveBeenCalled()
  })

  it('현재 에이전트면 세션을 건드리지 않는다', async () => {
    const { switchWorkspaceAgent } = await import('./agentSwitch')
    await expect(
      switchWorkspaceAgent(deps, 'ws-1', { agentBackend: 'claude', reason: 'No-op.' })
    ).resolves.toMatchObject({ changed: false })
    expect(ensureToolApproved).not.toHaveBeenCalled()
    expect(switchAgentAfterTurn).not.toHaveBeenCalled()
  })

  it('설치되지 않은 에이전트면 승인 전에 거절한다', async () => {
    deps.listBackends = vi.fn(async () => [
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        unavailableReason: 'Codex is not installed.'
      }
    ]) as unknown as AgentToolDeps['listBackends']
    const { switchWorkspaceAgent } = await import('./agentSwitch')

    await expect(
      switchWorkspaceAgent(deps, 'ws-1', { agentBackend: 'codex', reason: 'Use Codex.' })
    ).rejects.toThrow(/not installed/)
    expect(ensureToolApproved).not.toHaveBeenCalled()
  })
})
