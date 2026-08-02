import type {
  DiffRow,
  DiffSide,
  ReviewActivityItem,
  ReviewDiff,
  ReviewFinding,
  ReviewProgressItem,
  ReviewSession,
  ReviewSeverity,
  ReviewStatus
} from '@shared/types'

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
    posting: {}
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

export function postedUrl(session: ReviewSession, findingId: string): string | undefined {
  return session.postedComments.find((c) => c.findingId === findingId)?.htmlUrl || undefined
}

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

/**
 * `123`, `#123`, `https://github.com/o/r/pull/123` 을 모두 받는다.
 * 사용자는 보통 브라우저 주소창에서 URL 을 그대로 복사해 온다.
 */
export function parsePrSelector(raw: string): number | null {
  const m = raw.trim().match(/(?:\/pull\/)?#?(\d+)\s*$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  preparing: 'Preparing',
  running: 'Reviewing',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Stopped'
}
