import type {
  DiffRow,
  DiffSide,
  PostedComment,
  ReviewActivityItem,
  ReviewDiff,
  ReviewFinding,
  ReviewPrCandidate,
  ReviewProgressItem,
  ReviewSession,
  ReviewSeverity,
  ReviewStatus
} from '@shared/types'

/** 오른쪽 패널에서 보고 있던 탭. */
export type ReviewTab = 'findings' | 'activity'

/**
 * 리뷰 1건의 화면 상태.
 *
 * **권위 있는 메타데이터는 `app.reviews`(ReviewSession)** 에 있다 — 영속되고 상태 방송으로
 * 흘러온다. 여기 담는 건 사이드카에서 따로 읽어오는 덩치 큰 부분과, 저장할 이유가 없는
 * 화면 전용 상태(선택·편집 중인 본문)뿐이다.
 */
export interface ReviewViewState {
  /** 사이드카를 한 번이라도 읽었는지. false 면 로딩 표시. */
  loaded: boolean
  diff: ReviewDiff | null
  findings: ReviewFinding[]
  activity: ReviewActivityItem[]
  /** 실행 중 에이전트 활동. 영속하지 않는다(끝나면 의미가 없다). */
  progress: ReviewProgressItem[]
  error: string | null
  /** findingId → 사용자가 인라인 편집한 본문. 없으면 원본 body 를 쓴다. */
  edits: Record<string, string>
  /** findingId → 체크 여부. */
  selected: Record<string, boolean>
  /**
   * findingId → 게시 진행/실패. **성공은 여기 두지 않는다** — 게시 완료의 권위는 레코드의
   * postedComments 이고, 그래야 재시작 후에도 "이미 단 코멘트" 가 유지된다.
   */
  posting: Record<string, { state: 'posting' | 'failed'; error?: string }>
  /**
   * 오른쪽 패널에서 마지막으로 보던 탭. 화면 상태이면서도 리뷰마다 따로 기억해야 한다 —
   * 워크스페이스를 오가면 리뷰 화면이 통째로 언마운트되는데, 그때마다 findings 로 되돌아가면
   * 답글을 주고받던 흐름이 매번 끊긴다.
   */
  tab: ReviewTab
}

export function emptyView(): ReviewViewState {
  return {
    loaded: false,
    diff: null,
    findings: [],
    activity: [],
    progress: [],
    error: null,
    edits: {},
    selected: {},
    posting: {},
    tab: 'findings'
  }
}

/** 게시될 최종 본문 — 편집본이 있으면 그것, 없으면 원본. */
export function bodyOf(view: ReviewViewState, finding: ReviewFinding): string {
  return view.edits[finding.id] ?? finding.body
}

/** 이 지적을 이미 PR 에 달았는가. 레코드가 권위이므로 재시작을 넘어 유지된다. */
export function isPosted(session: ReviewSession, findingId: string): boolean {
  return session.postedComments.some((c) => c.findingId === findingId)
}

/** 이 지적으로 게시된 코멘트 레코드. 게시 링크·답글 스레드·outdated 표시가 여기서 나온다. */
export function postedCommentFor(
  session: ReviewSession,
  findingId: string
): PostedComment | undefined {
  return session.postedComments.find((c) => c.findingId === findingId)
}

/**
 * 스레드 루트 코멘트 id → 그 아래 달린 답글들(시간순).
 *
 * 활동 타임라인과 **같은 자료**를 쓴다 — 답글을 diff 옆에서도 볼 수 있어야 하지만, 그렇다고
 * 두 곳이 서로 다른 목록을 들고 있으면 한쪽에만 보이는 답글이 생긴다.
 */
export function repliesByThread(
  activity: ReviewActivityItem[]
): Map<number, Extract<ReviewActivityItem, { kind: 'reply' }>[]> {
  // 지적 카드마다 부르는 함수라, diff 한 화면에서 수십 번 돈다. 활동 배열은 불변으로 교체되므로
  // 배열 자체를 열쇠로 캐시해 두면 목록이 바뀔 때만 다시 만든다.
  const hit = threadCache.get(activity)
  if (hit) return hit

  const out = new Map<number, Extract<ReviewActivityItem, { kind: 'reply' }>[]>()
  for (const item of activity) {
    if (item.kind !== 'reply' || item.threadRootId === null) continue
    const list = out.get(item.threadRootId)
    if (list) list.push(item)
    else out.set(item.threadRootId, [item])
  }
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts)
  threadCache.set(activity, out)
  return out
}

