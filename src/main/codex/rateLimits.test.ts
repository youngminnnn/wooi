import { describe, expect, it } from 'vitest'
import { durationLabel } from './rateLimits'

describe('Codex rate-limit window labels', () => {
  it('app-server가 준 실제 분 단위를 사용한다', () => {
    expect(durationLabel(300, 'Primary')).toBe('5-hour')
    expect(durationLabel(1_440, 'Primary')).toBe('1-day')
    expect(durationLabel(10_080, 'Secondary')).toBe('Weekly')
  })

  it('기간이 없을 때만 의미를 추측하지 않고 fallback을 쓴다', () => {
    expect(durationLabel(undefined, 'Primary')).toBe('Primary')
  })
})
