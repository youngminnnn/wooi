import { describe, it, expect } from 'vitest'
import { resolveStackForPr, resolveStackForWorkspace } from './stackResolve'
import type { GhStackEdge } from '../stack'
import type { StackedBranch, Workspace } from '@shared/types'

/**
 * 스택 멤버십은 이 파일을 통해서만 읽힌다([[review/stackResolve]]). 두 스택 모델과 "Wooi 밖에서
 * 만든 스택"이 **같은 모양**(아래→위 PR 번호 목록)으로 나오는지가 여기서 지켜야 할 계약이다.
 */

function workspace(over: Partial<Workspace> & Pick<Workspace, 'id' | 'branch'>): Workspace {
  return {
    repoId: 'repo1',
    name: over.branch,
    displayName: null,
    worktreePath: `/tmp/${over.id}`,
    baseBranch: 'main',
    parentWorkspaceId: null,
    prNumber: null,
    archived: false,
    stack: null,
    ...over
  } as Workspace
}

describe('resolveStackForPr (Wooi 밖에서 만든 스택)', () => {
  const prs = [
    { number: 12, head: 'feat/a', base: 'main' },
    { number: 13, head: 'feat/b', base: 'feat/a' },
    { number: 14, head: 'feat/c', base: 'feat/b' },
    // 스택과 무관한 PR — 링크가 닿지 않으므로 들어오면 안 된다.
    { number: 20, head: 'fix/z', base: 'main' }
  ]

  it('base→head 링크를 따라 아래→위로 복원한다', () => {
    expect(resolveStackForPr(13, prs).prNumbers).toEqual([12, 13, 14])
  })

  it('스택의 어느 층에서 시작해도 같은 스택이 나온다', () => {
    expect(resolveStackForPr(14, prs).prNumbers).toEqual([12, 13, 14])
    expect(resolveStackForPr(12, prs).prNumbers).toEqual([12, 13, 14])
  })

  it('무관한 PR 은 딸려 오지 않는다', () => {
    expect(resolveStackForPr(20, prs).prNumbers).toEqual([20])
  })

  /** 닫힌 PR·다른 리포의 PR 은 목록에 없다. 그때도 그 PR 하나는 리뷰할 수 있어야 한다. */
  it('열린 PR 목록에 없으면 그 PR 하나로 본다', () => {
    expect(resolveStackForPr(99, prs).prNumbers).toEqual([99])
  })
})

describe('resolveStackForWorkspace', () => {
  /** 모델 B — worktree 안 브랜치 스택. 엔트리 순서가 곧 아래→위다. */
  it('브랜치 스택을 엔트리 순서대로 돌려준다', () => {
    const stack: StackedBranch[] = [
      { branch: 'feat/a', baseBranch: 'main', prNumber: 12 },
      { branch: 'feat/b', baseBranch: 'feat/a', prNumber: 13 }
    ]
    const ws = workspace({ id: 'w1', branch: 'feat/b', stack, prNumber: 13 })
    expect(resolveStackForWorkspace(ws, [ws]).prNumbers).toEqual([12, 13])
  })

  /** PR 이 없는 층은 리뷰할 수 없다 — 조용히 빼면 스택 전체를 봤다고 착각한다. */
  it('PR 이 없는 브랜치는 따로 알려준다', () => {
    const stack: StackedBranch[] = [
      { branch: 'feat/a', baseBranch: 'main', prNumber: 12 },
      { branch: 'feat/b', baseBranch: 'feat/a', prNumber: null }
    ]
    const ws = workspace({ id: 'w1', branch: 'feat/b', stack })
    const out = resolveStackForWorkspace(ws, [ws])
    expect(out.prNumbers).toEqual([12])
    expect(out.branchesWithoutPr).toEqual(['feat/b'])
  })

  /** 모델 A — 부모-자식 워크스페이스 체인. orderByStack 이 부모 뒤에 자식을 놓는다. */
  it('워크스페이스 체인을 부모부터 돌려준다', () => {
    const a = workspace({ id: 'w1', branch: 'feat/a', prNumber: 12 })
    const b = workspace({ id: 'w2', branch: 'feat/b', parentWorkspaceId: 'w1', prNumber: 13 })
    const c = workspace({ id: 'w3', branch: 'feat/c', parentWorkspaceId: 'w2', prNumber: 14 })
    // 어느 멤버에서 물어도 같은 체인이 나와야 한다.
    expect(resolveStackForWorkspace(b, [a, b, c]).prNumbers).toEqual([12, 13, 14])
    expect(resolveStackForWorkspace(c, [c, a, b]).prNumbers).toEqual([12, 13, 14])
  })

  it('아카이브된 멤버는 제외한다', () => {
    const a = workspace({ id: 'w1', branch: 'feat/a', prNumber: 12 })
    const b = workspace({ id: 'w2', branch: 'feat/b', parentWorkspaceId: 'w1', prNumber: 13 })
    const gone = workspace({
      id: 'w3',
      branch: 'feat/c',
      parentWorkspaceId: 'w2',
      prNumber: 14,
      archived: true
    })
    expect(resolveStackForWorkspace(b, [a, b, gone]).prNumbers).toEqual([12, 13])
  })

  it('스택이 아니면 자기 PR 하나다', () => {
    const ws = workspace({ id: 'w1', branch: 'feat/a', prNumber: 12 })
    expect(resolveStackForWorkspace(ws, [ws]).prNumbers).toEqual([12])
  })

  it('다른 리포의 워크스페이스는 섞이지 않는다', () => {
    const a = workspace({ id: 'w1', branch: 'feat/a', prNumber: 12 })
    const other = workspace({
      id: 'w2',
      branch: 'feat/b',
      parentWorkspaceId: 'w1',
      prNumber: 13,
      repoId: 'repo2'
    })
    expect(resolveStackForWorkspace(a, [a, other]).prNumbers).toEqual([12])
  })
})