const threadCache = new WeakMap<
  ReviewActivityItem[],
  Map<number, Extract<ReviewActivityItem, { kind: 'reply' }>[]>
>()

export interface SelectionSummary {
  /** 아직 고를 수 있는(=게시 전) 지적 수. 0 이면 전체 선택 컨트롤을 비활성화한다. */
  selectableCount: number
  /** 지금 선택돼 있고 아직 게시하지 않은 지적 id. 게시 버튼이 그대로 쓴다. */
  pendingIds: string[]
  allSelected: boolean
  /** 일부만 선택된 상태 — 체크박스의 indeterminate 표시에 쓴다. */
  someSelected: boolean
}

/**
 * 전체 선택 체크박스의 3상태를 계산한다.
 *
 * "전체" 의 기준에서 **이미 게시한 지적은 빼야 한다** — 그러지 않으면 남은 걸 모두 골라도
 * 체크박스가 영영 채워지지 않고, 사용자는 무엇이 덜 선택됐는지 알 수 없다.
 */
export function selectionSummary(session: ReviewSession, view: ReviewViewState): SelectionSummary {
  const selectable = view.findings.filter((f) => !isPosted(session, f.id))
  const pendingIds = selectable.filter((f) => view.selected[f.id]).map((f) => f.id)
  const allSelected = selectable.length > 0 && pendingIds.length === selectable.length
  return {
    selectableCount: selectable.length,
    pendingIds,
    allSelected,
    someSelected: pendingIds.length > 0 && !allSelected
  }
}

/**
 * diff 행 → 그 줄에 붙일 지적들. 렌더링 때마다 전체를 훑지 않도록 한 번만 만들어 재사용한다.
 *
 * 문맥 행은 RIGHT/LEFT 양쪽 번호를 모두 갖는다. LEFT 로 앵커된 지적도 같은 행 아래에 보여야
 * 하므로 두 키 모두로 조회한다.
 */
export function indexFindingsByRow(findings: ReviewFinding[]): Map<string, ReviewFinding[]> {
  const map = new Map<string, ReviewFinding[]>()
  for (const f of findings) {
    if (!f.anchor) continue
    const key = rowKey(f.anchor.file, f.anchor.side, f.anchor.line)
    const list = map.get(key)
    if (list) list.push(f)
    else map.set(key, [f])
  }
  return map
}

export function rowKey(file: string, side: DiffSide, line: number): string {
  return `${file} ${side} ${line}`
}

/** 이 행에 걸린 지적들(문맥 행이면 양쪽 면 모두 확인). */
export function findingsForRow(
  index: Map<string, ReviewFinding[]>,
  file: string,
  row: DiffRow
): ReviewFinding[] {
  const out: ReviewFinding[] = []
  if (row.newLine !== null) out.push(...(index.get(rowKey(file, 'RIGHT', row.newLine)) ?? []))
  if (row.oldLine !== null) out.push(...(index.get(rowKey(file, 'LEFT', row.oldLine)) ?? []))
  return out
}

/**
 * diff 에 걸린 지적을 **화면에 보이는 순서**(파일 순 → 줄 순)로 세운다.
 *
 * 다음/이전 코멘트로 건너뛰는 순서는 눈이 훑는 순서와 같아야 한다 — 도착한 순서(findings 배열)
 * 대로 뛰면 위아래로 튀어 다녀 어디까지 봤는지 알 수 없다. diff 에 없는 파일의 지적은
 * 화면에 자리가 없으므로 목록에서 뺀다.
 */
export function orderedAnchoredFindings(
  diff: ReviewDiff | null,
  findings: ReviewFinding[]
): ReviewFinding[] {
  const fileRank = new Map<string, number>()
  diff?.files.forEach((f, i) => fileRank.set(f.path, i))
  return findings
    .filter((f) => f.anchor && fileRank.has(f.anchor.file))
    .sort((a, b) => {
      const byFile = fileRank.get(a.anchor!.file)! - fileRank.get(b.anchor!.file)!
      return byFile !== 0 ? byFile : a.anchor!.line - b.anchor!.line
    })
}

/**
 * 지금 보고 있는 지적에서 delta 만큼 옮긴 지적의 id. 목록 끝에서는 반대쪽 끝으로 돈다 —
 * 마지막에서 한 번 더 눌렀을 때 아무 일도 안 일어나면 고장으로 읽힌다.
 */
