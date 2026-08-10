import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentToolDeps } from './registry'
import type { Workspace } from '@shared/types'

/**
 * 형제 워크스페이스와의 충돌을 **미리** 알아내는 도구.
 *
 * 지켜야 할 것: 자기 자신과 다른 리포는 절대 섞이지 않을 것, relation 판정이 맞을 것,
 * 그리고 상한이 실제로 걸릴 것. 마지막이 중요하다 — 워크스페이스가 많고 각자 수백 개 파일을
 * 건드리는 상황에서 상한이 새면 이 도구 한 번이 컨텍스트를 통째로 먹는다.
 */

const listChangedPaths = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))

vi.mock('../../git', () => ({ listChangedPaths }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update: vi.fn() }) }))

const deps = {} as unknown as AgentToolDeps

function ws(over: Partial<Workspace>): Partial<Workspace> {
  return {
    repoId: 'repo-1',
    name: over.id,
    displayName: null,
    baseBranch: 'main',
    parentWorkspaceId: null,
    archived: false,
    status: 'idle',
    worktreePath: `/tmp/${over.id}`,
    ...over
  }
}

const me = ws({ id: 'ws-me', branch: 'feat/mine' })

/** 워크트리 경로별로 다른 목록을 돌려준다. */
function pathsBy(map: Record<string, string[]>): void {
  listChangedPaths.mockImplementation(async (worktreePath: string) => map[worktreePath] ?? [])
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...me }]
  listChangedPaths.mockResolvedValue([])
})

async function check(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { checkRelatedWork } = await import('./relatedWork')
  return checkRelatedWork(deps, 'ws-me', args) as Promise<Record<string, unknown>>
}

describe('check_related_work 의 대상 선정', () => {
  it('자기 자신은 빠진다', async () => {
    const result = (await check()) as { workspaces: unknown[] }
    expect(result.workspaces).toHaveLength(0)
  })

  it('다른 리포의 워크스페이스는 빠진다', async () => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-other', branch: 'x', repoId: 'repo-2' })]

    const result = (await check()) as { workspaces: unknown[] }
    expect(result.workspaces).toHaveLength(0)
  })

  it('아카이브된 워크스페이스는 빠진다', async () => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-old', branch: 'y', archived: true })]

    const result = (await check()) as { workspaces: unknown[] }
    expect(result.workspaces).toHaveLength(0)
  })

  it('아무도 없으면 그렇다고 말해 준다', async () => {
    await expect(check()).resolves.toMatchObject({ workspaces: [], note: expect.any(String) })
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(check()).rejects.toThrow(/no longer exists/)
  })
})

describe('check_related_work 의 relation 판정', () => {
  it('부모·자식·형제를 구분한다', async () => {
    state.workspaces = [
      { ...me, parentWorkspaceId: 'ws-parent' },
      ws({ id: 'ws-parent', branch: 'feat/base' }),
      ws({ id: 'ws-child', branch: 'feat/next', parentWorkspaceId: 'ws-me' }),
      ws({ id: 'ws-sibling', branch: 'feat/other' })
    ]

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }
    const byId = new Map(result.workspaces.map((w) => [w.workspaceId, w.relation]))

    expect(byId.get('ws-parent')).toBe('parent')
    expect(byId.get('ws-child')).toBe('child')
    expect(byId.get('ws-sibling')).toBe('sibling')
  })

  it('형제의 자식(조카)은 형제로 본다 — 나와 스택 관계가 없다', async () => {
    state.workspaces = [
      { ...me },
      ws({ id: 'ws-nephew', branch: 'feat/n', parentWorkspaceId: 'ws-sibling' })
    ]

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }
    expect(result.workspaces[0].relation).toBe('sibling')
  })
})

/**
 * 이 목록이 모델이 다른 워크스페이스의 id 를 보는 유일한 곳이라, 대상을 받는 도구가 무엇을
 * 받아 주는지도 여기서 읽혀야 한다([[agent/tools/target]]).
 */
describe('check_related_work 의 생성자 표시', () => {
  it('자기가 만든 워크스페이스만 표시한다 — 스택이든 아니든', async () => {
    state.workspaces = [
      { ...me },
      ws({
        id: 'ws-stacked',
        branch: 'a',
        parentWorkspaceId: 'ws-me',
        createdByWorkspaceId: 'ws-me'
      }),
      ws({ id: 'ws-indep', branch: 'b', createdByWorkspaceId: 'ws-me' }),
      ws({ id: 'ws-theirs', branch: 'c', createdByWorkspaceId: 'ws-someone' })
    ]

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }
    const byId = new Map(result.workspaces.map((w) => [w.workspaceId, w.createdByYou]))

    expect(byId.get('ws-stacked')).toBe(true)
    expect(byId.get('ws-indep')).toBe(true)
    // 남의 것에는 아예 싣지 않는다 — 없는 것이 곧 "네 것이 아니다" 다.
    expect(byId.get('ws-theirs')).toBeUndefined()
  })

  // relation 으로는 알 수 없다는 것이 이 필드가 있는 이유다.
  it('사람이 만든 자식은 child 이지만 내 것이 아니다', async () => {
    state.workspaces = [
      { ...me },
      ws({ id: 'ws-child', branch: 'a', parentWorkspaceId: 'ws-me', createdByWorkspaceId: null })
    ]

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }
    expect(result.workspaces[0].relation).toBe('child')
    expect(result.workspaces[0].createdByYou).toBeUndefined()
  })
})

