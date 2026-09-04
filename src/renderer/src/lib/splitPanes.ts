import { workspaceStackMembers } from '@shared/types'

/**
 * 나란히 보는 두 칸(pane) 의 규칙.
 *
 * 이 앱의 전체 화면은 지금까지 "한 번에 하나" 였다 — 리뷰·fan-out 비교·스택 화면은 서로를
 * 밀어내고, 워크스페이스를 고르면 셋 다 닫혔다. 분할은 그 규칙에 **예외 하나**를 들인다:
 * 관계가 있는 두 개는 나란히 둘 수 있다. 임의 배치는 안 된다 — 배치 자유도는 이 앱의 축이
 * 아니고, 자유롭게 쪼갤 수 있게 만드는 순간 "무엇과 무엇을 비교하는 중인가" 라는 뜻이 사라진다.
 *
 * 그래서 여기 있는 것은 레이아웃 엔진이 아니라 **판정기**다. 어떤 조합이 성립하는지, 선택이
 * 어느 칸으로 가는지, 무엇을 닫으면 무엇이 남는지를 이 한 곳에서 정하고 스토어와 화면은
 * 결과만 따른다.
 */

/** 칸 하나가 담을 수 있는 것. 대화 아니면 PR 리뷰 — 이 둘뿐이다. */
export type PaneView =
  { kind: 'workspace'; workspaceId: string } | { kind: 'review'; reviewId: string }

/** 왼쪽(주) 칸과 오른쪽(분할) 칸. 셋 이상은 없다. */
export type PaneSlot = 'main' | 'split'

/** 분할이 만들어 내는 두 가지 짝. 성립하지 않으면 null 이다. */
export type PanePairing = 'stack' | 'review'

/** 화면에 걸린 두 칸. 스토어의 여러 축에서 뽑아낸 뒤로는 이 모양으로만 다룬다. */
export type PaneState = {
  main: PaneView | null
  split: PaneView | null
  focus: PaneSlot
}

/** 분할이 성립하지 않는 조합을 ⌘+클릭했을 때 사용자에게 하는 말. */
export const SPLIT_INELIGIBLE_MESSAGE =
  'Side by side is for two layers of the same stack, or for a review next to a conversation.'

/** 아직 아무것도 보고 있지 않을 때 ⌘+클릭한 경우. 옆에 둘 대상이 없다. */
export const SPLIT_NEEDS_MAIN_MESSAGE =
  'Open a workspace or a review first, then ⌘-click what you want beside it.'

export function samePane(a: PaneView | null, b: PaneView | null): boolean {
  if (!a || !b) return false
  if (a.kind === 'workspace' && b.kind === 'workspace') return a.workspaceId === b.workspaceId
  if (a.kind === 'review' && b.kind === 'review') return a.reviewId === b.reviewId
  return false
}

/**
 * 두 칸이 나란히 설 수 있는 조합인가.
 *
 * - `stack` — 같은 스택의 두 층. 부모/자식 대조가 본업이라 이것이 첫 번째 짝이다. 멤버 판정은
 *   `workspaceStackMembers` 하나만 쓴다 — 무엇이 한 스택인지의 단일 소스다.
 * - `review` — 한쪽은 리뷰, 한쪽은 대화. 리뷰를 보다 고칠 곳은 대개 다른 워크스페이스라
 *   어떤 대화와도 짝지을 수 있게 둔다.
 *
 * 나머지는 전부 null 이다 — 관계 없는 두 워크스페이스, 리뷰 두 개, 그리고 같은 것 두 번.
 */
export function splitPairing<T extends { id: string; parentWorkspaceId: string | null }>(
  workspaces: T[],
  a: PaneView | null,
  b: PaneView | null
): PanePairing | null {
  if (!a || !b || samePane(a, b)) return null
  if (a.kind === 'review' && b.kind === 'review') return null
  if (a.kind === 'review' || b.kind === 'review') return 'review'
  const members = workspaceStackMembers(workspaces, a.workspaceId)
  return members.some((w) => w.id === b.workspaceId) ? 'stack' : null
}

/** 스토어의 전체 화면 축에서 주 칸이 지금 무엇을 비추는지 읽는다. */
export function mainPane(s: {
  activeReviewId: string | null
  selectedWorkspaceId: string | null
}): PaneView | null {
  if (s.activeReviewId) return { kind: 'review', reviewId: s.activeReviewId }
  if (s.selectedWorkspaceId) return { kind: 'workspace', workspaceId: s.selectedWorkspaceId }
  return null
}

