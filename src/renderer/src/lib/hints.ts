import type { PrState } from '@shared/types'
import { SWITCH_HINT_THRESHOLD } from './uiFlags'

/**
 * 점진적 온보딩 힌트 레지스트리.
 *
 * `Sidebar.tsx` 에 하드코딩돼 있던 두 힌트(⌘K, ⌘↑/⌘↓)가 정답에 가까운 패턴이었다 — 한계에 실제로
 * 부딪힌 순간에만, 작고 흐리게, X 로 닫으면 끝. 이 파일은 그 패턴을 일반화해, 예전 7단계 일괄
 * 투어가 하던 소개를 그 기능에 실제로 도달한 순간들로 흩어 놓는다(`OnboardingModal` 은 더 이상
 * 이걸 첫 실행에 일괄로 하지 않는다).
 *
 * `when` 은 렌더러 상태의 스냅샷(`HintContext`)만 보는 **순수 함수**다 — 훅도, 스토어 접근도
 * 없다. 그래서 DOM 없이 트리거 표 전체를 단위 테스트할 수 있다(렌더러 헤드리스 테스트로는
 * "변경 파일이 있고 패널이 닫혀 있으면 work-panel 이 뜬다" 같은 판정을 걸 방법이 없다). 실제
 * 상태에서 이 스냅샷을 만드는 일과 화면에 그리는 일은 전부 `components/Hint.tsx`(호스트)가
 * 한다 — 이 파일은 store 를 import 하지 않는다.
 */

/**
 * 실제 UI에 존재하는 힌트 종류. `quick-switch`·`keyboard-switch` 는 이름 그대로 Sidebar 에 있던
 * 두 힌트를 레지스트리로 옮긴 것이다 — 트리거 조건과 우선순위(quick-switch 가 이긴다)는 원래
 * 코드 그대로고, `uiFlags.ts` 의 `hintSeenFlag` 가 예전 localStorage 키를 계속 돌려준다.
 *
 * `add-repo`·`new-workspace` 는 일부러 없다 — 리포 0개 화면은 `EmptyState.tsx` 가 이미
 * 맡고 있고(중앙에 크게, 리포가 생기면 "Press the + next to a repository" 로 문구까지 바뀐다),
 * 사이드바도 "No repositories yet." 를 늘 보여준다. 여기에 세 번째 목소리로 같은 말을 얹으면
 * 잔소리다 — repo-settings 힌트를 뺀 것과 같은 이유(hints 사다리 표 참고). 나머지 일곱은 전부
 * 사용자가 **워크스페이스 안에** 들어간 뒤에 뜨는 것들이라 EmptyState 와 화면이 겹치지 않는다.
 */
export type HintId =
  | 'permission-mode'
  | 'work-panel'
  | 'open-pr'
  | 'quick-switch'
  | 'keyboard-switch'
  | 'review-pr'
  | 'shortcuts'

/** `HINTS` 의 id 만 뽑아 둔 목록. 힌트를 다 훑어야 하는 쪽(예: 처음 seen 집합 구성)이 쓴다. */
export const HINT_IDS: HintId[] = [
  'permission-mode',
  'work-panel',
  'open-pr',
  'quick-switch',
  'keyboard-switch',
  'review-pr',
  'shortcuts'
]

/**
 * 지금 선택된 워크스페이스에 대해 힌트 판정이 알아야 하는 최소한의 상태.
 * 선택된 워크스페이스가 없으면(Overview 화면) `HintContext.selected` 가 null 이고, 그 상태에
 * 걸리는 힌트는 전부 when 이 자동으로 false 가 된다.
 */
export interface HintSelectedWorkspaceContext {
  /** base 브랜치 대비 앞선 커밋 수. */
  ahead: number
  /** 변경된(staged+unstaged+untracked) 파일 수. */
  changedFiles: number
  /** 이 브랜치에 PR 이 이미 있는지(상태 무관 — draft 도 "있음"이다). */
  hasPr: boolean
  /** 우측 작업 패널(파일/변경/체크/터미널)이 지금 열려 있는지. */
  panelOpen: boolean
  /** 이 워크스페이스에 대한 승인 프롬프트가 지금 떠 있는지. */
  awaitingPermission: boolean
}

/** `when` 이 보는 앱 상태 스냅샷. 컴포넌트가 아니라 평범한 값이라 테스트에서 리터럴로 만들 수 있다. */
export interface HintContext {
  /** 아카이브 포함 전체 워크스페이스 수 — "한 번이라도 만들어 본 적 있는지" 를 본다. */
  totalWorkspaceCount: number
  /** 사이드바에 실제로 보이는(⌘번호 대상) 워크스페이스 수(`orderVisibleWorkspaces`). */
  visibleWorkspaceCount: number
  /** 마우스로만 워크스페이스를 전환한 누적 횟수(`uiFlags.switchClickCount`). */
  mouseSwitchCount: number
  /** 어느 워크스페이스든 병합·종료되지 않은 PR 이 하나라도 있는지. */
  anyOpenPr: boolean
  selected: HintSelectedWorkspaceContext | null
}

export interface Hint {
  id: HintId
  /** 실제 UI의 data-tour 마커. 없으면 인라인 배치(`Hint.tsx` 참고). */
  anchor?: string
  /** 낮을수록 먼저 뜬다 — 동시에 여러 개가 참이어도 하나만 렌더된다. */
  priority: number
  /** 지금 이 힌트를 띄울 때인가. 앱 상태만 보는 순수 함수. */
  when: (ctx: HintContext) => boolean
  body: string
  /** 몸통 문장이 가리키는 단축키(있으면). 몸통 텍스트에 JSX 로 끼워 넣지 않고 따로 둔다 —
   * 이 파일이 순수 데이터로 남아야(JSX 없이도) 이 레지스트리를 단위 테스트할 수 있다. */
  shortcut?: string
}

