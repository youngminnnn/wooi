import type { ReviewFinding, ReviewFindingDiscard, ReviewFindingRevision } from '@shared/types'

/**
 * 에이전트가 **자기가 앞서 낸 지적을 고쳐 쓰거나 거둬들이는** 경로.
 *
 * 후속 턴이 지적을 덧붙이기만 하면, 사용자가 지적대로 고친 뒤 "다시 봐줘" 라고 했을 때 목록은
 * 계속 자라기만 한다 — 이미 해결된 지적과 새 지적이 한 화면에 섞여, 무엇이 아직 남은 일인지
 * 알 수 없게 된다. 그래서 고쳐 쓰기(updates)와 거둬들이기(discards)가 필요하다.
 *
 * 규칙은 하나로 요약된다: **이미 PR 에 올라간 지적은 여기서 건드리지 않는다.** 그건 상대가
 * 이미 읽은 말이라 우리 화면에서 조용히 바꾸면 두 사람이 서로 다른 문장을 보게 되고,
 * 조용히 지우면 GitHub 에 남은 코멘트를 우리만 잊는다(사용자의 Discard 와 같은 규칙이다).
 */

/** 핸들 최소 길이. 이보다 짧은 것으로 앞자리 대조를 하면 엉뚱한 지적을 집는다. */
const MIN_HANDLE = 6

/** 프롬프트에 실을 핸들 길이. 리뷰 하나에 들어갈 지적 수에서 충돌은 사실상 없다. */
const HANDLE_LENGTH = 8

/** 대조용으로 id 를 평평하게 만든다 — 하이픈·대소문자 차이로 못 찾는 일이 없게. */
function normalize(id: string): string {
  return id.replace(/[^0-9a-z]/gi, '').toLowerCase()
}

/**
 * 지적 1건의 핸들. uuid 를 통째로 복사하게 하면 한 글자만 틀려도 지시가 통째로 무시되고,
 * 목록이 길어질수록 프롬프트에서 차지하는 자리도 커진다.
 */
export function findingHandle(id: string): string {
  return normalize(id).slice(0, HANDLE_LENGTH)
}

/**
 * 에이전트가 준 핸들로 지적을 찾는다. 정확히 같은 id 를 먼저 보고, 없으면 **앞자리가 겹치는
 * 것이 딱 하나일 때만** 그것으로 본다. 둘 이상이면 아무것도 고르지 않는다 — 어느 쪽인지
 * 모르는 채로 남의 지적을 지우는 것보다 지시를 흘리는 편이 낫다.
 */
export function resolveFindingId(findings: ReviewFinding[], handle: string): string | undefined {
  const wanted = normalize(handle)
  if (wanted.length < MIN_HANDLE) return undefined
  const exact = findings.find((f) => normalize(f.id) === wanted)
  if (exact) return exact.id
  const prefixed = findings.filter((f) => normalize(f.id).startsWith(wanted))
  return prefixed.length === 1 ? prefixed[0].id : undefined
}

export interface ReviseInput {
  findings: ReviewFinding[]
  /** 이미 PR 에 올라간 지적 id. 이것들은 고쳐 쓰지도 거둬들이지도 않는다. */
  postedIds: Iterable<string>
  updates: ReviewFindingRevision[]
  discards: ReviewFindingDiscard[]
}

export interface ReviseResult {
  /** 실제로 값이 바뀐 지적만. 그대로인 것은 다시 쓸 이유가 없다. */
  updated: ReviewFinding[]
  /** 목록에서 빠진 지적. 타임라인에 흔적을 남길 수 있게 제목과 이유를 함께 준다. */
  discarded: Array<{ finding: ReviewFinding; reason: string }>
  /** 따르지 않은 지시와 그 이유. 로그로만 남는다 — 사용자가 할 일은 없다. */
  ignored: Array<{ id: string; reason: string }>
}

/**
 * 에이전트의 고쳐 쓰기·거둬들이기를 지금 목록에 적용한다.
 *
 * 순수 함수다 — 저장도 방송도 하지 않고 "무엇이 어떻게 바뀌는가" 만 계산한다. 그래야 이
 * 규칙(게시된 것은 못 건드린다, 모르는 핸들은 흘린다)을 파일도 GitHub 도 없이 검증할 수 있다.
 */
export function applyRevisions(input: ReviseInput): ReviseResult {
  const posted = new Set(input.postedIds)
  const updated: ReviewFinding[] = []
  const discarded: ReviseResult['discarded'] = []
  const ignored: ReviseResult['ignored'] = []

  // 지금까지의 결과를 반영해 가며 찾는다 — 같은 턴에서 거둬들인 지적을 다시 고쳐 쓰라는
  // 모순된 지시가 오면 뒤엣것이 조용히 되살리는 일이 없어야 한다.
  let current = input.findings

  // 거둬들이기를 먼저 본다. 거둘 것을 고쳐 쓰라는 지시가 같이 왔다면 거두는 쪽이 이긴다.
  for (const discard of input.discards) {
    const id = resolveFindingId(current, discard.id)
    if (!id) {
      ignored.push({ id: discard.id, reason: 'no finding with that handle' })
      continue
    }
    if (posted.has(id)) {
      ignored.push({ id: discard.id, reason: 'already posted to the pull request' })
      continue
    }
    const finding = current.find((f) => f.id === id)!
    current = current.filter((f) => f.id !== id)
    discarded.push({ finding, reason: discard.reason?.trim() || 'No longer applies.' })
  }

  for (const update of input.updates) {
    const id = resolveFindingId(current, update.id)
    if (!id) {
      ignored.push({ id: update.id, reason: 'no finding with that handle' })
      continue
    }
    if (posted.has(id)) {
      ignored.push({ id: update.id, reason: 'already posted to the pull request' })
      continue
    }
    const before = current.find((f) => f.id === id)!
    // 준 것만 바꾼다. 빈 문자열은 "지워라" 가 아니라 "안 냈다" 로 읽는다 — 제목도 본문도
    // 없는 지적은 게시할 내용이 없어 카드만 남는다.
    const next: ReviewFinding = {
      ...before,
      ...(update.severity ? { severity: update.severity } : {}),
      ...(update.title?.trim() ? { title: update.title.trim() } : {}),
      ...(update.body?.trim() ? { body: update.body.trim() } : {})
    }
    if (
      next.severity === before.severity &&
      next.title === before.title &&
      next.body === before.body
    ) {
      ignored.push({ id: update.id, reason: 'nothing actually changed' })
      continue
    }
    current = current.map((f) => (f.id === id ? next : f))
    updated.push(next)
  }

  return { updated, discarded, ignored }
}
