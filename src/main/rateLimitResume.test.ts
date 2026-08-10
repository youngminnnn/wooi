import { describe, expect, it } from 'vitest'
import type { RateLimitSnapshot } from '@shared/types'
import { exhaustedResetTimes, retryTime } from './rateLimitResume'

const NOW = Date.parse('2026-08-10T00:00:00Z')

function snapshot(windows: RateLimitSnapshot['windows']): RateLimitSnapshot {
  return { fetchedAt: NOW, available: true, subscriptionType: 'pro', windows }
}

describe('rate-limit resume scheduling', () => {
  it('동시에 소진된 창이 여럿이면 가장 늦게 풀리는 창까지 기다린다', () => {
    const limits = snapshot([
      { label: '5-hour', utilization: 100, resetsAt: '2026-08-10T01:00:00Z' },
      { label: 'weekly', utilization: 100, resetsAt: '2026-08-11T00:00:00Z' }
    ])
    expect(exhaustedResetTimes(limits, NOW)).toHaveLength(2)
    expect(retryTime(limits, NOW)).toBe(Date.parse('2026-08-11T00:00:15Z'))
  })

  it('reset 정보를 얻지 못하면 5분 뒤에 다시 확인한다', () => {
    expect(retryTime(undefined, NOW)).toBe(NOW + 5 * 60_000 + 15_000)
  })

  it('100% 미만인 창은 제한으로 보지 않는다', () => {
    const limits = snapshot([
      { label: '5-hour', utilization: 99, resetsAt: '2026-08-10T01:00:00Z' }
    ])
    expect(exhaustedResetTimes(limits, NOW)).toEqual([])
  })
})
