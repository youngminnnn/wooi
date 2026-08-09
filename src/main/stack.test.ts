import { describe, it, expect } from 'vitest'
import { buildStackFromPrs, detectArchiveSuggestion, detectBaseMismatch } from './stack'

type Pr = { number: number; head: string; base: string }

const none = new Set<string>()

describe('buildStackFromPrs', () => {
  it('returns null when the anchor branch has no PR', () => {
    const prs: Pr[] = [{ number: 1, head: 'a', base: 'main' }]
    expect(buildStackFromPrs('b', prs, none)).toBeNull()
  })

  it('returns null for a lone PR onto the default branch (not a stack)', () => {
    const prs: Pr[] = [{ number: 1, head: 'a', base: 'main' }]
    expect(buildStackFromPrs('a', prs, none)).toBeNull()
  })

  it('detects a linear 3-branch stack and orders it bottom→top', () => {
    const prs: Pr[] = [
      { number: 3, head: 'feat-3', base: 'feat-2' },
      { number: 1, head: 'feat-1', base: 'main' },
      { number: 2, head: 'feat-2', base: 'feat-1' }
    ]
    // anchor 를 top·middle·bottom 어디로 줘도 같은 스택을 복원한다.
    for (const anchor of ['feat-1', 'feat-2', 'feat-3']) {
      const stack = buildStackFromPrs(anchor, prs, none)
      expect(stack).not.toBeNull()
      expect(stack!.map((e) => e.branch)).toEqual(['feat-1', 'feat-2', 'feat-3'])
      expect(stack!.map((e) => e.baseBranch)).toEqual(['main', 'feat-1', 'feat-2'])
      expect(stack!.map((e) => e.prNumber)).toEqual([1, 2, 3])
    }
  })

  it('excludes branches owned by other workspaces (keeps model A separate)', () => {
    // other-1 은 다른 워크스페이스 소유 → 경계로 취급. anchor 의 base 가 거기라면 스택이 아님.
    const prs: Pr[] = [
      { number: 1, head: 'other-1', base: 'main' },
      { number: 2, head: 'mine', base: 'other-1' }
    ]
    expect(buildStackFromPrs('mine', prs, new Set(['other-1']))).toBeNull()
  })

  it('places a base before its dependents even with a branchy stack', () => {
    // feat-1 위에 feat-2a, feat-2b 두 자식이 갈라진 스택.
    const prs: Pr[] = [
      { number: 1, head: 'feat-1', base: 'main' },
      { number: 2, head: 'feat-2a', base: 'feat-1' },
      { number: 3, head: 'feat-2b', base: 'feat-1' }
    ]
    const stack = buildStackFromPrs('feat-2a', prs, none)
    expect(stack).not.toBeNull()
    const order = stack!.map((e) => e.branch)
    expect(order[0]).toBe('feat-1')
    expect(order).toContain('feat-2a')
    expect(order).toContain('feat-2b')
    expect(order.indexOf('feat-1')).toBeLessThan(order.indexOf('feat-2a'))
    expect(order.indexOf('feat-1')).toBeLessThan(order.indexOf('feat-2b'))
  })
})

describe('detectBaseMismatch', () => {
  const parent = 'feat-1'

  it('부모 위에 제대로 쌓인 PR 은 어긋남이 아니다', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: parent },
        parentBranch: parent,
        pendingSync: false,
        dismissed: null
      })
    ).toBeNull()
  })

  it('스택인데 PR 이 기본 브랜치를 향하면 어긋남으로 본다', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: 'main' },
        parentBranch: parent,
        pendingSync: false,
        dismissed: null
      })
    ).toEqual({ prNumber: 2, prBase: 'main', expectedBase: parent })
  })

  it('PR 이 아직 없으면 판정하지 않는다', () => {
    expect(
      detectBaseMismatch({
        headPr: null,
        parentBranch: parent,
        pendingSync: false,
        dismissed: null
      })
    ).toBeNull()
  })

  it('스택이 아니면(부모 없음) 판정하지 않는다', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: 'main' },
        parentBranch: null,
        pendingSync: false,
        dismissed: null
      })
    ).toBeNull()
  })

  it('부모 병합 캐스케이드가 대기 중이면 판정하지 않는다(그때는 조부모를 향하는 게 정상)', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: 'main' },
        parentBranch: parent,
        pendingSync: true,
        dismissed: null
      })
    ).toBeNull()
  })

  it('사용자가 그대로 두기로 한 base 는 다시 묻지 않는다', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: 'main' },
        parentBranch: parent,
        pendingSync: false,
        dismissed: 'main'
      })
    ).toBeNull()
  })

  it('그대로 두기로 한 base 와 또 다른 base 로 바뀌면 다시 묻는다', () => {
    expect(
      detectBaseMismatch({
        headPr: { number: 2, base: 'develop' },
        parentBranch: parent,
        pendingSync: false,
        dismissed: 'main'
      })
    ).toEqual({ prNumber: 2, prBase: 'develop', expectedBase: parent })
  })
})

