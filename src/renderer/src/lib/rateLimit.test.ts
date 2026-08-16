import { describe, expect, it } from 'vitest'
import { RATE_LIMIT_STALE_AFTER_MS, RATE_LIMIT_WARN_THRESHOLD } from '@shared/types'
import type { RateLimitSnapshot } from '@shared/types'
import {
  agoLabel,
  headlineWindows,
  isStale,
  isWarning,
  normalizeUtilization,
  resetLabel,
  shouldShowRateLimits,
  statusWindow,
  tightestWindow
} from './rateLimit'

const win = (
  label: string,
  utilization: number | null,
  resetsAt: string | null = null
): RateLimitSnapshot['windows'][number] => ({ label, utilization, resetsAt })

const snapshot = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  fetchedAt: 1_000_000,
  available: true,
  subscriptionType: 'max',
  windows: [win('5-hour', 42)],
  ...over
})

describe('tightestWindow', () => {
  it('가장 많이 소진된 창을 고른다', () => {
    const picked = tightestWindow([win('5-hour', 12), win('7-day', 91), win('7-day (Opus)', 40)])
    expect(picked?.label).toBe('7-day')
  })

  it('utilization 이 null 인 창은 후보에서 제외한다', () => {
    // null 을 0 으로 취급해 최대치 비교에 끼워 넣으면, 값이 있는 창을 가릴 수 있다.
    const picked = tightestWindow([win('7-day (Opus)', null), win('5-hour', 3)])
    expect(picked?.label).toBe('5-hour')
  })

  it('값이 있는 창이 하나도 없으면 null', () => {
    expect(tightestWindow([win('5-hour', null)])).toBeNull()
    expect(tightestWindow([])).toBeNull()
  })
})

describe('headlineWindows', () => {
  it('상태줄과 Overview 가 같은 창을 대표로 쓴다', () => {
    // 실제로 어긋났던 값: 5시간 4%, 주간 78% 인 계정에서 상태줄은 4%, Overview 는 78% 였다.
    const windows = [win('5-hour', 4), win('7-day', 78), win('7-day (Fable)', 6)]
    expect(headlineWindows('claude', windows).shown?.label).toBe('5-hour')
  })

  it('대표 창보다 뜨거운 창이 경고선을 넘으면 hotter 로 알린다', () => {
    const { shown, hotter } = headlineWindows('claude', [win('5-hour', 4), win('7-day', 91)])
    expect(shown?.label).toBe('5-hour')
    expect(hotter?.label).toBe('7-day')
  })

  it('다른 창이 경고선 아래면 hotter 는 없다', () => {
    // 78% 는 임계치(80%) 아래 — 대표 창보다 높다는 이유만으로 경고를 켜지 않는다.
    expect(headlineWindows('claude', [win('5-hour', 4), win('7-day', 78)]).hotter).toBeNull()
  })

  it('대표 창이 곧 가장 뜨거운 창이면 hotter 는 없다', () => {
    expect(headlineWindows('claude', [win('5-hour', 95), win('7-day', 30)]).hotter).toBeNull()
  })

  it('보여 줄 창이 없으면 둘 다 null', () => {
    expect(headlineWindows('claude', [])).toEqual({ shown: null, hotter: null })
  })
})

describe('statusWindow', () => {
  it('Claude 는 사용률과 무관하게 항상 5시간 세션 창을 보여 준다', () => {
    const windows = [win('5-hour', 12), win('7-day', 91), win('7-day (Opus)', 40)]
    expect(statusWindow('claude', windows)?.label).toBe('5-hour')
    // 순서가 바뀌거나 세션 창이 가장 뜨거워도 같은 창이어야 한다.
    expect(statusWindow('claude', [win('7-day', 3), win('5-hour', 99)])?.label).toBe('5-hour')
  })

  it('Codex 는 5시간 창이 있어도 주간 창을 보여 준다', () => {
    expect(statusWindow('codex', [win('5-hour', 88), win('Weekly', 12)])?.label).toBe('Weekly')
    expect(statusWindow('codex', [win('5-hour', 88), win('2-week', 12)])?.label).toBe('2-week')
  })

  it('정해 둔 창이 없으면 가장 많이 소진된 창으로 폴백한다', () => {
    // 창 이름이 기대와 다른 응답에서도 빈 자리를 남기지 않는다.
    expect(statusWindow('codex', [win('Primary', 10), win('Secondary', 44)])?.label).toBe(
      'Secondary'
    )
    expect(statusWindow('claude', [win('7-day', 44), win('7-day (Opus)', 60)])?.label).toBe(
      '7-day (Opus)'
    )
  })

  it('사용률이 없는 창은 고르지 않는다', () => {
    // 5시간 창 값이 비었다고 0% 를 보여 주느니, 값이 있는 창으로 폴백한다.
    expect(statusWindow('claude', [win('5-hour', null), win('7-day', 30)])?.label).toBe('7-day')
    expect(statusWindow('claude', [win('5-hour', null)])).toBeNull()
    expect(statusWindow('codex', [])).toBeNull()
  })
})

