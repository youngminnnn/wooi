import { describe, it, expect } from 'vitest'
import { buildStackFromPrs, detectBaseMismatch } from './stack'

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
