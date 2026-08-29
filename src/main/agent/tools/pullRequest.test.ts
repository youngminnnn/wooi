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
const renameLocalBranch = vi.hoisted(() => vi.fn())
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
// 판정(proposeBranchRename)은 진짜를 쓴다 — 여기서 검증하려는 것이 그 판정과 핸들러의 결합이다.
// git 을 실제로 부르는 부분만 갈아 끼운다.
vi.mock('../../branchNameFromWork', async (importActual) => ({
  ...(await importActual<typeof import('../../branchNameFromWork')>()),
  renameLocalBranch
}))

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
  renameLocalBranch.mockResolvedValue(undefined)
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

/**
 * 랜덤 브랜치 이름을 작업에 맞는 이름으로 바꾸는 경로.
 *
 * 이 기능에 이름을 짓는 모델 호출은 없다 — 재료는 이미 정해진 워크스페이스 이름 하나뿐이고,
 * 재료가 없으면 아무것도 하지 않는다. 그래서 검증할 것은 "언제 손대지 **않는가**" 가 대부분이다.
 */
describe('open_pull_request 의 브랜치 개명', () => {
  /** 아직 push 되지 않은, Wooi 가 지은 이름의 워크스페이스. */
  function 랜덤이름워크스페이스(overrides: Partial<Workspace> = {}): void {
    state.workspaces = [
      {
        ...parent,
        id: 'ws-random',
        branch: 'savvy-numbat',
        parentWorkspaceId: null,
        autoName: 'Branch name from work',
        ...overrides
      }
    ]
    originHasBranch.mockResolvedValue(false)
  }

  it('바로 바꾸지 않고 사용자에게 확인하라고 되돌려 보낸다', async () => {
    랜덤이름워크스페이스()

    await expect(open(ARGS, 'ws-random')).rejects.toThrow(/feat\/branch-name-from-work/)

    // 확인을 받기 전에는 이름도 안 바꾸고 push 도 하지 않는다.
    expect(renameLocalBranch).not.toHaveBeenCalled()
    expect(pushCurrentBranch).not.toHaveBeenCalled()
    expect(createPr).not.toHaveBeenCalled()
  })

  it('승인된 이름을 받으면 push 전에 바꾸고 store 를 맞춘다', async () => {
    랜덤이름워크스페이스()

    await expect(
      open({ ...ARGS, renameBranch: 'feat/branch-name-from-work' }, 'ws-random')
    ).resolves.toMatchObject({ branch: 'feat/branch-name-from-work' })

    expect(renameLocalBranch).toHaveBeenCalledWith(
      '/tmp/wt',
      'savvy-numbat',
      'feat/branch-name-from-work'
    )
    expect(state.workspaces[0].branch).toBe('feat/branch-name-from-work')
    // push 는 개명 뒤여야 한다 — 순서가 뒤집히면 원격에 랜덤 이름이 먼저 생긴다.
    expect(renameLocalBranch.mock.invocationCallOrder[0]).toBeLessThan(
      pushCurrentBranch.mock.invocationCallOrder[0]
    )
  })

  it('사용자가 고른 다른 이름을 그대로 따른다 — 우리 제안을 고집하지 않는다', async () => {
    랜덤이름워크스페이스()

    await expect(
      open({ ...ARGS, renameBranch: 'fix/push-name-drift' }, 'ws-random')
    ).resolves.toBeTruthy()

    expect(renameLocalBranch).toHaveBeenCalledWith('/tmp/wt', 'savvy-numbat', 'fix/push-name-drift')
  })

  it('빈 문자열은 "그대로 둬라" 다 — 되돌려 보내기가 반복되지 않는다', async () => {
    랜덤이름워크스페이스()

    await expect(open({ ...ARGS, renameBranch: '' }, 'ws-random')).resolves.toMatchObject({
      branch: 'savvy-numbat'
    })

    expect(renameLocalBranch).not.toHaveBeenCalled()
    expect(pushCurrentBranch).toHaveBeenCalled()
  })

  it('규칙에 어긋나는 이름은 거절한다 — push 가 훅에 막힐 이름을 새기지 않는다', async () => {
    랜덤이름워크스페이스()

    await expect(open({ ...ARGS, renameBranch: 'nonsense-name' }, 'ws-random')).rejects.toThrow(
      /branch name rule/
    )

    expect(renameLocalBranch).not.toHaveBeenCalled()
    expect(pushCurrentBranch).not.toHaveBeenCalled()
  })

  it('이미 규칙에 맞는 브랜치는 묻지도 바꾸지도 않는다', async () => {
    랜덤이름워크스페이스({ branch: 'feat/already-named' })

    await expect(open(ARGS, 'ws-random')).resolves.toBeTruthy()

    expect(renameLocalBranch).not.toHaveBeenCalled()
  })

  it('사람이 지은 이름은 규칙에 어긋나도 건드리지 않는다', async () => {
    랜덤이름워크스페이스({ branch: 'my-hand-typed-branch' })

    await expect(open(ARGS, 'ws-random')).resolves.toBeTruthy()

    expect(renameLocalBranch).not.toHaveBeenCalled()
  })

  it('이미 origin 에 있으면 건드리지 않는다', async () => {
    랜덤이름워크스페이스()
    originHasBranch.mockResolvedValue(true)

    await expect(open(ARGS, 'ws-random')).resolves.toBeTruthy()

    expect(renameLocalBranch).not.toHaveBeenCalled()
    // 이미 올라가 있으므로 push 도 다시 하지 않는다.
    expect(pushCurrentBranch).not.toHaveBeenCalled()
  })

  it('워크스페이스 이름이 없으면 아무것도 하지 않는다', async () => {
    // 이름을 지으려고 새 모델 호출을 만들지 않는다.
    랜덤이름워크스페이스({ autoName: null, displayName: null })

    await expect(open(ARGS, 'ws-random')).resolves.toBeTruthy()

    expect(renameLocalBranch).not.toHaveBeenCalled()
    expect(pushCurrentBranch).toHaveBeenCalled()
  })

  it('사용자가 직접 고친 이름이 에이전트 이름을 이긴다', async () => {
    랜덤이름워크스페이스({ displayName: 'Fix push name drift' })

    await expect(open(ARGS, 'ws-random')).rejects.toThrow(/fix\/push-name-drift/)
  })
})