describe('detectArchiveSuggestion', () => {
  const branch = 'feat/thing'
  /** 병합 조회 스텁 — 호출 여부까지 세어, 조건이 어긋났을 때 gh 를 부르지 않는지 확인한다. */
  const merged = (
    number: number | null = 42
  ): (() => Promise<{ number: number | null } | null>) & { calls: number } => {
    const fn = Object.assign(
      async () => {
        fn.calls++
        return { number }
      },
      { calls: 0 }
    )
    return fn
  }
  const notMerged = async (): Promise<null> => null

  const base = {
    branch,
    existing: null,
    branchStack: false,
    hasLiveChildren: false,
    pendingSync: false,
    dismissed: null,
    now: 1000
  }

  it('PR 이 병합됐고 걸리는 것이 없으면 제안한다', async () => {
    expect(await detectArchiveSuggestion({ ...base, lookupMerged: merged(42) })).toEqual({
      mergedBranch: branch,
      prNumber: 42,
      detectedAt: 1000
    })
  })

  it('PR 이 병합되지 않았으면 제안하지 않는다', async () => {
    expect(await detectArchiveSuggestion({ ...base, lookupMerged: notMerged })).toBeNull()
  })

  it('worktree 안에 브랜치 스택(모델 B)을 들고 있으면 제안하지 않는다', async () => {
    // 위에 남은 브랜치들이 계속 살아 있어서, 아카이브하면 나머지 작업이 통째로 사라진다.
    const look = merged()
    expect(
      await detectArchiveSuggestion({ ...base, branchStack: true, lookupMerged: look })
    ).toBeNull()
    expect(look.calls).toBe(0) // 조건이 어긋났으면 gh 도 부르지 않는다.
  })

  it('살아 있는 자식 워크스페이스가 있으면 제안하지 않는다', async () => {
    // 부모를 아카이브하면 재동기화가 즉시 return 해 자식들의 캐스케이드가 조용히 유실된다.
    const look = merged()
    expect(
      await detectArchiveSuggestion({ ...base, hasLiveChildren: true, lookupMerged: look })
    ).toBeNull()
    expect(look.calls).toBe(0)
  })

  it('캐스케이드가 대기 중이면 제안하지 않는다(그쪽 배너가 먼저다)', async () => {
    const look = merged()
    expect(
      await detectArchiveSuggestion({ ...base, pendingSync: true, lookupMerged: look })
    ).toBeNull()
    expect(look.calls).toBe(0)
  })

  it('해제한 뒤에는 같은 병합으로 다시 뜨지 않는다', async () => {
    const look = merged()
    expect(
      await detectArchiveSuggestion({ ...base, dismissed: branch, lookupMerged: look })
    ).toBeNull()
    expect(look.calls).toBe(0)
  })

  it('해제 뒤 다른 브랜치로 옮겨 가 병합되면 다시 제안한다', async () => {
    expect(
      await detectArchiveSuggestion({
        ...base,
        branch: 'feat/next',
        dismissed: branch,
        lookupMerged: merged(43)
      })
    ).toEqual({ mergedBranch: 'feat/next', prNumber: 43, detectedAt: 1000 })
  })

  it('이미 뜬 제안은 그대로 두고 다시 조회하지 않는다', async () => {
    const existing = { mergedBranch: branch, prNumber: 42, detectedAt: 1 }
    const look = merged()
    expect(await detectArchiveSuggestion({ ...base, existing, lookupMerged: look })).toBe(existing)
    expect(look.calls).toBe(0)
  })

  it('제안이 떠 있어도 자식이 생기면 거둔다', async () => {
    const existing = { mergedBranch: branch, prNumber: 42, detectedAt: 1 }
    expect(
      await detectArchiveSuggestion({
        ...base,
        existing,
        hasLiveChildren: true,
        lookupMerged: merged()
      })
    ).toBeNull()
  })

  it('필드가 없는(마이그레이션 전) 워크스페이스도 판정된다', async () => {
    // archiveSuggest·archiveSuggestDismissed 는 옵셔널이라 저장된 워크스페이스에는 아예 없다.
    expect(
      await detectArchiveSuggestion({
        ...base,
        existing: undefined,
        dismissed: undefined,
        lookupMerged: merged(7)
      })
    ).toEqual({ mergedBranch: branch, prNumber: 7, detectedAt: 1000 })
  })
})