describe('check_related_work 의 겹침', () => {
  beforeEach(() => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-sib', branch: 'feat/other', status: 'running' })]
  })

  it('겹친 경로를 따로 모아 준다 — 모델이 목록을 대조하게 두지 않는다', async () => {
    pathsBy({
      '/tmp/ws-me': ['src/a.ts', 'src/b.ts'],
      '/tmp/ws-sib': ['src/b.ts', 'src/c.ts']
    })

    const result = (await check()) as { overlaps: Array<Record<string, unknown>> }

    expect(result.overlaps).toHaveLength(1)
    expect(result.overlaps[0]).toMatchObject({
      workspaceId: 'ws-sib',
      branch: 'feat/other',
      relation: 'sibling',
      paths: ['src/b.ts']
    })
  })

  it('겹치지 않으면 overlaps 는 비어 있다', async () => {
    pathsBy({ '/tmp/ws-me': ['src/a.ts'], '/tmp/ws-sib': ['src/z.ts'] })

    const result = (await check()) as { overlaps: unknown[]; workspaces: unknown[] }
    expect(result.overlaps).toHaveLength(0)
    expect(result.workspaces).toHaveLength(1)
  })

  // 겹침을 찾고도 그냥 편집을 이어가면 부른 보람이 없다. 남의 diff 는 볼 수 없으니 판단은
  // 사람 몫이라는 것까지 결과에 실린다.
  it('겹치면 사람에게 말하라고 결과에 적어 준다', async () => {
    pathsBy({ '/tmp/ws-me': ['src/b.ts'], '/tmp/ws-sib': ['src/b.ts'] })

    const result = (await check()) as { note: string }
    expect(result.note).toMatch(/1 other workspace/)
    expect(result.note).toMatch(/Tell the user/)
  })

  it('겹치지 않으면 겹치지 않는다고 말해 준다 — 빈 overlaps 를 해석하게 두지 않는다', async () => {
    pathsBy({ '/tmp/ws-me': ['src/a.ts'], '/tmp/ws-sib': ['src/z.ts'] })

    const result = (await check()) as { note: string }
    expect(result.note).toMatch(/Nothing you are changing/)
  })

  it('내가 아직 아무것도 안 고쳤으면 겹침 안내 대신 그 사실을 말해 준다', async () => {
    pathsBy({ '/tmp/ws-me': [], '/tmp/ws-sib': ['src/b.ts'] })

    const result = (await check()) as { note: string }
    expect(result.note).toMatch(/has not changed anything yet/)
  })

  it('paths 인자를 주면 아직 고치지 않은 파일로도 물어볼 수 있다', async () => {
    pathsBy({ '/tmp/ws-me': [], '/tmp/ws-sib': ['src/router.ts'] })

    const result = (await check({ paths: ['src/router.ts'] })) as {
      overlaps: Array<Record<string, unknown>>
    }

    expect(result.overlaps[0]).toMatchObject({ paths: ['src/router.ts'] })
    // 내 워크트리는 조회하지 않는다 — 인자가 곧 기준이다.
    expect(listChangedPaths).not.toHaveBeenCalledWith('/tmp/ws-me', 'main')
  })

  it('running 여부를 함께 준다 — 목록이 곧 낡는다는 신호다', async () => {
    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }
    expect(result.workspaces[0].running).toBe(true)
  })

  it('한 워크스페이스의 조회가 실패해도 나머지는 나온다', async () => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-a', branch: 'a' }), ws({ id: 'ws-b', branch: 'b' })]
    listChangedPaths.mockImplementation(async (p: string) => {
      if (p === '/tmp/ws-a') throw new Error('worktree is gone')
      return ['src/x.ts']
    })

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }

    expect(result.workspaces).toHaveLength(2)
    expect(result.workspaces.find((w) => w.workspaceId === 'ws-a')?.changedPaths).toEqual([])
  })
})

describe('check_related_work 의 상한', () => {
  it('워크스페이스당 경로 50 개에서 자르고 남은 개수를 알려 준다', async () => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-sib', branch: 'feat/other' })]
    pathsBy({
      '/tmp/ws-me': [],
      '/tmp/ws-sib': Array.from({ length: 130 }, (_, i) => `src/f${i}.ts`)
    })

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }

    expect(result.workspaces[0].changedPaths).toHaveLength(50)
    expect(result.workspaces[0].truncatedPaths).toBe(80)
  })

  it('워크스페이스 수도 자르되, 겹치는 쪽은 살아남는다', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ws({ id: `ws-${i}`, branch: `b${i}` }))
    state.workspaces = [{ ...me }, ...many]
    listChangedPaths.mockImplementation(async (p: string) =>
      p === '/tmp/ws-me' ? ['src/hot.ts'] : p === '/tmp/ws-29' ? ['src/hot.ts'] : ['src/cold.ts']
    )

    const result = (await check()) as {
      workspaces: Array<Record<string, unknown>>
      overlaps: Array<Record<string, unknown>>
      truncatedWorkspaces: number
    }

    expect(result.workspaces).toHaveLength(20)
    expect(result.truncatedWorkspaces).toBe(10)
    // 상한에 걸려 잘리는 쪽은 항상 덜 위험한 쪽이어야 한다.
    expect(result.workspaces[0].workspaceId).toBe('ws-29')
    expect(result.overlaps).toHaveLength(1)
  })

  it('상한 안이면 truncated 필드를 세우지 않는다', async () => {
    state.workspaces = [{ ...me }, ws({ id: 'ws-sib', branch: 'feat/other' })]
    pathsBy({ '/tmp/ws-me': ['src/a.ts'], '/tmp/ws-sib': ['src/b.ts'] })

    const result = (await check()) as { workspaces: Array<Record<string, unknown>> }

    expect(result).not.toHaveProperty('truncatedWorkspaces')
    expect(result.workspaces[0]).not.toHaveProperty('truncatedPaths')
  })
})
