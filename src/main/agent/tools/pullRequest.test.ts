import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentToolDeps } from './registry'
import type { Repo, Workspace } from '@shared/types'

/**
 * PR 을 여는 도구에서 지켜야 할 것.
 *
 * base 를 **모델이 고르지 않는다** 는 것이 이 기능의 전부다. 스택 자식이면 부모 브랜치로,
 * 아니면 리포 기본 브랜치로 간다. 이 판정이 무너지면 예전처럼 PR 이 기본 브랜치를 향하고,
 * 앱이 사후에 배너로 수습하는 상태로 돌아간다.
 */

const originHasBranch = vi.hoisted(() => vi.fn())
const pushCurrentBranch = vi.hoisted(() => vi.fn())
const countCommitsAhead = vi.hoisted(() => vi.fn())
const createPr = vi.hoisted(() => vi.fn())
const findOpenPrStatus = vi.hoisted(() => vi.fn())
const listOpenPrs = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[]
}))
const update = vi.hoisted(() =>
  vi.fn((fn: (st: { workspaces: Partial<Workspace>[] }) => void) => fn(state))
)

vi.mock('../../git', () => ({ originHasBranch, pushCurrentBranch, countCommitsAhead }))
vi.mock('../../github', () => ({ createPr, findOpenPrStatus, listOpenPrs }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update }) }))

const broadcastState = vi.fn()
const deps = { broadcastState } as unknown as AgentToolDeps

const repo: Partial<Repo> = { id: 'repo-1', defaultBranch: 'main' }

const parent: Partial<Workspace> = {
  id: 'ws-parent',
  repoId: 'repo-1',
  branch: 'feat/base',
  baseBranch: 'main',
  worktreePath: '/tmp/wt',
  parentWorkspaceId: null,
  archived: false,
  prNumber: null
}

const child: Partial<Workspace> = {
  id: 'ws-child',
  repoId: 'repo-1',
  branch: 'feat/next',
  // 일부러 어긋나게 둔다 — 잘못 열린 PR 의 base 가 여기에 덮어써진 상태를 흉내 낸다.
  baseBranch: 'main',
  worktreePath: '/tmp/wt-child',
  parentWorkspaceId: 'ws-parent',
  archived: false,
  prNumber: null
}

const ARGS = { title: 'Add the login form', body: 'It adds the form.' }

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...parent }, { ...child }]
  state.repos = [{ ...repo }]
  findOpenPrStatus.mockResolvedValue(null)
  listOpenPrs.mockResolvedValue([])
  originHasBranch.mockResolvedValue(true)
  pushCurrentBranch.mockResolvedValue({ ok: true, error: '' })
  countCommitsAhead.mockResolvedValue(2)
  createPr.mockResolvedValue({ pr: { number: 42, url: 'https://github.com/o/r/pull/42' } })
})

async function open(
  args: Record<string, unknown> = ARGS,
  from = 'ws-child'
): Promise<Record<string, unknown>> {
  const { openPullRequest } = await import('./pullRequest')
  return openPullRequest(deps, from, args) as Promise<Record<string, unknown>>
}

describe('open_pull_request 의 base 결정', () => {
  it('스택 자식이면 부모 브랜치를 base 로 쓴다', async () => {
    await expect(open()).resolves.toMatchObject({ base: 'feat/base' })

    expect(createPr).toHaveBeenCalledWith('/tmp/wt-child', {
      base: 'feat/base',
      title: 'Add the login form',
      body: 'It adds the form.',
      draft: false
    })
  })

  it('부모의 지금 브랜치를 읽는다 — 워크스페이스의 baseBranch 는 믿지 않는다', async () => {
    // 부모가 규칙에 맞게 브랜치 이름을 바꾼 상황. 자식의 baseBranch 는 아직 'main' 이다.
    state.workspaces = [{ ...parent, branch: 'feat/renamed' }, { ...child }]

    await expect(open()).resolves.toMatchObject({ base: 'feat/renamed' })
  })

  it('스택이 아니면 리포 기본 브랜치를 쓴다', async () => {
    await expect(open(ARGS, 'ws-parent')).resolves.toMatchObject({ base: 'main' })
  })

  it('base 는 인자로 받지 않는다 — 모델이 줘도 무시한다', async () => {
    await open({ ...ARGS, base: 'some/other-branch' })

    expect(createPr.mock.calls[0][1]).toMatchObject({ base: 'feat/base' })
  })
})