export function stepFinding(
  ordered: ReviewFinding[],
  currentId: string | null,
  delta: 1 | -1
): string | null {
  if (ordered.length === 0) return null
  const at = currentId ? ordered.findIndex((f) => f.id === currentId) : -1
  // 아직 아무 데도 없으면 방향에 맞는 끝에서 시작한다(아래로 = 첫 번째, 위로 = 마지막).
  if (at < 0) return (delta === 1 ? ordered[0] : ordered[ordered.length - 1]).id
  return ordered[(at + delta + ordered.length) % ordered.length].id
}

/** 파일별 인라인 지적 수 — 파일 목록 배지용. */
export function countByFile(findings: ReviewFinding[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of findings) {
    if (!f.anchor) continue
    out[f.anchor.file] = (out[f.anchor.file] ?? 0) + 1
  }
  return out
}

interface SeverityStyle {
  label: string
  /** 칩 배경/글자색 클래스. index.css 의 디자인 토큰만 쓴다. */
  className: string
}

export const SEVERITY_STYLE: Record<ReviewSeverity, SeverityStyle> = {
  blocker: {
    label: 'Blocker',
    className: 'bg-[var(--danger-500)]/15 text-[var(--danger-300)]'
  },
  major: {
    label: 'Major',
    className: 'bg-[var(--warning-500)]/15 text-[var(--warning-300)]'
  },
  minor: { label: 'Minor', className: 'bg-[var(--surface-2)] text-neutral-300' },
  nit: { label: 'Nit', className: 'bg-[var(--surface-2)] text-neutral-400' },
  question: {
    label: 'Question',
    className: 'bg-[var(--info-500)]/15 text-[var(--info-300)]'
  },
  praise: {
    label: 'Praise',
    className: 'bg-[var(--success-500)]/15 text-[var(--success-300)]'
  }
}

/** PR URL 에서 읽어낸 것. 리포까지 알면 붙여넣기 하나로 리포도 맞춰 줄 수 있다. */
export interface ParsedPrUrl {
  owner: string
  repo: string
  number: number
}

/**
 * PR URL 에서 owner/repo/번호를 읽는다.
 *
 * 주소창에서 복사한 URL 은 뒤에 `/files`, `#discussion_r…`, `?w=1` 이 붙어 오는 게 보통이라
 * **끝이 번호로 끝난다고 가정하지 않는다.** GitHub Enterprise 도 경로 모양은 같으므로
 * 호스트는 따지지 않는다.
 */
export function parsePrUrl(raw: string): ParsedPrUrl | null {
  const m = raw.trim().match(/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/#?].*)?$/)
  if (!m) return null
  const n = Number(m[3])
  if (!Number.isInteger(n) || n <= 0) return null
  return { owner: m[1], repo: m[2], number: n }
}

/**
 * `123`, `#123`, `https://github.com/o/r/pull/123/files` 을 모두 받는다.
 * 사용자는 보통 브라우저 주소창에서 URL 을 그대로 복사해 온다.
 */
export function parsePrSelector(raw: string): number | null {
  const url = parsePrUrl(raw)
  if (url) return url.number
  const m = raw.trim().match(/^#?(\d+)$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 검색어 한 줄로 열린 PR 을 걸러낸다. 제목·번호·작성자·브랜치 어느 쪽으로 기억하고 있든
 * 찾아지도록 모두 대상으로 삼는다(공백으로 나눈 낱말을 모두 포함해야 통과 — 좁혀 가는 검색).
 */
export function matchesPrQuery(pr: ReviewPrCandidate, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = `#${pr.number} ${pr.title} ${pr.author} ${pr.head} ${pr.base}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/**
 * 도구 항목을 "이름 + 인자 요약" 으로 나눈다.
 *
 * 새 기록은 나뉘어 오지만, 사이드카에 이미 쌓인 옛 항목은 `text` 한 줄뿐이다 — 그것들도
 * 같은 도구 행으로 보이도록 합쳐 쓴 규칙(`이름  인자`)을 되돌린다.
 */
export function toolParts(item: { text: string; name?: string; detail?: string }): {
  name: string
  summary: string
} {
  if (item.name) return { name: item.name, summary: item.detail ?? '' }
  const at = item.text.indexOf('  ')
  if (at < 0) return { name: item.text, summary: '' }
  return { name: item.text.slice(0, at), summary: item.text.slice(at + 2) }
}

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  preparing: 'Preparing',
  running: 'Reviewing',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Stopped'
}
