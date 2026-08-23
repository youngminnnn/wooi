import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolDeps } from './registry'

const list = vi.hoisted(() => vi.fn())
const annotate = vi.hoisted(() => vi.fn((items) => items))
const viewer = vi.hoisted(() => vi.fn())
const writable = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  workspaces: [{ id: 'ws-1', repoId: 'repo-1' }],
  repos: [{ id: 'repo-1', path: '/tmp/repo' }]
}))

vi.mock('../../github', () => ({
  listOpenPrCandidates: list,
  annotatePrCandidates: annotate,
  getViewerLogin: viewer,
  getBaseRepoWritable: writable
}))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))

const deps = {} as AgentToolDeps

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([
    { number: 2, title: 'Two', head: 'two', base: 'main', author: 'a' },
    { number: 1, title: 'One', head: 'one', base: 'main', author: 'b' }
  ])
  viewer.mockResolvedValue('me')
  writable.mockResolvedValue(true)
})

describe('list_pull_requests', () => {
  it('현재 워크스페이스의 리포를 조회하고 생성 가능 여부를 붙여 limit 만큼 반환한다', async () => {
    const { listPullRequests } = await import('./pullRequests')
    await expect(listPullRequests(deps, 'ws-1', { limit: 1 })).resolves.toHaveLength(1)
    expect(list).toHaveBeenCalledWith('/tmp/repo')
    expect(annotate).toHaveBeenCalledWith(expect.any(Array), 'me', true)
  })

  it('잘못된 limit 은 사람이 읽을 수 있는 오류로 거절한다', async () => {
    const { listPullRequests } = await import('./pullRequests')
    await expect(listPullRequests(deps, 'ws-1', { limit: 0 })).rejects.toThrow(/positive integer/)
  })

  it('initAgentTools 에 등록되어 실행된다', async () => {
    const { initAgentTools, runAgentTool } = await import('./index')
    const { resetAgentToolsForTest } = await import('./registry')
    resetAgentToolsForTest()
    initAgentTools({
      scripts: {},
      broadcastState: vi.fn(),
      sendMessage: vi.fn(),
      postToTranscript: vi.fn(),
      emitChatEvent: vi.fn(),
      sessions: { dispose: vi.fn() },
      terminals: { disposeWorkspace: vi.fn() }
    } as unknown as AgentToolDeps)
    await expect(runAgentTool('ws-1', 'list_pull_requests', { limit: 1 })).resolves.toHaveLength(1)
  })
})
