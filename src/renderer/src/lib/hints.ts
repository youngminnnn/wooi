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
 * `stack-work`·`peer-message`·`fan-out` 은 **Wooi 에만 있는 개념**을 맡는다 — 나머지는 어느
 * 에이전트 앱에나 있는 것들(권한 모드·diff 패널·PR·단축키)이라, 정작 사용자가 새로 배워야 하는
 * 것에는 아무 안내도 없었다. 경쟁 앱은 "세션 = worktree" 하나로 끝나 가르칠 게 없지만 Wooi 는
 * 수직 의존(스택)·같은 프롬프트 병렬(fan-out)·워크스페이스 간 메시지를 사용자가 새로 익혀야
 * 한다. 셋 다 **그 상황에 실제로 도달했을 때만** 뜬다(아래 각 when 의 주석 참고).
 *
 * `add-repo`·`new-workspace` 는 일부러 없다 — 리포 0개 화면은 `EmptyState.tsx` 가 이미
 * 맡고 있고(중앙에 크게, 리포가 생기면 "Press the + next to a repository" 로 문구까지 바뀐다),
 * 사이드바도 "No repositories yet." 를 늘 보여준다. 여기에 세 번째 목소리로 같은 말을 얹으면
 * 잔소리다 — repo-settings 힌트를 뺀 것과 같은 이유(hints 사다리 표 참고). 나머지 열은 전부
 * 사용자가 **워크스페이스 안에** 들어간 뒤에(또는 워크스페이스를 3개 이상 만든 뒤에) 뜨는
 * 것들이라 EmptyState 와 화면이 겹치지 않는다.
 */
export type HintId =
  | 'permission-mode'
  | 'work-panel'
  | 'stack-work'
  | 'open-pr'
  | 'quick-switch'
  | 'keyboard-switch'
  | 'peer-message'
  | 'review-pr'
  | 'fan-out'
  | 'shortcuts'