describe('open_pull_request', () => {
  it('PR 번호와 URL 을 돌려주고 store 에 반영한다', async () => {
    await expect(open()).resolves.toMatchObject({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      base: 'feat/base',
      draft: false
    })

    expect(state.workspaces.find((w) => w.id === 'ws-child')?.prNumber).toBe(42)
    expect(broadcastState).toHaveBeenCalled()
  })

  it('draft 를 그대로 넘긴다', async () => {
    await expect(open({ ...ARGS, draft: true })).resolves.toMatchObject({ draft: true })
    expect(createPr.mock.calls[0][1]).toMatchObject({ draft: true })
  })

  it('리모트에 브랜치가 없으면 먼저 push 한다', async () => {
    originHasBranch.mockResolvedValue(false)

    await open()

    expect(pushCurrentBranch).toHaveBeenCalledWith('/tmp/wt-child')
    expect(createPr).toHaveBeenCalled()
  })

  it('이미 올라가 있으면 push 하지 않는다', async () => {
    await open()
    expect(pushCurrentBranch).not.toHaveBeenCalled()
  })

  it('push 가 막히면 그 메시지를 그대로 올린다 — 모델이 읽고 고쳐야 한다', async () => {
    originHasBranch.mockResolvedValue(false)
    pushCurrentBranch.mockResolvedValue({
      ok: false,
      error: 'branch name must match <type>/<description>'
    })

    await expect(open()).rejects.toThrow('branch name must match <type>/<description>')
    expect(createPr).not.toHaveBeenCalled()
  })

  it('base 와 차이가 없으면 거절한다', async () => {
    countCommitsAhead.mockResolvedValue(0)

    await expect(open()).rejects.toThrow(/nothing to review/)
    expect(createPr).not.toHaveBeenCalled()
  })

  it('셀 수 없으면(null) 막지 않는다', async () => {
    countCommitsAhead.mockResolvedValue(null)
    await expect(open()).resolves.toMatchObject({ number: 42 })
  })

  it('이미 열린 PR 이 있으면 새로 만들지 않고 그것을 돌려준다', async () => {
    findOpenPrStatus.mockResolvedValue({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 'Existing',
      state: 'draft',
      label: 'Draft'
    })
    listOpenPrs.mockResolvedValue([{ number: 7, head: 'feat/next', base: 'feat/base' }])

    await expect(open()).resolves.toMatchObject({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      base: 'feat/base',
      draft: true,
      note: expect.any(String)
    })
    expect(createPr).not.toHaveBeenCalled()
    expect(pushCurrentBranch).not.toHaveBeenCalled()
  })

  it('제목이나 본문이 비면 거절한다', async () => {
    await expect(open({ title: '  ', body: 'x' })).rejects.toThrow(/title is empty/)
    await expect(open({ title: 'x', body: '  ' })).rejects.toThrow(/body is empty/)
    expect(createPr).not.toHaveBeenCalled()
  })

  it('생성 실패는 도구 오류로 올린다', async () => {
    createPr.mockResolvedValue({ error: 'a pull request already exists' })

    await expect(open()).rejects.toThrow('a pull request already exists')
    expect(state.workspaces.find((w) => w.id === 'ws-child')?.prNumber).toBeNull()
  })

  it('아카이브된 워크스페이스에서는 열지 않는다', async () => {
    state.workspaces = [{ ...parent }, { ...child, archived: true }]

    await expect(open()).rejects.toThrow(/archived/)
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(open()).rejects.toThrow(/no longer exists/)
  })
})
