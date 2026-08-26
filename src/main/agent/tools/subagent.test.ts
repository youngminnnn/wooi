import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatEvent, RunningAgent } from '@shared/types'

/**
 * 병렬 위임이 사이드바에 **둘 다** 보이는가.
 *
 * 실사용에서 codex·claude 서브에이전트를 동시에 띄웠는데 목록에 하나씩만 보인다는 관찰이 있었다.
 * `agents` 이벤트는 REPLACE 시맨틱이라(types.ts) 한 번이라도 짧은 목록을 보내면 그 순간 화면에서
 * 사라지므로, 방출된 목록의 **최대 길이**를 봐야 한다.
 */

const runSubAgent = vi.hoisted(() => vi.fn())
vi.mock('../../subagent/run', () => ({ runSubAgent }))
vi.mock('./permission', () => ({ askSubAgentPermission: vi.fn() }))

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state.value }) }))

const WORKSPACE = {
  id: 'ws1',
  repoId: 'r1',
  agentBackend: 'claude',
  multiAgent: true,
  worktreePath: '/tmp/wt',
  permissionMode: 'default'
}

beforeEach(() => {
  state.value = {
    workspaces: [WORKSPACE],
    repos: [{ id: 'r1', path: '/tmp/repo' }],
    settings: {
      agents: { claude: {}, codex: {} }
    }
  }
  runSubAgent.mockReset()
})

afterEach(() => vi.resetModules())

describe('병렬 위임', () => {
  it('동시에 도는 서브에이전트가 목록에 함께 남는다', async () => {
    const { runDelegateTool } = await import('./subagent')

    // 두 실행이 겹치도록 붙잡아 둔다 — 순차로 끝나면 목록 길이가 1 을 넘지 않아 이 테스트가
    // 검증하려던 것(겹침)을 지나쳐 버린다.
    const release: (() => void)[] = []
    runSubAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve({ text: 'done', sessionId: null, error: null }))
        })
    )

    const emitted: RunningAgent[][] = []
    const deps = {
      emitChatEvent: (_id: string, event: ChatEvent) => {
        if (event.type === 'agents') emitted.push(event.agents)
      }
    } as never

    const claude = runDelegateTool('claude')(deps, 'ws1', { description: 'A', prompt: 'a' })
    const codex = runDelegateTool('codex')(deps, 'ws1', { description: 'B', prompt: 'b' })

    // 두 실행이 모두 시작될 때까지 기다린다.
    await vi.waitFor(() => expect(release).toHaveLength(2))

    const widest = Math.max(...emitted.map((list) => list.length))
    expect(widest, `방출된 목록: ${JSON.stringify(emitted.map((l) => l.length))}`).toBe(2)
    // 백엔드가 섞여 보여야 한다 — 사이드바가 브랜드 마크를 그 값으로 고른다.
    const both = emitted.find((list) => list.length === 2)!
    expect(both.map((a) => a.backend).sort()).toEqual(['claude', 'codex'])

    release.forEach((fn) => fn())
    await Promise.all([claude, codex])

    // 둘 다 끝나면 목록이 비어야 한다(스피너가 남지 않는다).
    expect(emitted[emitted.length - 1]).toEqual([])
  })
})

/**
 * 위임마다 모델·강도를 따로 고를 수 있는가.
 *
 * 이 축이 없던 동안 위임은 전역 백엔드 설정으로만 돌았고, 그래서 한 워크스페이스 안에서
 * "훑는 일은 싸게, 판정은 깊게" 를 나눌 방법이 없었다. 검증하는 것은 셋이다 — 요청이 기본값을
 * 덮는가, **지정하지 않은 축만** 기본값으로 떨어지는가, 그리고 거절이 사이드바에 흔적을 남기지
 * 않는가.
 */
describe('위임 실행의 모델·강도', () => {
  const deps = (listModels = vi.fn(async () => [{ id: 'claude-haiku-4-5' }])): never =>
    ({ emitChatEvent: () => {}, listModels }) as never

  beforeEach(() => {
    state.value = {
      workspaces: [WORKSPACE],
      repos: [{ id: 'r1', path: '/tmp/repo' }],
      settings: { agents: { claude: { model: 'claude-opus-5', effort: 'high' }, codex: {} } }
    }
    runSubAgent.mockResolvedValue({ text: 'done', sessionId: null, error: null })
  })

  it('요청한 값이 전역 기본값을 덮는다', async () => {
    const { runDelegateTool } = await import('./subagent')
    await runDelegateTool('claude')(deps(), 'ws1', {
      description: 'A',
      prompt: 'a',
      model: 'claude-haiku-4-5',
      effort: 'low'
    })
    expect(runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5', effort: 'low' })
    )
  })

  it('지정하지 않은 축은 전역 기본값을 그대로 쓴다', async () => {
    const { runDelegateTool } = await import('./subagent')
    await runDelegateTool('claude')(deps(), 'ws1', {
      description: 'A',
      prompt: 'a',
      model: 'claude-haiku-4-5'
    })
    // effort 를 함께 떨어뜨리면 사용자가 설정해 둔 값이 조용히 사라진다.
    expect(runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5', effort: 'high' })
    )
  })

  it('아무것도 지정하지 않으면 예전과 같이 돈다', async () => {
    const { runDelegateTool } = await import('./subagent')
    const listModels = vi.fn(async () => [{ id: 'claude-haiku-4-5' }])
    await runDelegateTool('claude')(deps(listModels), 'ws1', { description: 'A', prompt: 'a' })
    expect(runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5', effort: 'high' })
    )
    // 모델을 고르지 않았으면 카탈로그를 물어볼 이유가 없다 — 조회는 비동기 왕복이다.
    expect(listModels).not.toHaveBeenCalled()
  })

  it('카탈로그에 없는 모델은 고를 수 있는 값을 적어 거절한다', async () => {
    const { runDelegateTool } = await import('./subagent')
    const emitted: RunningAgent[][] = []
    const rejected = {
      emitChatEvent: (_id: string, event: ChatEvent) => {
        if (event.type === 'agents') emitted.push(event.agents)
      },
      listModels: vi.fn(async () => [{ id: 'claude-haiku-4-5' }])
    } as never

    await expect(
      runDelegateTool('claude')(rejected, 'ws1', {
        description: 'A',
        prompt: 'a',
        model: 'gpt-9'
      })
    ).rejects.toThrow(/claude-haiku-4-5/)

    expect(runSubAgent).not.toHaveBeenCalled()
    // 거절된 호출은 사이드바에 잠깐이라도 나타나지 않는다.
    expect(emitted).toEqual([])
  })

  it('그 백엔드에 없는 강도는 거절한다', async () => {
    const { runDelegateTool } = await import('./subagent')
    await expect(
      runDelegateTool('codex')(deps(), 'ws1', {
        description: 'A',
        prompt: 'a',
        effort: 'ultracode'
      })
    ).rejects.toThrow(/ultracode/)
    expect(runSubAgent).not.toHaveBeenCalled()
  })
})