describe('normalizeUtilization', () => {
  it('0–100 범위로 자르고 반올림한다', () => {
    expect(normalizeUtilization(42.4)).toBe(42)
    expect(normalizeUtilization(120)).toBe(100)
    expect(normalizeUtilization(-5)).toBe(0)
  })

  it('null 은 null 로 통과시킨다(0% 로 둔갑시키지 않는다)', () => {
    expect(normalizeUtilization(null)).toBeNull()
  })
})

describe('isWarning', () => {
  it('임계치 초과에서만 경고다 — 정확히 임계치면 아직 아니다', () => {
    expect(isWarning(RATE_LIMIT_WARN_THRESHOLD)).toBe(false)
    expect(isWarning(RATE_LIMIT_WARN_THRESHOLD + 1)).toBe(true)
  })

  it('null 은 경고가 아니다', () => {
    expect(isWarning(null)).toBe(false)
  })
})

describe('isStale', () => {
  it('임계 시간을 넘겨야 stale 이다', () => {
    const snap = snapshot({ fetchedAt: 0 })
    expect(isStale(snap, RATE_LIMIT_STALE_AFTER_MS)).toBe(false)
    expect(isStale(snap, RATE_LIMIT_STALE_AFTER_MS + 1)).toBe(true)
  })
})

describe('shouldShowRateLimits', () => {
  it('스냅샷이 없으면 숨긴다(첫 조회 전 깜빡임 방지)', () => {
    expect(shouldShowRateLimits(undefined)).toBe(false)
  })

  it('API 키 사용자(available=false)에게는 완전히 숨긴다', () => {
    // 0% 나 "N/A" 를 보여 주면 안 된다 — 요금제 한도 자체가 없는 사용자다.
    expect(shouldShowRateLimits(snapshot({ available: false }))).toBe(false)
  })

  it('available 이어도 사용률 있는 창이 없으면 숨긴다', () => {
    expect(shouldShowRateLimits(snapshot({ windows: [win('5-hour', null)] }))).toBe(false)
    expect(shouldShowRateLimits(snapshot({ windows: [] }))).toBe(false)
  })

  it('요금제 사용자면 보여 준다', () => {
    expect(shouldShowRateLimits(snapshot())).toBe(true)
  })
})

describe('agoLabel', () => {
  it('분/시/일 단위로 줄여 쓴다', () => {
    expect(agoLabel(30_000)).toBe('just now')
    expect(agoLabel(5 * 60_000)).toBe('5m ago')
    expect(agoLabel(3 * 3600_000)).toBe('3h ago')
    expect(agoLabel(2 * 24 * 3600_000)).toBe('2d ago')
  })
})

describe('resetLabel', () => {
  const now = Date.parse('2026-07-29T12:00:00Z')

  it('남은 시간을 시/분으로 표시한다', () => {
    expect(resetLabel('2026-07-29T14:10:00Z', now)).toBe('2h 10m')
    expect(resetLabel('2026-07-29T12:45:00Z', now)).toBe('45m')
    expect(resetLabel('2026-07-29T15:00:00Z', now)).toBe('3h')
  })

  it('이미 지난 리셋 시각은 표시하지 않는다', () => {
    // 곧 새 값으로 갱신될 창이라 "-5m" 같은 음수를 보여 주면 안 된다.
    expect(resetLabel('2026-07-29T11:00:00Z', now)).toBeNull()
  })

  it('없거나 파싱 불가한 값은 null', () => {
    expect(resetLabel(null, now)).toBeNull()
    expect(resetLabel('not-a-date', now)).toBeNull()
  })
})