/** 세션(=앱을 새로 띄운 뒤)당 새로 "소개"하는 힌트 개수의 상한. 잔소리를 막는 마지막 안전판이다. */
export const MAX_HINTS_PER_SESSION = 2

/**
 * 투어가 하던 소개를 그 기능에 실제로 도달한 순간으로 흩어 놓는다. anchor 는 새 마커를 만들지
 * 않고 실제 UI 에 이미 박혀 있는 것을 그대로 쓰는 게 원칙이지만, **컨트롤이 아니라 레이아웃
 * 컨테이너를 가리키는 기존 마커는 재사용하지 않는다** — 카드가 앵커 옆이 아니라 그 컨테이너의
 * 빈 구석에 뜨는 결과가 나기 때문이다(add-repo 를 'repos' 섹션 전체에 붙였다가 겪은 실패).
 * 그래서 `open-pr`(`ChatView.tsx` 의 "Create PR" 칩)과 `permission-mode`
 * (`Composer.tsx` 하단의 권한 모드 안내줄)에는 새 마커를 붙였다.
 *
 * 우선순위는 대략 "지금 막힌 사람이 가장 많이 겪는 순서" 로 매겼다.
 */
export const HINTS: Hint[] = [
  {
    id: 'permission-mode',
    anchor: 'permission-mode',
    priority: 30,
    when: (ctx) => ctx.selected?.awaitingPermission === true,
    body: 'Choose how much the agent can do on its own with permission modes.',
    shortcut: '⇧⇥'
  },
  {
    id: 'work-panel',
    // 'work-panel'(App.tsx) 이 아니라 'work-panel-toggle'(ChatView.tsx 헤더 버튼)을 가리킨다 —
    // 'work-panel' 은 패널이 열려 있을 때만 DOM 에 존재하는 내용물 컨테이너라, 정확히 "패널이
    // 닫혀 있을 때" 뜨는 이 힌트의 앵커로는 쓸 수 없다(항상 없는 것을 가리키게 된다).
    anchor: 'work-panel-toggle',
    priority: 40,
    when: (ctx) => !!ctx.selected && ctx.selected.changedFiles > 0 && !ctx.selected.panelOpen,
    body: 'Your changed files show up here — diff, checks, and a terminal, all scoped to this workspace.',
    shortcut: '⌘J'
  },
  {
    id: 'open-pr',
    anchor: 'open-pr',
    priority: 50,
    when: (ctx) => !!ctx.selected && ctx.selected.ahead > 0 && !ctx.selected.hasPr,
    body: 'Ready for review? Open a pull request for this branch.'
  },
  // Sidebar.tsx 에 있던 두 힌트를 그대로 옮긴 것 — 트리거 조건·우선순위(quick-switch 가
  // keyboard-switch 를 이긴다, 원래 코드의 `!showQuickSwitchHint` 와 같은 효과)를 그대로 유지한다.
  {
    id: 'quick-switch',
    priority: 60,
    when: (ctx) => ctx.visibleWorkspaceCount > 9,
    body: 'Only the top 9 rows get a ⌘number. Search the rest.',
    shortcut: '⌘K'
  },
  {
    id: 'keyboard-switch',
    priority: 61,
    when: (ctx) => ctx.mouseSwitchCount >= SWITCH_HINT_THRESHOLD && ctx.visibleWorkspaceCount > 1,
    body: 'Switch workspaces without leaving the keyboard.',
    shortcut: '⌘↑ / ⌘↓'
  },
  {
    id: 'review-pr',
    anchor: 'review-pr',
    priority: 70,
    when: (ctx) => ctx.anyOpenPr,
    body: "There's an open pull request — review it without leaving the app."
  },
  {
    id: 'shortcuts',
    priority: 80,
    when: (ctx) => ctx.totalWorkspaceCount >= 3,
    body: "There's a full shortcut list.",
    shortcut: '?'
  }
]

/** 병합·종료되지 않은 PR 상태 전부 — `review-pr` 힌트의 "열려 있다" 판정. */
export function isOpenPrState(state: PrState): boolean {
  return state !== 'merged' && state !== 'closed'
}

/**
 * 지금 화면에 띄울 힌트 하나를 고른다(없으면 null).
 *
 * 규칙: (1) 조건이 참이고 (2) 아직 닫힌 적 없는 것 중에서 (3) 우선순위가 가장 낮은 것 하나만.
 *
 * 세션당 상한(`MAX_HINTS_PER_SESSION`)은 "새로 소개"에만 걸린다 — 이미 이번 세션에 한 번 뜬
 * 힌트(`shownThisSession`)는 사용자가 아직 닫지 않은 채로 계속 보여야 한다. 상한에 걸려 다음
 * 렌더에서 꺼졌다 켜지면 그게 더 산만하다.
 */
export function selectHint(
  ctx: HintContext,
  opts: { seen: ReadonlySet<HintId>; shownThisSession: ReadonlySet<HintId> }
): Hint | null {
  const eligible = HINTS.filter((h) => !opts.seen.has(h.id) && h.when(ctx)).sort(
    (a, b) => a.priority - b.priority
  )
  for (const hint of eligible) {
    if (opts.shownThisSession.has(hint.id) || opts.shownThisSession.size < MAX_HINTS_PER_SESSION) {
      return hint
    }
  }
  return null
}
