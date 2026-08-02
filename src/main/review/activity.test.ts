import { describe, it, expect } from 'vitest'
import type { GhIssueComment, GhReviewComment } from '../github'
import { detectNewActivity, type DetectActivityInput } from './activity'

function rc(over: Partial<GhReviewComment> & { id: number }): GhReviewComment {
  return {
    body: 'b',
    created_at: '2026-01-02T00:00:00Z',
    html_url: `https://gh/c/${over.id}`,
    user: { login: 'them' },
    ...over
  }
}

function ic(over: Partial<GhIssueComment> & { id: number }): GhIssueComment {
  return {
    body: 'b',
    created_at: '2026-01-02T00:00:00Z',
    html_url: `https://gh/i/${over.id}`,
    user: { login: 'them' },
    ...over
  }
}

function input(over: Partial<DetectActivityInput> = {}): DetectActivityInput {
  return {
    reviewComments: [],
    issueComments: [],
    headSha: 'aaa',
    postedCommentIds: [100],
    viewerLogin: 'me',
    since: '2026-01-01T00:00:00Z',
    lastSeenHeadSha: 'aaa',
    ...over
  }
}

describe('detectNewActivity — 인라인 답글', () => {
  it('내 코멘트 스레드의 답글을 잡는다', () => {
    const r = detectNewActivity(input({ reviewComments: [rc({ id: 1, in_reply_to_id: 100 })] }))
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ kind: 'reply', threadRootId: 100, commentId: 1 })
  })

  /** in_reply_to_id 는 항상 스레드 루트를 가리킨다 — 답글의 답글도 같은 루트를 가리킨다. */
  it('한 스레드의 답글이 여러 개여도 모두 잡는다', () => {
    const r = detectNewActivity(
      input({
        reviewComments: [
          rc({ id: 1, in_reply_to_id: 100, created_at: '2026-01-02T00:00:00Z' }),
          rc({ id: 2, in_reply_to_id: 100, created_at: '2026-01-03T00:00:00Z' })
        ]
      })
    )
    expect(r.items.map((i) => i.id)).toEqual(['reply-1', 'reply-2'])
  })

  it('내가 달지 않은 스레드의 답글은 무시한다', () => {
    const r = detectNewActivity(input({ reviewComments: [rc({ id: 1, in_reply_to_id: 999 })] }))
    expect(r.items).toEqual([])
  })

  it('최상위 코멘트(답글 아님)는 무시한다', () => {
    const r = detectNewActivity(
      input({ reviewComments: [rc({ id: 1, in_reply_to_id: null }), rc({ id: 2 })] })
    )
    expect(r.items).toEqual([])
  })

  /** 내가 단 답장이 "새 활동" 으로 되돌아오면 무한히 미확인 표시가 켜진다. */
  it('내 계정의 답글은 새 활동이 아니다', () => {
    const r = detectNewActivity(
      input({ reviewComments: [rc({ id: 1, in_reply_to_id: 100, user: { login: 'me' } })] })
    )
    expect(r.items).toEqual([])
  })

  it('워터마크보다 오래된 답글은 무시한다', () => {
    const r = detectNewActivity(
      input({
        since: '2026-01-05T00:00:00Z',
        reviewComments: [rc({ id: 1, in_reply_to_id: 100, created_at: '2026-01-02T00:00:00Z' })]
      })
    )
    expect(r.items).toEqual([])
    expect(r.nextSince).toBe('2026-01-05T00:00:00Z')
  })

  it('가장 최근 활동 시각으로 워터마크를 밀어 준다', () => {
    const r = detectNewActivity(
      input({
        reviewComments: [
          rc({ id: 1, in_reply_to_id: 100, created_at: '2026-01-02T00:00:00Z' }),
          rc({ id: 2, in_reply_to_id: 100, created_at: '2026-01-09T00:00:00Z' })
        ]
      })
    )
    expect(r.nextSince).toBe('2026-01-09T00:00:00Z')
  })

  /** diff 에서 밀려난 코멘트는 line 이 null 로 온다 — 위치를 통째로 잃지 않도록 폴백한다. */
  it('line 이 null 이면 original_line 으로 폴백한다', () => {
    const r = detectNewActivity(
      input({
        reviewComments: [
          rc({ id: 1, in_reply_to_id: 100, path: 'a.ts', line: null, original_line: 42 })
        ]
      })
    )
    expect(r.items[0]).toMatchObject({ path: 'a.ts', line: 42 })
  })
})

describe('detectNewActivity — 타임라인 코멘트', () => {
  /** issue 코멘트에는 스레딩이 없어 "내 지적에 대한 답" 을 특정할 수 없다. */
  it('기준 시각 이후의 남의 타임라인 코멘트를 잡되 스레드는 비운다', () => {
    const r = detectNewActivity(input({ issueComments: [ic({ id: 5 })] }))
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ kind: 'reply', threadRootId: null, commentId: 5 })
  })

  it('내 타임라인 코멘트는 새 활동이 아니다', () => {
    const r = detectNewActivity(input({ issueComments: [ic({ id: 5, user: { login: 'me' } })] }))
    expect(r.items).toEqual([])
  })
})

describe('detectNewActivity — 새 커밋', () => {
  it('head sha 가 바뀌면 알린다', () => {
    const r = detectNewActivity(input({ headSha: 'bbb', lastSeenHeadSha: 'aaa' }))
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ kind: 'commits', headSha: 'bbb' })
    expect(r.nextHeadSha).toBe('bbb')
  })

  it('같은 sha 면 알리지 않는다', () => {
    const r = detectNewActivity(input({ headSha: 'aaa', lastSeenHeadSha: 'aaa' }))
    expect(r.items).toEqual([])
    expect(r.nextHeadSha).toBe('aaa')
  })

  /** 조회 실패(null)를 "커밋 없음" 으로 오해해 sha 를 지워 버리면 다음 폴링이 오탐한다. */
  it('sha 를 못 받으면 기존 값을 지키고 아무것도 알리지 않는다', () => {
    const r = detectNewActivity(input({ headSha: null, lastSeenHeadSha: 'aaa' }))
    expect(r.items).toEqual([])
    expect(r.nextHeadSha).toBe('aaa')
  })
})

describe('detectNewActivity — 첫 폴링', () => {
  /** since 가 없으면(아직 아무것도 안 봤으면) 있는 것을 다 새 활동으로 본다. */
  it('워터마크가 없으면 남의 활동을 모두 잡는다', () => {
    const r = detectNewActivity(
      input({ since: null, reviewComments: [rc({ id: 1, in_reply_to_id: 100 })] })
    )
    expect(r.items).toHaveLength(1)
    expect(r.nextSince).toBe('2026-01-02T00:00:00Z')
  })
})