/** `HINTS` 의 id 만 뽑아 둔 목록. 힌트를 다 훑어야 하는 쪽(예: 처음 seen 집합 구성)이 쓴다. */
export const HINT_IDS: HintId[] = [
  'permission-mode',
  'work-panel',
  'stack-work',
  'open-pr',
  'quick-switch',
  'keyboard-switch',
  'peer-message',
  'review-pr',
  'fan-out',
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
  /**
   * 같은 리포의 다른 활성 워크스페이스 수(자기 자신 제외).
   *
   * `check_related_work` 가 하는 **파일 겹침 검사를 여기서 흉내 내지 않는다** — 그 검사는 비용
   * 때문에 사용자가 부를 때만 도는 on-demand 로 내려간 적이 있고, 힌트를 위해 상시 폴링으로
   * 되돌리면 같은 실수를 반복하게 된다. 대신 상시로 이미 알고 있는(= app.workspaces 에 그냥
   * 들어 있는) 이 수만 보고 힌트를 띄우고, 진짜 겹침 확인은 힌트가 안내하는 `/wooi:related` 로
   * 사용자가 직접 돌린다.
   */
  repoSiblingCount: number
  /** 스택 뿌리인지(= 다른 워크스페이스 위에 쌓여 있지 않다). */
  isStackRoot: boolean
  /** 이 워크스페이스 위에 쌓인 활성 워크스페이스가 하나라도 있는지. */
  hasStackedChildren: boolean
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
  /** 지금 턴을 돌고 있는 **다른** 워크스페이스 수(선택된 것은 빼고 센다). */
  otherRunningCount: number
  /** 지금까지 만든 fan-out 그룹 수. 0 이면 이 기능을 한 번도 써 본 적이 없다는 뜻이다. */
  fanoutGroupCount: number
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
 * 우선순위는 대략 "지금 막힌 사람이 가장 많이 겪는 순서" 로 매겼다. 세션당 상한
 * (`MAX_HINTS_PER_SESSION`)이 2 라서 이 숫자는 **경쟁 규칙**이지 장식이 아니다 — 힌트를 더할
 * 때마다 "새 힌트가 기존 힌트를 밀어내도 되는가" 를 여기서 정해야 한다. 지금 사다리와 그 이유:
 *
 * | 30 permission-mode | 승인 프롬프트가 떠 있다 = 지금 이 순간 진행이 막혀 있다.          |
 * | 40 work-panel      | 바꾼 파일이 있는데 볼 곳을 못 찾고 있다.                        |
 * | 45 stack-work      | 스택은 Wooi 에만 있는 개념이라 **화면 어디에도 단서가 없다**.    |
 * | 50 open-pr         | 같은 순간 open-pr 도 참이지만, 저건 "Create PR" 칩이 눈에 보인다. |
 * | 60 quick-switch    | 목록이 ⌘번호 범위를 넘겼다.                                     |
 * | 61 keyboard-switch | 마우스로만 전환하고 있다.                                       |
 * | 65 peer-message    | 지금 옆 워크스페이스가 돌고 있다 — **지나가면 사라지는 순간**이다. |
 * | 70 review-pr       | 열린 PR 은 없어지지 않는다 — 다음 기회가 얼마든지 있다.         |
 * | 78 fan-out         | 급하지 않지만 shortcuts 보다는 Wooi 를 쓰는 데 도움이 된다.      |
 * | 80 shortcuts       | 언제든 `?` 로 찾을 수 있다.                                     |
 *
 * 새로 낀 셋 중 `stack-work` 만 기존 힌트(open-pr)를 앞지른다. 그래도 밀어내지 않는 이유는
 * **조건을 더 좁게 잡았기 때문**이다 — 같은 리포에 다른 워크스페이스가 있어야 하고, 아직 아무것도
 * 쌓지 않은 뿌리여야 한다. 워크스페이스가 하나뿐인 사람에게는 아예 뜨지 않으므로 open-pr 이
 * 그대로 첫 자리를 지킨다. 둘 다 참인 사람은 그 세션에 두 개를 다 보게 되고(상한이 정확히 2),
 * 힌트는 한 번 보면 영영 사라지므로 이 경쟁은 한 세션에 한 번뿐이다. `hints.test.ts` 가 이
 * 순서와 "open-pr 이 두 번째 자리를 얻는다" 를 그대로 걸어 둔다.
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
    id: 'stack-work',
    // 앵커가 없다(= 인라인, 사이드바 아래). 이 힌트가 가리키고 싶은 것은 워크스페이스 행의
    // 호버 메뉴 안에 있는 "Stack a new workspace" 인데, 그 메뉴는 마우스를 올려야 열리고 행마다
    // 다른 위치라 안정적인 data-tour 마커를 붙일 곳이 없다. 인라인 카드는 원래 사이드바 관련
    // 힌트들의 자리이므로(Hint.tsx 아래쪽 주석) 톤도 맞는다.
    priority: 45,
    // 같은 리포에서 두 갈래 일이 동시에 굴러가고, 이 쪽은 아직 아무 위에도 쌓이지 않은 뿌리다 —
    // 스택이라는 개념이 실제로 필요해지는 상황이 정확히 이것이다. 이미 스택을 쓰고 있는 사람
    // (부모가 있거나 자식이 붙은 워크스페이스)에게는 가르칠 게 없으니 뜨지 않는다.
    //
    // **파일이 실제로 겹치는지는 여기서 보지 않는다.** 그 검사(`check_related_work`)는 비용
    // 때문에 on-demand 로 내려간 기능이라 힌트를 위해 상시로 되돌릴 수 없다 — 대신 상시로 이미
    // 아는 신호로 띄우고, 겹침 확인은 문구가 안내하는 `/wooi:related` 로 사용자가 돌린다.
    when: (ctx) =>
      !!ctx.selected &&
      ctx.selected.repoSiblingCount > 0 &&
      ctx.selected.isStackRoot &&
      !ctx.selected.hasStackedChildren &&
      (ctx.selected.ahead > 0 || ctx.selected.changedFiles > 0),
    body: 'Another workspace here has unlanded work. Ask /wooi:related whether it touches yours — anything that builds on it belongs in a stacked workspace.'
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
    id: 'peer-message',
    // 인라인. 이 힌트가 안내하는 `/wooi:send` 는 컴포저에 치는 슬래시 명령이라 가리킬 컨트롤이
    // 따로 없다 — 앵커를 억지로 붙이면 컴포저 전체(레이아웃 컨테이너)를 가리키게 된다.
    priority: 65,
    // 다른 워크스페이스가 **지금** 돌고 있을 때만. 두 에이전트가 동시에 굴러가는 걸 보고 있는
    // 그 순간이, 사용자가 결과를 손으로 옮겨 나르기 시작하는 순간이다. 조건이 지나가면 사라지는
    // 힌트라 review-pr(열린 PR 은 없어지지 않는다)보다 앞에 둔다.
    when: (ctx) => !!ctx.selected && ctx.otherRunningCount > 0,
    body: 'Another agent is running right now. Ask this one to /wooi:send it a note — workspaces can hand off without you relaying.'
  },
  {
    id: 'review-pr',
    anchor: 'review-pr',
    priority: 70,
    when: (ctx) => ctx.anyOpenPr,
    body: "There's an open pull request — review it without leaving the app."
  },
  {
    id: 'fan-out',
    // 인라인. 입구는 리포 행 `+` 메뉴의 "Fan out one prompt…" 인데, 그 메뉴 역시 눌러야 열린다.
    priority: 78,
    // fan-out 만은 "막힌 순간" 을 상태에서 읽어낼 방법이 없다 — 어떤 접근이 맞을지 모르겠다는
    // 것은 앱이 알 수 있는 사실이 아니다. 그래서 유일하게 숙련도로 대신한다: 워크스페이스를
    // 세 개 이상 만들어 봤는데 fan-out 은 한 번도 안 써 봤다. 그 대신 사다리에서는 거의 맨
    // 아래에 둔다(shortcuts 바로 위) — 근거가 약한 힌트가 근거가 확실한 힌트를 밀어내면 안 된다.
    when: (ctx) => ctx.fanoutGroupCount === 0 && ctx.totalWorkspaceCount >= 3,
    body: "Not sure which approach wins? Fan out one prompt from a repo's + menu — several workspaces try it at once and you keep one."
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
