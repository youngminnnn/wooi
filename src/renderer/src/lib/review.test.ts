import { describe, it, expect } from 'vitest'
import type { PostedComment, ReviewFinding, ReviewSession } from '@shared/types'
import { emptyView, isPosted, selectionSummary, type ReviewViewState } from './review'

function posted(findingId: string, commentId: number): PostedComment {
  return {
    findingId,
    commentId,
    htmlUrl: `https://gh/c/${commentId}`,
    kind: 'inline',
    createdAt: '2026-01-01T00:00:00Z'
  }
}

function session(postedComments: PostedComment[] = []): ReviewSession {
  return {
    id: 'r1',
    repoId: 'repo1',
    agentBackend: 'claude',
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    prTitle: 'Add thing',
    prAuthor: 'someone',
    viewerIsAuthor: false,
    headSha: 'abc1234',
    baseRefName: 'main',
    prompt: 'review',
    status: 'done',
    summary: '',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    agentSessionId: null,
    postedComments,
    lastSeenAt: null,
    lastSeenHeadSha: 'abc1234',
    unread: false,
    lastVerdict: null,
    lastVerdictAt: null
  }
}

function finding(id: string): ReviewFinding {
  return { id, severity: 'minor', title: id, body: id, anchor: null }
}

function view(ids: string[], selected: string[] = []): ReviewViewState {
  const v = emptyView()
  v.loaded = true
  v.findings = ids.map(finding)
  for (const id of selected) v.selected[id] = true
  return v
}

describe('isPosted', () => {
  /**
   * 게시 여부의 권위는 영속되는 레코드다 — 화면 상태에 두면 앱을 껐다 켰을 때 이미 단
   * 코멘트를 다시 달 수 있게 되어 PR 이 중복 코멘트로 더러워진다.
   */
  it('레코드의 postedComments 를 기준으로 판단한다', () => {
    const s = session([posted('a', 1)])
    expect(isPosted(s, 'a')).toBe(true)
    expect(isPosted(s, 'b')).toBe(false)
  })
})

describe('selectionSummary', () => {
  it('지적이 없으면 전체 선택을 켤 수 없다', () => {
    expect(selectionSummary(session(), view([]))).toEqual({
      selectableCount: 0,
      pendingIds: [],
      allSelected: false,
      someSelected: false
    })
  })

  it('아무것도 선택하지 않은 상태', () => {
    const s = selectionSummary(session(), view(['a', 'b', 'c']))
    expect(s).toMatchObject({ selectableCount: 3, allSelected: false, someSelected: false })
    expect(s.pendingIds).toEqual([])
  })

  it('일부만 선택하면 indeterminate 다', () => {
    const s = selectionSummary(session(), view(['a', 'b', 'c'], ['b']))
    expect(s).toMatchObject({ allSelected: false, someSelected: true })
    expect(s.pendingIds).toEqual(['b'])
  })

  it('전부 선택하면 allSelected 다', () => {
    const s = selectionSummary(session(), view(['a', 'b'], ['a', 'b']))
    expect(s).toMatchObject({ selectableCount: 2, allSelected: true, someSelected: false })
  })

  it('이미 게시한 지적은 전체 선택의 기준에서 제외한다', () => {
    const s = selectionSummary(session([posted('a', 1)]), view(['a', 'b', 'c'], ['b', 'c']))
    expect(s.selectableCount).toBe(2)
    expect(s.allSelected).toBe(true)
    expect(s.pendingIds).toEqual(['b', 'c'])
  })

  it('선택돼 있어도 이미 게시했으면 다시 달 대상이 아니다', () => {
    const s = selectionSummary(session([posted('a', 1)]), view(['a', 'b'], ['a', 'b']))
    expect(s.pendingIds).toEqual(['b'])
  })

  it('전부 게시했으면 고를 것이 없다', () => {
    const s = selectionSummary(
      session([posted('a', 1), posted('b', 2)]),
      view(['a', 'b'], ['a', 'b'])
    )
    expect(s).toMatchObject({ selectableCount: 0, allSelected: false, someSelected: false })
    expect(s.pendingIds).toEqual([])
  })
})
