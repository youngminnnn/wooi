import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetContextUsage,
  getCachedContextUsage,
  isCompacting,
  rememberCompacting,
  rememberContextUsage
} from './contextUsageCache'

afterEach(() => {
  forgetContextUsage('ws-1')
})

/**
 * 반환값이 그냥 편의가 아니다 — 이 값이 원격 상태 발행을 켠다(main/index 의 mirrorToRemote).
 * 매번 true 를 주면 델타가 지나갈 때마다 미러가 깨어나고, 매번 false 를 주면 폰의 게이지가 멈춘다.
 */
describe('rememberContextUsage', () => {
  it('처음 보는 워크스페이스와 값이 바뀐 갱신에만 true 를 준다', () => {
    expect(rememberContextUsage('ws-1', { usedTokens: 10, maxTokens: 100, percentage: 0.1 })).toBe(
      true
    )
    expect(rememberContextUsage('ws-1', { usedTokens: 10, maxTokens: 100, percentage: 0.1 })).toBe(
      false
    )
    expect(rememberContextUsage('ws-1', { usedTokens: 20, maxTokens: 100, percentage: 0.2 })).toBe(
      true
    )
    expect(getCachedContextUsage('ws-1')).toEqual({
      usedTokens: 20,
      maxTokens: 100,
      percentage: 0.2
    })
  })
})

describe('rememberCompacting', () => {
  it('상태가 실제로 바뀔 때만 true 를 준다', () => {
    expect(rememberCompacting('ws-1', false)).toBe(false)
    expect(rememberCompacting('ws-1', true)).toBe(true)
    expect(rememberCompacting('ws-1', true)).toBe(false)
    expect(isCompacting('ws-1')).toBe(true)
    expect(rememberCompacting('ws-1', false)).toBe(true)
    expect(isCompacting('ws-1')).toBe(false)
  })
})

describe('forgetContextUsage', () => {
  it('맥락이 처음부터 다시 시작할 때 사용량과 압축 상태를 함께 지운다', () => {
    rememberContextUsage('ws-1', { usedTokens: 10, maxTokens: 100, percentage: 0.1 })
    rememberCompacting('ws-1', true)

    forgetContextUsage('ws-1')

    expect(getCachedContextUsage('ws-1')).toBeUndefined()
    expect(isCompacting('ws-1')).toBe(false)
  })
})