describe('resolveStackForPr — GitHub 스택 우선', () => {
  const entry = (
    position: number,
    prNumber: number,
    headRef: string,
    baseRef: string,
    state = 'OPEN'
  ): GhStackEdge => ({ position, prNumber, headRef, baseRef, state })

  const info = {
    baseRef: 'main',
    entries: [
      entry(1, 51, 'sr/1-currency', 'main'),
      entry(2, 52, 'sr/2-invoice', 'sr/1-currency'),
      entry(3, 53, 'sr/3-tax', 'sr/2-invoice')
    ]
  }

  it('GitHub 이 준 순서를 그대로 쓴다', () => {
    expect(resolveStackForPr(52, [], info).prNumbers).toEqual([51, 52, 53])
  })

  it('base 체인이 끊겨도 살아남는다 — 폴백이라면 놓치는 경우', () => {
    // 리타겟이 아직 안 밀려 2층 PR 의 base 가 main 을 가리키는 상태.
    const openPrs = [
      { number: 51, head: 'sr/1-currency', base: 'main' },
      { number: 52, head: 'sr/2-invoice', base: 'main' },
      { number: 53, head: 'sr/3-tax', base: 'sr/2-invoice' }
    ]
    // 폴백만 쓰면 1층이 떨어져 나간다.
    expect(resolveStackForPr(52, openPrs).prNumbers).toEqual([52, 53])
    // GitHub 이 알려 주면 position 순서가 이겨 세 층이 온전히 남는다.
    expect(resolveStackForPr(52, openPrs, info).prNumbers).toEqual([51, 52, 53])
  })

  it('병합된 레이어는 빠진다', () => {
    const merged = {
      baseRef: 'main',
      entries: [
        entry(1, 51, 'sr/1-currency', 'main', 'MERGED'),
        entry(2, 52, 'sr/2-invoice', 'sr/1-currency'),
        entry(3, 53, 'sr/3-tax', 'sr/2-invoice')
      ]
    }
    expect(resolveStackForPr(52, [], merged).prNumbers).toEqual([52, 53])
  })

  it('GitHub 스택에 그 PR 이 없으면 폴백으로 떨어진다', () => {
    const openPrs = [
      { number: 90, head: 'solo', base: 'main' },
      { number: 91, head: 'solo-2', base: 'solo' }
    ]
    expect(resolveStackForPr(91, openPrs, info).prNumbers).toEqual([90, 91])
  })

  it('스택이 없으면(null) 지금까지처럼 폴백만 돈다', () => {
    const openPrs = [{ number: 90, head: 'solo', base: 'main' }]
    expect(resolveStackForPr(90, openPrs, null).prNumbers).toEqual([90])
  })
})
