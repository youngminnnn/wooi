import { describe, it, expect } from 'vitest'
import type { PostedComment, ReviewActivityItem, ReviewFinding, ReviewSession } from '@shared/types'
import {
  emptyView,
  isPosted,
  matchesPrQuery,
  orderedAnchoredFindings,
  parsePrSelector,
  parsePrUrl,
  repliesByThread,
  selectionSummary,
  stepFinding,
  toolParts,
  type ReviewViewState
} from './review'

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
    model: null,
    effort: null,
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
    lastSubmission: null
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

describe('parsePrSelector', () => {
  it('번호와 #번호를 받는다', () => {
    expect(parsePrSelector('123')).toBe(123)
    expect(parsePrSelector(' #123 ')).toBe(123)
  })

  /** 주소창에서 복사한 URL 은 뒤에 /files, #discussion, ?w=1 이 붙어 오는 게 보통이다. */
  it('꼬리가 붙은 PR URL 도 받는다', () => {
    expect(parsePrSelector('https://github.com/o/r/pull/123')).toBe(123)
    expect(parsePrSelector('https://github.com/o/r/pull/123/files')).toBe(123)
    expect(parsePrSelector('https://github.com/o/r/pull/123#discussion_r1')).toBe(123)
    expect(parsePrSelector('https://github.com/o/r/pull/123/files?w=1')).toBe(123)
  })

  /** 번호로 끝난다고 아무 문자열이나 PR 로 읽으면, 오타가 엉뚱한 PR 리뷰로 이어진다. */
  it('PR 을 가리키지 않는 문자열은 거절한다', () => {
    expect(parsePrSelector('fix login 2')).toBeNull()
    expect(parsePrSelector('https://github.com/o/r/issues/123')).toBeNull()
    expect(parsePrSelector('')).toBeNull()
    expect(parsePrSelector('#0')).toBeNull()
  })
})

describe('parsePrUrl', () => {
  it('owner/repo/번호를 읽어낸다', () => {
    expect(parsePrUrl('https://github.com/acme/wooi/pull/42/files')).toEqual({
      owner: 'acme',
      repo: 'wooi',
      number: 42
    })
  })

  it('URL 이 아니면 null', () => {
    expect(parsePrUrl('42')).toBeNull()
  })
})

describe('matchesPrQuery', () => {
  const pr = {
    number: 42,
    title: 'Fix login redirect',
    head: 'fix/login',
    base: 'main',
    author: 'kim'
  }

  it('빈 검색어는 전부 통과', () => {
    expect(matchesPrQuery(pr, '')).toBe(true)
  })

  it('제목·번호·작성자·브랜치 어느 쪽으로도 찾힌다', () => {
    expect(matchesPrQuery(pr, 'login')).toBe(true)
    expect(matchesPrQuery(pr, '42')).toBe(true)
    expect(matchesPrQuery(pr, 'kim')).toBe(true)
    expect(matchesPrQuery(pr, 'fix/login')).toBe(true)
  })

  /** 낱말을 더할수록 좁아져야 검색이 검색답다. */
  it('낱말을 모두 포함해야 통과한다', () => {
    expect(matchesPrQuery(pr, 'fix redirect')).toBe(true)
    expect(matchesPrQuery(pr, 'fix logout')).toBe(false)
  })
})

describe('toolParts', () => {
  it('나뉘어 온 항목은 그대로 쓴다', () => {
    expect(toolParts({ text: 'Bash  ls', name: 'Bash', detail: 'ls' })).toEqual({
      name: 'Bash',
      summary: 'ls'
    })
  })

  /** 사이드카에 이미 쌓인 옛 항목은 한 줄뿐이다 — 그것도 같은 도구 행으로 보여야 한다. */
  it('옛 한 줄 기록은 합쳐 쓴 규칙대로 되돌린다', () => {
    expect(toolParts({ text: 'Read  src/main/index.ts' })).toEqual({
      name: 'Read',
      summary: 'src/main/index.ts'
    })
    expect(toolParts({ text: 'Glob' })).toEqual({ name: 'Glob', summary: '' })
  })
})

describe('repliesByThread', () => {
  const reply = (id: string, root: number | null, ts: number): ReviewActivityItem => ({
    id,
    kind: 'reply',
    threadRootId: root,
    commentId: Number(id),
    author: 'them',
    body: id,
    htmlUrl: '',
    ts
  })

  it('스레드 루트별로 묶고 시간순으로 세운다', () => {
    const map = repliesByThread([reply('2', 100, 20), reply('1', 100, 10), reply('3', 200, 5)])
    expect(map.get(100)?.map((r) => r.id)).toEqual(['1', '2'])
    expect(map.get(200)?.map((r) => r.id)).toEqual(['3'])
  })

  /** 타임라인(issue) 코멘트는 어느 지적에 대한 답인지 GitHub 이 알려주지 않는다. */
  it('스레드가 없는 답글은 어디에도 붙이지 않는다', () => {
    expect(repliesByThread([reply('1', null, 1)]).size).toBe(0)
  })
})

describe('orderedAnchoredFindings', () => {
  const diff = {
    files: [
      {
        path: 'a.ts',
        oldPath: null,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: []
      },
      {
        path: 'b.ts',
        oldPath: null,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: []
      }
    ]
  }
  const at = (id: string, file: string, line: number): ReviewFinding => ({
    ...finding(id),
    anchor: { file, side: 'RIGHT', line, startLine: null, snappedFrom: null }
  })

  /** 건너뛰는 순서가 눈이 훑는 순서와 달라지면, 어디까지 봤는지 알 수 없다. */
  it('파일 순 → 줄 순으로 세운다', () => {
    const out = orderedAnchoredFindings(diff, [
      at('b20', 'b.ts', 20),
      at('a30', 'a.ts', 30),
      at('a10', 'a.ts', 10)
    ])
    expect(out.map((f) => f.id)).toEqual(['a10', 'a30', 'b20'])
  })

  it('전반 지적과 diff 에 없는 파일은 뺀다', () => {
    const out = orderedAnchoredFindings(diff, [finding('general'), at('ghost', 'c.ts', 1)])
    expect(out).toEqual([])
  })

  it('diff 를 아직 못 읽었으면 갈 곳이 없다', () => {
    expect(orderedAnchoredFindings(null, [at('a10', 'a.ts', 10)])).toEqual([])
  })
})

describe('stepFinding', () => {
  const list = ['a', 'b', 'c'].map(finding)

  it('아직 아무 데도 없으면 방향에 맞는 끝에서 시작한다', () => {
    expect(stepFinding(list, null, 1)).toBe('a')
    expect(stepFinding(list, null, -1)).toBe('c')
  })

  it('한 칸씩 옮긴다', () => {
    expect(stepFinding(list, 'a', 1)).toBe('b')
    expect(stepFinding(list, 'b', -1)).toBe('a')
  })

  /** 끝에서 아무 일도 안 일어나면 고장으로 읽힌다 — 반대쪽 끝으로 돈다. */
  it('끝에서는 반대쪽 끝으로 돈다', () => {
    expect(stepFinding(list, 'c', 1)).toBe('a')
    expect(stepFinding(list, 'a', -1)).toBe('c')
  })

  it('갈 곳이 없으면 null', () => {
    expect(stepFinding([], null, 1)).toBeNull()
  })
})
