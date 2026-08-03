import { describe, expect, it } from 'vitest'
import { pickEvictableSessions } from './orchestrator'

/**
 * 세션 정리는 메모리를 줄이자고 하는 일인데, 잘못 고르면 사용자가 쓰고 있던 대화가 끊긴다.
 * 그래서 "무엇을 고르지 **않는가**" 쪽이 규칙의 핵심이다.
 */
describe('pickEvictableSessions', () => {
  const MIN = 60_000
  const now = 10_000_000
  /** 정리 후보가 되기 충분히 오래된 시각. */
  const old = (n: number): number => now - MIN - n * 1000

  const map = (entries: [string, number][]): Map<string, number> => new Map(entries)

  it('상한 이하면 아무것도 고르지 않는다', () => {
    const lastUsedAt = map([
      ['a', old(3)],
      ['b', old(2)]
    ])
    expect(
      pickEvictableSessions({ lastUsedAt, running: new Set(), now, max: 2, minIdleMs: MIN })
    ).toEqual([])
  })

  it('초과분만큼만, 오래 안 쓴 것부터 고른다', () => {
    const lastUsedAt = map([
      ['recent', old(1)],
      ['oldest', old(5)],
      ['middle', old(3)]
    ])
    expect(
      pickEvictableSessions({ lastUsedAt, running: new Set(), now, max: 1, minIdleMs: MIN })
    ).toEqual(['oldest', 'middle'])
  })

  it('실행 중인 세션은 아무리 오래돼도 고르지 않는다', () => {
    const lastUsedAt = map([
      ['running', old(9)],
      ['idle', old(2)]
    ])
    const picked = pickEvictableSessions({
      lastUsedAt,
      running: new Set(['running']),
      now,
      max: 1,
      minIdleMs: MIN
    })
    expect(picked).toEqual(['idle'])
  })

  it('방금 쓴 세션은 고르지 않는다', () => {
    const lastUsedAt = map([
      ['justUsed', now - 1000],
      ['alsoJustUsed', now - 2000]
    ])
    expect(
      pickEvictableSessions({ lastUsedAt, running: new Set(), now, max: 1, minIdleMs: MIN })
    ).toEqual([])
  })

  /**
   * 상한은 목표치이지 강제 한도가 아니다 — 전부 실행 중이면 넘긴 채로 두는 것이 맞다.
   * 여기서 억지로 하나를 끊으면 돌고 있던 작업이 끊긴다.
   */
  it('후보가 없으면 상한을 넘겨도 아무것도 고르지 않는다', () => {
    const lastUsedAt = map([
      ['a', old(9)],
      ['b', old(8)],
      ['c', old(7)]
    ])
    expect(
      pickEvictableSessions({
        lastUsedAt,
        running: new Set(['a', 'b', 'c']),
        now,
        max: 1,
        minIdleMs: MIN
      })
    ).toEqual([])
  })
})
