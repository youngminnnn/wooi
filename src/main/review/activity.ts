import { randomUUID } from 'node:crypto'
import type { ReviewActivityItem } from '@shared/types'
import type { GhIssueComment, GhReviewComment, GhReviewThread } from '../github'

export interface DetectActivityInput {
  reviewComments: GhReviewComment[]
  issueComments: GhIssueComment[]
  /** 지금 PR head sha. lastSeenHeadSha 와 다르면 새 커밋이 올라온 것이다. */
  headSha: string | null
  /** 우리가 게시한 인라인 코멘트 id. 답글은 이 중 하나를 in_reply_to_id 로 가리킨다. */
  postedCommentIds: number[]
  /** 로그인 계정. 내가 단 답장을 새 활동으로 잡지 않기 위해. */
  viewerLogin: string | null
  /** 이 시각 이후에 생긴 것만 새 활동으로 본다(ISO). */
  since: string | null
  lastSeenHeadSha: string
}

export interface DetectActivityResult {
  items: ReviewActivityItem[]
  /** 다음 폴링의 기준이 될 워터마크. 새 게 없으면 입력값 그대로. */
  nextSince: string | null
  nextHeadSha: string
}

/**
 * 리뷰에 끌어올 활동을 추린다.
 *
 * **내가 시작한 스레드와 그 밖은 규칙이 다르다.**
 *
 * - *내 스레드의 답글은 전부 가져온다* — 누가 썼든, 언제 달렸든. 스레드는 하나의 대화라
 *   중간이 빠지면 읽을 수 없고, 특히 **내가 GitHub 웹에서 직접 단 답글**이 빠지면 내가 한 말이
 *   Wooi 에만 없는 이상한 상태가 된다. 워터마크로 자르지 않으므로, 어떤 이유로 놓쳤던 답글도
 *   다음 폴링이 채워 넣는다(같은 id 로 upsert 되어 중복되지 않는다).
 * - *타임라인(issue) 코멘트는 기준 시각 이후의 남의 것만* — 스레딩이 없어 "어느 지적에 대한
 *   답" 인지 GitHub 이 알려주지 않고, 내 것까지 끌어오면 내가 게시한 지적이 타임라인에 두 번 보인다.
 *
 * 워터마크(`nextSince`)는 **남이 쓴 것으로만** 전진한다. 내 답글로 밀어 두면 그 직전에 올라온
 * 남의 타임라인 코멘트가 영영 건너뛰어진다.
 *
 * 몇 가지 GitHub API 의 실제 동작을 전제로 한다(실 API 로 확인함):
 *
 * - `in_reply_to_id` 는 항상 **스레드 루트**를 가리킨다. 바로 위 코멘트가 아니다 —
 *   그래서 재귀 없이 평면 필터 한 번이면 된다.
 * - PR 단위 엔드포인트는 `since` 쿼리를 무시한다. 그래서 워터마크 비교를 여기서 직접 한다.
 * - `line` 은 코멘트가 diff 에서 밀려나면 null 이 온다 → `original_line` 으로 폴백한다.
 */
