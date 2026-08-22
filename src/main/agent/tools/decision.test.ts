import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PENDING_DECISIONS } from '@shared/types'
import type { Repo, Workspace } from '@shared/types'
import type { AgentToolDeps } from './registry'

const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [{ id: 'repo-1', name: 'wooi' }] as Partial<Repo>[]
}))
const update = vi.hoisted(() => vi.fn((fn: (value: typeof state) => void) => fn(state)))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update }) }))

const sendMessage = vi.fn()
const broadcastState = vi.fn()
const postToTranscript = vi.fn()
const deps = { sendMessage, broadcastState, postToTranscript } as unknown as AgentToolDeps

function workspace(overrides: Partial<Workspace>): Partial<Workspace> {
  return {
    id: 'child',
    repoId: 'repo-1',
    branch: 'feat/child',
    name: 'child',
    displayName: null,
    archived: false,
    status: 'idle',
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    lastActiveAt: 0,
    ...overrides
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  state.workspaces = [workspace({})]
  const { initDecisionDelivery } = await import('./decision')
  initDecisionDelivery(deps)
})

async function ask(args: Record<string, unknown> = { question: 'Which schema should we use?' }) {
  const { askForDecision } = await import('./decision')
  return askForDecision(deps, 'child', args)
}

describe('ask_for_decision', () => {
  it('부모를 깨우지 않고 사용자에게 먼저 간다', async () => {
    state.workspaces.push(workspace({ id: 'parent', branch: 'feat/parent' }))
    state.workspaces[0].parentWorkspaceId = 'parent'

    await ask()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(state.workspaces[0].decisions).toHaveLength(1)
  })

  it('답이 자식에게 전달돼 턴이 열린다', async () => {
    await ask()
    const decision = state.workspaces[0].decisions![0]
    const { answerDecision } = await import('./decision')

    expect(answerDecision('child', decision.id, 'Use the additive migration.')).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(
      'child',
      expect.stringContaining('Use the additive migration.')
    )
    expect(state.workspaces[0].decisions).toEqual([])
  })

  it('배달에 실패하면 답과 실패 표식을 남긴다', async () => {
    await ask()
    const decision = state.workspaces[0].decisions![0]
    sendMessage.mockImplementationOnce(() => {
      throw new Error('session gone')
    })
    const { answerDecision } = await import('./decision')

    expect(answerDecision('child', decision.id, 'Keep it local.')).toBe(false)
    expect(state.workspaces[0].decisions?.[0]).toMatchObject({
      id: decision.id,
      answer: 'Keep it local.',
      deliveryFailed: true
    })
  })

  it('running이면 붙잡았다가 턴 종료에 흘려보낸다', async () => {
    state.workspaces[0].status = 'running'
    await ask()
    const decision = state.workspaces[0].decisions![0]
    const { answerDecision, flushAnsweredDecisions } = await import('./decision')

    expect(answerDecision('child', decision.id, 'Take option A.')).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(flushAnsweredDecisions('child')).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(state.workspaces[0].decisions).toEqual([])
  })

  it('대기 상한을 넘으면 기존 질문을 버리지 않고 거절한다', async () => {
    state.workspaces[0].decisions = Array.from({ length: MAX_PENDING_DECISIONS }, (_, index) => ({
      id: `d-${index}`,
      question: `Question ${index}`,
      askedAt: index
    }))

    await expect(ask()).rejects.toThrow(/already 5 unanswered questions/)
    expect(state.workspaces[0].decisions).toHaveLength(MAX_PENDING_DECISIONS)
  })

  it('부모 없는 워크스페이스에서도 질문이 뜬다', async () => {
    await expect(ask()).resolves.toMatchObject({ status: 'waiting-for-the-user' })
    expect(state.workspaces[0].decisions).toHaveLength(1)
  })

  it('에스컬레이션은 hold를 건너뛰고 refuse를 존중한다', async () => {
    const parent = workspace({
      id: 'parent',
      branch: 'feat/parent',
      peerInbound: 'hold'
    })
    state.workspaces.push(parent)
    state.workspaces[0].parentWorkspaceId = 'parent'
    await ask()
    const first = state.workspaces[0].decisions![0]
    const { escalateDecision } = await import('./decision')

    expect(escalateDecision('child', first.id)).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(
      'parent',
      expect.stringContaining(first.question),
      expect.anything()
    )
    expect(parent.peerInbox ?? []).toHaveLength(0)

    sendMessage.mockClear()
    parent.peerInbound = 'refuse'
    await ask({ question: 'Should the public name change?' })
    const second = state.workspaces[0].decisions![1]
    expect(escalateDecision('child', second.id)).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(state.workspaces[0].decisions?.some((decision) => decision.id === second.id)).toBe(true)
  })
})
