import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentToolDeps } from './registry'

/**
 * 이 도구가 지켜야 할 것은 두 가지다.
 *
 * 하나는 **부모가 호출한 워크스페이스 자신**이라는 것 — 인자로 받지 않으므로 모델이 남의
 * 스택에 끼어들 수 없다. 다른 하나는 **미커밋 변경이 있으면 거부**한다는 것 — 새 브랜치는
 * 커밋된 tip 에서 갈라지므로, 그대로 만들면 그 변경이 따라오지 않는데 에러도 나지 않는다.
 */

const clean = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ workspaces: [] as unknown[] }))

vi.mock('../../git', () => ({ isWorktreeClean: clean }))
vi.mock('../../workspaces', () => ({ createWorkspace: create }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))

const deps = { scripts: {}, broadcastState: vi.fn() } as unknown as AgentToolDeps

const parent = {
  id: 'ws-parent',
  repoId: 'repo-1',
  branch: 'feat/base',
  worktreePath: '/tmp/wt',
  archived: false
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [parent]
  clean.mockResolvedValue(true)
  create.mockResolvedValue({ workspaceId: 'ws-new', name: 'feat/next', branch: 'feat/next' })
})

async function run(args: Record<string, unknown> = {}): Promise<unknown> {
  const { createStackedWorkspace } = await import('./stackedWorkspace')
  return createStackedWorkspace(deps, 'ws-parent', args)
}

describe('create_stacked_workspace', () => {
  it('호출한 워크스페이스를 부모로 넘긴다(모델이 지목할 수 없다)', async () => {
    await run({ name: 'feat/next' })

    expect(create).toHaveBeenCalledWith(deps, {
      repoId: 'repo-1',
      parentWorkspaceId: 'ws-parent',
      name: 'feat/next'
    })
  })

  it('이름을 안 주면 Wooi 가 짓도록 넘기지 않는다', async () => {
    await run({})
    expect(create).toHaveBeenCalledWith(deps, {
      repoId: 'repo-1',
      parentWorkspaceId: 'ws-parent'
    })
  })

  it('공백뿐인 이름도 안 준 것으로 본다', async () => {
    await run({ name: '   ' })
    expect(create.mock.calls[0][1]).not.toHaveProperty('name')
  })

  it('새 브랜치가 갈라진 base 를 알려 준다', async () => {
    await expect(run()).resolves.toMatchObject({
      workspaceId: 'ws-new',
      branch: 'feat/next',
      baseBranch: 'feat/base'
    })
  })

  it('미커밋 변경이 있으면 거부하고 워크스페이스를 만들지 않는다', async () => {
    clean.mockResolvedValue(false)

    await expect(run()).rejects.toThrow(/uncommitted changes/)
    expect(create).not.toHaveBeenCalled()
  })

  it('아카이브된 워크스페이스 위에는 쌓지 않는다', async () => {
    state.workspaces = [{ ...parent, archived: true }]

    await expect(run()).rejects.toThrow(/archived/)
    expect(create).not.toHaveBeenCalled()
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(run()).rejects.toThrow(/no longer exists/)
  })

  it('생성 실패는 도구 오류로 올린다', async () => {
    create.mockResolvedValue({ error: 'branch already exists' })
    await expect(run()).rejects.toThrow('branch already exists')
  })

  it('전달 실패는 생성을 막지 않지만 결과에 남긴다', async () => {
    create.mockResolvedValue({
      workspaceId: 'ws-new',
      branch: 'feat/next',
      carryFailures: [{ path: '.env', reason: 'missing', agentContext: false }]
    })

    await expect(run()).resolves.toMatchObject({
      workspaceId: 'ws-new',
      carryFailures: ['.env: missing']
    })
  })
})
