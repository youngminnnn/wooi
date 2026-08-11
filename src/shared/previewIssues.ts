/**
 * Preview 가 모은 콘솔·네트워크 문제와, 그것을 에이전트에게 넘길 때의 형식.
 *
 * 순수 함수로 떼어 둔 이유는 두 가지다 — 중복 합치기(같은 에러가 초당 수십 번 나는 것이 정상인
 * 세계다)와 프롬프트 형식은 둘 다 틀리기 쉬운데 Electron 없이 검증할 수 있다.
 */

/** 콘솔 한 줄 또는 실패한 요청 하나. 같은 것이 반복되면 count 로 합친다. */
export interface PreviewIssue {
  /** 화면에서 행을 구분하는 키. 합쳐진 항목은 같은 id 를 유지한다. */
  id: string
  kind: 'console' | 'network'
  level: 'error' | 'warning'
  /** 콘솔 메시지 본문, 또는 `404 GET /api/users` 같은 요청 요약. */
  text: string
  /** 콘솔은 `파일:줄`, 네트워크는 요청 URL. 없을 수 있다. */
  source?: string
  /** 마지막으로 관측된 시각(합쳐지면 갱신된다). */
  ts: number
  /** 같은 문제가 몇 번 났는지. 1이면 한 번. */
  count: number
}

/**
 * 같은 문제로 볼 기준.
 *
 * 시각은 일부러 넣지 않는다 — dev 서버는 리렌더마다 같은 경고를 다시 찍는데, 그걸 별개로 세면
 * 목록이 순식간에 같은 줄 200개가 되어 정작 다른 에러가 밀려난다.
 */
export function issueKey(issue: Pick<PreviewIssue, 'kind' | 'level' | 'text' | 'source'>): string {
  return `${issue.kind}|${issue.level}|${issue.source ?? ''}|${issue.text}`
}

/**
 * 새 문제를 목록에 넣는다. 같은 것이 이미 있으면 count 를 올리고 시각만 갱신한다.
 * 목록이 limit 을 넘으면 **오래된 것부터** 버린다 — 지금 고치는 중인 문제가 최신이다.
 *
 * 원본을 건드리지 않고 새 배열을 돌려준다(렌더러가 참조 비교로 갱신을 알아채도록).
 */
export function addIssue(
  issues: readonly PreviewIssue[],
  incoming: Omit<PreviewIssue, 'id' | 'count'>,
  limit: number
): PreviewIssue[] {
  const key = issueKey(incoming)
  const at = issues.findIndex((i) => issueKey(i) === key)
  if (at >= 0) {
    const next = [...issues]
    next[at] = { ...next[at], ts: incoming.ts, count: next[at].count + 1 }
    return next
  }
  const next = [...issues, { ...incoming, id: key, count: 1 }]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** 목록의 에러/경고 개수(툴바 배지가 쓴다). */
export function countIssues(issues: readonly PreviewIssue[]): {
  errors: number
  warnings: number
} {
  let errors = 0
  let warnings = 0
  for (const i of issues) {
    if (i.level === 'error') errors += 1
    else warnings += 1
  }
  return { errors, warnings }
}

/**
 * 고른 문제들을 컴포저에 넣을 텍스트로 만든다.
 *
 * 에러를 경고보다 앞에 둔다 — 목록을 통째로 보내는 경우가 많은데, 모델이 위에서부터 읽으므로
 * 고쳐야 할 것이 먼저 와야 한다. 반복 횟수를 적는 것도 신호다(200번 난 것과 1번 난 것은 다르다).
 */
export function formatIssues(issues: readonly PreviewIssue[], pageUrl: string): string {
  if (!issues.length) return ''

  const ordered = [...issues].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1
    return a.ts - b.ts
  })

  const lines = [`Errors from the preview at ${pageUrl}:`, '', '```']
  for (const issue of ordered) {
    const tag = issue.level === 'error' ? 'ERROR' : 'WARN '
    const repeat = issue.count > 1 ? ` (×${issue.count})` : ''
    lines.push(`${tag} ${issue.text}${repeat}`)
    if (issue.source) lines.push(`      at ${issue.source}`)
  }
  lines.push('```')
  return lines.join('\n')
}
