import { describe, expect, it } from 'vitest'
import {
  hasMoreTranscriptHistory,
  nextTranscriptLimit,
  restoredScrollTop,
  TRANSCRIPT_INITIAL_LIMIT,
  TRANSCRIPT_PAGE
} from './transcriptPagination'

describe('nextTranscriptLimit', () => {
  it('한 페이지씩 창을 넓힌다', () => {
    expect(nextTranscriptLimit(TRANSCRIPT_INITIAL_LIMIT)).toBe(
      TRANSCRIPT_INITIAL_LIMIT + TRANSCRIPT_PAGE
    )
    expect(nextTranscriptLimit(nextTranscriptLimit(0))).toBe(TRANSCRIPT_PAGE * 2)
  })
})

describe('hasMoreTranscriptHistory', () => {
  it('요청한 만큼 꽉 채워 왔으면 더 있을 수 있다', () => {
    expect(hasMoreTranscriptHistory(300, 300)).toBe(true)
  })

  it('요청보다 적게 왔으면 대화의 머리에 닿은 것이다', () => {
    expect(hasMoreTranscriptHistory(299, 300)).toBe(false)
    expect(hasMoreTranscriptHistory(0, 300)).toBe(false)
  })

  it('빈 대화도 "더 없음" 이다 — 0개 요청은 오지 않는다', () => {
    expect(hasMoreTranscriptHistory(0, 0)).toBe(true)
    expect(hasMoreTranscriptHistory(0, 1)).toBe(false)
  })
})

describe('restoredScrollTop', () => {
  it('앞에 붙은 만큼 밀어 사용자가 보던 지점을 그대로 둔다', () => {
    expect(restoredScrollTop({ scrollHeight: 1000, scrollTop: 40 }, 3400)).toBe(2440)
  })

  it('자란 것이 없으면 그대로다', () => {
    expect(restoredScrollTop({ scrollHeight: 1000, scrollTop: 40 }, 1000)).toBe(40)
  })

  it('음수로 내려가지 않는다 — 줄어드는 경우에도 스크롤은 0 아래가 없다', () => {
    expect(restoredScrollTop({ scrollHeight: 1000, scrollTop: 40 }, 500)).toBe(0)
  })
})
