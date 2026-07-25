import { describe, it, expect } from 'vitest'
import { buildStackFromPrs } from './stack'

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