/** 스토어 상태를 이 파일이 다루는 모양으로 옮긴다. */
export function paneState(s: {
  activeReviewId: string | null
  selectedWorkspaceId: string | null
  splitPane: PaneView | null
  splitFocus: PaneSlot
}): PaneState {
  return { main: mainPane(s), split: s.splitPane, focus: s.splitFocus }
}

/**
 * 지금 키보드·단축키의 대상이 되는 칸.
 *
 * 분할이 없으면 주 칸이다. 그래서 헤더 도구 단축키(⇧⌘E·⇧⌘⌫ …)가 "선택된 워크스페이스" 대신
 * 이것을 읽게 해 두면, 분할 중에만 대상이 옮겨 가고 나머지 상황은 예전과 한 글자도 다르지 않다.
 */
export function focusedPane(state: PaneState): PaneView | null {
  return state.focus === 'split' && state.split ? state.split : state.main
}

/**
 * ⌘+클릭 — 지금 보고 있는 것 **옆에** 하나를 더 편다.
 *
 * 짝이 성립하지 않으면 상태를 그대로 돌려준다. 부르는 쪽이 `splitPairing` 으로 먼저 물어
 * 사용자에게 이유를 말해 주는 것을 전제로 한다.
 */
export function openSplit<T extends { id: string; parentWorkspaceId: string | null }>(
  workspaces: T[],
  state: PaneState,
  view: PaneView
): PaneState {
  if (!splitPairing(workspaces, state.main, view)) return state
  return { main: state.main, split: view, focus: 'split' }
}

/**
 * 사이드바에서 무언가를 그냥 고른 경우 — 이 작업의 진짜 설계 지점이다.
 *
 * 분할이 아니면 예전 그대로 주 칸을 갈아 끼운다(전체 화면 축을 닫는 일은 부르는 쪽이 한다).
 * 분할 중이면 **포커스된 칸만** 바뀐다. 이것이 "고르면 전체 화면을 닫는다" 라는 기존 규칙의
 * 유일한 예외이고, 없으면 사이드바를 한 번 누를 때마다 방금 만든 짝이 무너진다.
 *
 * 다만 그 결과가 성립하지 않는 짝이면(같은 것을 두 번 비추거나, 관계 없는 워크스페이스를
 * 골랐거나) 분할을 접고 고른 것만 남긴다 — 사용자는 "이걸 본다" 고 말했지 "짝을 깨라" 고
 * 말하지 않았으므로, 고른 쪽이 이기고 화면은 다시 하나가 된다.
 */
export function selectIntoPanes<T extends { id: string; parentWorkspaceId: string | null }>(
  workspaces: T[],
  state: PaneState,
  view: PaneView
): PaneState {
  if (!state.split) return { main: view, split: null, focus: 'main' }
  const next: PaneState =
    state.focus === 'split' ? { ...state, split: view } : { ...state, main: view }
  if (!splitPairing(workspaces, next.main, next.split))
    return { main: view, split: null, focus: 'main' }
  return next
}

/**
 * 포커스된 칸을 닫는다.
 *
 * 오른쪽을 닫으면 그냥 사라진다. 왼쪽을 닫으면 오른쪽이 그 자리로 올라온다 — 닫은 칸이 아니라
 * 남긴 칸이 화면에 남아야 "닫았다" 는 말이 맞다.
 */
export function withFocusedPaneClosed(state: PaneState): PaneState {
  if (!state.split) return state
  if (state.focus === 'split') return { main: state.main, split: null, focus: 'main' }
  return { main: state.split, split: null, focus: 'main' }
}

/**
 * 사라진 것을 가리키는 칸은 접는다.
 *
 * 오른쪽 칸의 워크스페이스가 아카이브·삭제되거나 리뷰가 닫히면, 남겨 둬 봐야 그릴 것이 없는
 * 빈 칸이 화면 절반을 차지한다. 주 칸은 기존 경로(선택 복구·리뷰 닫기)가 이미 돌본다.
 */
export function livePaneView(
  app: {
    workspaces: { id: string; archived: boolean }[]
    reviews: { id: string; archived: boolean }[]
  } | null,
  view: PaneView | null
): PaneView | null {
  if (!view) return null
  if (!app) return view
  if (view.kind === 'workspace')
    return app.workspaces.some((w) => w.id === view.workspaceId && !w.archived) ? view : null
  return app.reviews.some((r) => r.id === view.reviewId && !r.archived) ? view : null
}

/** 분할 비율의 양끝. 어느 쪽도 읽을 수 없을 만큼 좁아지지 않게 한다. */
export const MIN_SPLIT_FRACTION = 0.25
export const MAX_SPLIT_FRACTION = 0.75
export const DEFAULT_SPLIT_FRACTION = 0.5

export function clampSplitFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT_FRACTION
  return Math.min(MAX_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, fraction))
}