export function detectNewActivity(input: DetectActivityInput): DetectActivityResult {
  const {
    reviewComments,
    issueComments,
    headSha,
    postedCommentIds,
    viewerLogin,
    since,
    lastSeenHeadSha
  } = input

  const posted = new Set(postedCommentIds)
  const items: ReviewActivityItem[] = []
  let newest = since

  const isNewer = (at: string): boolean => !since || at > since
  const isOther = (login: string | undefined): boolean => !!login && login !== viewerLogin
  const advance = (at: string): void => {
    if (!newest || at > newest) newest = at
  }

  for (const c of reviewComments) {
    // 우리가 단 코멘트의 스레드에 달린 답글만 본다. 무관한 스레드까지 끌어오면 소음이 된다.
    if (!c.in_reply_to_id || !posted.has(c.in_reply_to_id)) continue
    // 작성자도 시각도 따지지 않는다 — 스레드는 통째로 읽혀야 한다. 대신 워터마크는 남의 말로만
    // 민다(내 답글로 밀면 그 직전의 남의 타임라인 코멘트를 건너뛴다).
    if (isOther(c.user?.login) && isNewer(c.created_at)) advance(c.created_at)
    items.push({
      id: `reply-${c.id}`,
      kind: 'reply',
      threadRootId: c.in_reply_to_id,
      commentId: c.id,
      author: c.user?.login ?? '',
      body: c.body,
      htmlUrl: c.html_url,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      ts: Date.parse(c.created_at) || Date.now()
    })
  }

  for (const c of issueComments) {
    if (!isOther(c.user?.login) || !isNewer(c.created_at)) continue
    advance(c.created_at)
    items.push({
      id: `issue-${c.id}`,
      kind: 'reply',
      // 타임라인 코멘트는 스레드가 없다 — 어떤 지적에 대한 답인지 GitHub 이 알려주지 않는다.
      threadRootId: null,
      commentId: c.id,
      author: c.user?.login ?? '',
      body: c.body,
      htmlUrl: c.html_url,
      ts: Date.parse(c.created_at) || Date.now()
    })
  }

  items.sort((a, b) => a.ts - b.ts)

  let nextHeadSha = lastSeenHeadSha
  if (headSha && headSha !== lastSeenHeadSha) {
    nextHeadSha = headSha
    items.push({
      id: `commits-${headSha}`,
      kind: 'commits',
      headSha,
      ts: Date.now()
    })
  }

  return { items, nextSince: newest, nextHeadSha }
}

/**
 * 내가 단 인라인 코멘트 중 최신 diff 에서 밀려난 것(GitHub 의 "Outdated") 을 가려낸다.
 *
 * GitHub 은 코멘트가 밀려나면 `position` 과 `line` 을 **둘 다** null 로 준다(원래 자리는
 * `original_line` 에 남는다). 한쪽만 보면 파일 단위 코멘트처럼 원래 줄이 없는 것까지 낡은
 * 것으로 몰기 쉬워, 두 값이 모두 비었을 때만 낡은 것으로 본다.
 *
 * 목록에 없는 코멘트(상대가 지웠거나 아직 못 받은 경우)는 판단하지 않는다 — 모르는 것을
 * "낡았다" 고 표시하면 멀쩡한 지적이 조용히 힘을 잃는다.
 */
export function detectOutdatedComments(
  reviewComments: GhReviewComment[],
  postedIds: number[]
): Map<number, boolean> {
  const wanted = new Set(postedIds)
  const out = new Map<number, boolean>()
  for (const c of reviewComments) {
    if (!wanted.has(c.id)) continue
    out.set(c.id, c.position == null && c.line == null)
  }
  return out
}

/** 스레드 1건에서 우리가 쓰는 것 — node id 와 접힘 여부. */
export interface ThreadState {
  threadId: string
  resolved: boolean
}

/**
 * 내가 단 인라인 코멘트가 뿌리인 스레드의 **접힘 상태**를 코멘트 id 로 색인한다.
 *
 * outdated 와 마찬가지로 **목록에 없는 코멘트는 판단하지 않는다** — 아직 못 받았거나 상대가
 * 지운 스레드를 "안 접혔다" 로 단정하면, 이미 접힌 지적이 화면에서 되살아난다.
 */
export function detectResolvedThreads(
  threads: GhReviewThread[],
  postedIds: number[]
): Map<number, ThreadState> {
  const wanted = new Set(postedIds)
  const out = new Map<number, ThreadState>()
  for (const t of threads) {
    if (t.rootCommentId === null || !wanted.has(t.rootCommentId)) continue
    out.set(t.rootCommentId, { threadId: t.id, resolved: t.isResolved })
  }
  return out
}

/** 새 활동 항목에 붙일 안정적인 id 가 없을 때(수동 추가 등) 쓰는 생성기. */
export function activityId(): string {
  return randomUUID()
}
