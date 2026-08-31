import { describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import { formatCacheRemaining, promptCacheExpiresAt } from './promptCache'

const NOW = 1_700_000_000_000

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    agentBackend: 'claude',
    sessionId: 'sess-1',
    status: 'idle',
    lastActiveAt: NOW,
    ...over
  } as Workspace
}

describe('promptCacheExpiresAt', () => {
  it('마지막 턴 시각에 백엔드 TTL 을 더한 값을 돌려준다', () => {
    expect(promptCacheExpiresAt(workspace())).toBe(NOW + 5 * 60_000)
  })

  it('세션이 없으면 표시하지 않는다 — 캐시에 들어간 프롬프트가 아직 없다', () => {
    // 갓 만든 워크스페이스는 lastActiveAt 이 생성 시각이라 이 가드가 없으면 타이머가 뜬다.
    expect(promptCacheExpiresAt(workspace({ sessionId: null }))).toBeNull()
  })

  it('도는 중에는 표시하지 않는다 — 캐시가 지금 새로 쓰이는 중이라 셀 것이 정해지지 않았다', () => {
    expect(promptCacheExpiresAt(workspace({ status: 'running' }))).toBeNull()
  })

  it('에러로 끝난 턴에도 캐시는 남아 있으므로 계속 센다', () => {
    expect(promptCacheExpiresAt(workspace({ status: 'error' }))).toBe(NOW + 5 * 60_000)
  })

  it('백엔드마다 자기 TTL 을 쓴다', () => {
    expect(promptCacheExpiresAt(workspace({ agentBackend: 'codex' }))).toBe(NOW + 5 * 60_000)
  })
})

describe('formatCacheRemaining', () => {
  it('분:초로 적는다 — 5분짜리 창을 분 단위로만 보여 주면 절반이 "<1m" 에 몰린다', () => {
    expect(formatCacheRemaining(4 * 60_000 + 7_000)).toBe('4:07')
    expect(formatCacheRemaining(59_000)).toBe('0:59')
  })

  it('초는 올림한다 — 남은 1초가 0:00 으로 보이면 이미 식은 것처럼 읽힌다', () => {
    expect(formatCacheRemaining(1)).toBe('0:01')
  })
})
