import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { orderVisibleWorkspaces } from '@shared/types'
import { useStore } from '../store'
import { anchorStyle, observeAnchor, type AnchorBox, type Placement } from '../lib/anchor'
import {
  HINTS,
  HINT_IDS,
  isOpenPrState,
  selectHint,
  type HintContext,
  type HintId
} from '../lib/hints'
import {
  SWITCH_HINT_DONE,
  hintSeenFlag,
  onSwitchHintChange,
  readUiFlag,
  setUiFlag,
  switchClickCount
} from '../lib/uiFlags'

/**
 * 점진적 온보딩 힌트의 유일한 호스트. `App.tsx` 에 딱 한 번 마운트된다(설정·투어·퀵스위처 등
 * 모달이 하나라도 떠 있는 동안은 마운트되지 않는다 — 그러지 않으면 모달 뒤에 깔려 보이지도
 * 않는 채로 이번 세션의 소개 슬롯만 축내는 카드가 생긴다).
 *
 * `lib/hints.ts` 의 `when` 은 순수 함수라 여기서 store 를 읽어 `HintContext` 스냅샷으로
 * 바꿔 주는 일까지가 이 컴포넌트의 몫이다. 두 형태로 그린다 — `data-tour` 마커 옆에 붙는 카드,
 * 그리고 가리킬 곳이 없는 힌트를 위한 인라인 카드(사이드바 하단 근처, 예전에 Sidebar.tsx 에
 * 하드코딩돼 있던 두 힌트가 있던 자리와 같은 톤).
 */

/** 카드가 앵커의 어느 쪽에 뜰지. 지정 없으면 anchorStyle 기본값(right)을 쓴다. */
const ANCHOR_PLACEMENT: Partial<Record<string, Placement>> = {
  'work-panel-toggle': 'left',
  'open-pr': 'bottom',
  'review-pr': 'bottom',
  // 컴포저 하단 안내줄은 화면 맨 아래에 있다 — 'bottom' 을 쓰면 카드가 뷰포트 밖으로 밀려난다.
  'permission-mode': 'top'
}

const CARD_W = 260

export default function Hint({
  anyModalOpen
}: {
  /**
   * 설정·투어·퀵스위처 등 모달이 하나라도 떠 있는지(App.tsx 의 anyModalOpen). true 인 동안은
   * 아무것도 그리지 않는다.
   *
   * **언마운트가 아니라 이 prop 으로 가린다** — 예전엔 App.tsx 가 온보딩이 끝날 때까지 아예
   * 마운트를 미뤘는데, 그 방식을 "모달이 하나라도 열려 있으면" 으로 넓히면 문제가 생긴다.
   * Settings 를 열었다 닫을 때마다 이 컴포넌트가 통째로 리마운트되면 세션 상태
   * (shownThisSession·seenIds·prevSelectedId) 가 매번 초기화돼, "세션당 최대 2개" 가
   * "마지막으로 모달을 닫은 뒤 최대 2개" 로 조용히 바뀐다. 계속 마운트해 두고 렌더만 끄면
   * showHints 를 끈 동안과 똑같이(주석 아래 참고) 세션 카운트도 그동안 자라지 않는다 — 다시
   * 열어도 억울하게 상한이 줄어 있지 않다.
   */
  anyModalOpen: boolean
}): React.JSX.Element | null {
  const app = useStore((s) => s.app)
  const selectedWorkspaceId = useStore((s) => s.selectedWorkspaceId)
  const gitStatus = useStore((s) => s.gitStatus)
  const prStatus = useStore((s) => s.prStatus)
  const rightPanelOpenByWorkspace = useStore((s) => s.rightPanelOpen)
  const permissions = useStore((s) => s.permissions)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const showHints = app?.settings.showHints ?? true

  // 마우스로만 워크스페이스를 전환한 누적 횟수. Sidebar.tsx 가 행 클릭마다 noteMouseSwitch() 를
  // 계속 부른다 — 그 신호를 여기서 구독한다(uiFlags 의 이벤트 버스, 카운트 자체는 localStorage).
  const [mouseSwitchCount, setMouseSwitchCount] = useState(() => switchClickCount())
  // 힌트별로 "이미 봤다" 플래그. quick-switch/keyboard-switch 는 예전 uiFlags 키를 그대로 쓴다.
  const [seenIds, setSeenIds] = useState<Set<HintId>>(
    () => new Set(HINT_IDS.filter((id) => readUiFlag(hintSeenFlag(id))))
  )
  useEffect(
    () =>
      // ⌘↑/⌘↓ 를 실제로 쓰면 App.tsx 의 키 핸들러가 finishSwitchHint() 로 SWITCH_HINT_DONE 을
      // 직접 세운다(이 컴포넌트를 거치지 않는 경로) — 그 변화를 놓치지 않도록 같은 이벤트를 듣는다.
      onSwitchHintChange(() => {
        setMouseSwitchCount(switchClickCount())
        setSeenIds((prev) => {
          const done = readUiFlag(SWITCH_HINT_DONE)
          if (done === prev.has('keyboard-switch')) return prev
          const next = new Set(prev)
          if (done) next.add('keyboard-switch')
          else next.delete('keyboard-switch')
          return next
        })
      }),
    []
  )

  // store 셀렉터는 원시값이거나 참조가 안정적인 조각만 돌려준다(React #185 — backends.ts 의
  // useAvailableBackends 와 같은 규율). 파생 계산은 전부 이 useMemo 안, 셀렉터 밖에서 한다.
  const ctx: HintContext = useMemo(() => {
    const repos = app?.repos ?? []
    const workspaces = app?.workspaces ?? []
    const visible = orderVisibleWorkspaces(repos, workspaces)
    const selectedWs = selectedWorkspaceId
      ? (workspaces.find((w) => w.id === selectedWorkspaceId) ?? null)
      : null
    const anyOpenPr = workspaces.some((w) => {
      if (w.archived) return false
      const pr = prStatus[w.id]
      return !!pr && isOpenPrState(pr.state)
    })
    // stack-work 가 보는 "같은 리포의 다른 일". app.workspaces 는 main 이 늘 밀어 주는 값이라
    // 여기서 세는 데 추가 조회가 전혀 들지 않는다 — 파일 겹침 검사(check_related_work)를 상시로
    // 돌리지 않기로 한 결정이 그대로 지켜진다(lib/hints.ts 의 repoSiblingCount 주석).
    const activeInRepo = selectedWs
      ? workspaces.filter((w) => !w.archived && w.repoId === selectedWs.repoId)
      : []
    return {
      totalWorkspaceCount: workspaces.length,
      visibleWorkspaceCount: visible.length,
      mouseSwitchCount,
      anyOpenPr,
      otherRunningCount: workspaces.filter(
        (w) => !w.archived && w.status === 'running' && w.id !== selectedWs?.id
      ).length,
      fanoutGroupCount: app?.fanoutGroups?.length ?? 0,
      selected: selectedWs
        ? {
            ahead: gitStatus[selectedWs.id]?.ahead ?? 0,
            changedFiles: gitStatus[selectedWs.id]?.changedFiles ?? 0,
            hasPr: prStatus[selectedWs.id] != null,
            panelOpen:
              rightPanelOpenByWorkspace[selectedWs.id] ??
              app?.settings.defaultRightPanelOpen ??
              true,
            awaitingPermission: permissions.some((p) => p.workspaceId === selectedWs.id),
            repoSiblingCount: activeInRepo.filter((w) => w.id !== selectedWs.id).length,
            isStackRoot: selectedWs.parentWorkspaceId == null,
            hasStackedChildren: activeInRepo.some((w) => w.parentWorkspaceId === selectedWs.id)
          }
        : null
    }
  }, [
    app,
    selectedWorkspaceId,
    gitStatus,
    prStatus,
    rightPanelOpenByWorkspace,
    permissions,
    mouseSwitchCount
  ])

  // 이번 세션(=이 컴포넌트가 마운트된 뒤)에 실제로 소개된 힌트 id 들 — 세션당 상한의 분모.
  const [shownThisSession, setShownThisSession] = useState<Set<HintId>>(new Set())
  // 직전에 골랐던 힌트. "조건이 스스로 사라졌다" 를 판정하려면 지난 렌더의 선택을 기억해야 한다.
  const [prevSelectedId, setPrevSelectedId] = useState<HintId | null>(null)

  // showHints(설정 스위치)·anyModalOpen(모달 가림) 둘 다 candidate 선정 자체에는 관여하지
  // 않는다 — 아래에서 selected 를 가릴 때만 쓴다. 여기서 그 상태를 후보 선정에 섞으면(예:
  // candidate 자체를 null 로 두면), 꺼지거나 가려지는 순간 "조건이 스스로 사라졌다" 로 오판해
  // 지금 보이던 힌트를 전부 seen 처리해 버리는 버그가 된다 — 그건 사용자의 결정(끄기)이거나
  // 잠깐의 화면 상태(모달)지 학습이 아니다.
  //
  // 반면 세션 카운트(shownThisSession)는 둘 중 하나라도 켜져 있는 동안은 자라지 않는다 — 그
  // 갱신은 selected(= 둘 다 아닐 때만 candidate)가 실제로 그려질 때만 아래 effect 에서
  // 일어나므로, 가려진 동안은 애초에 그릴 게 없어 자연히 멈춘다. 다시 보여도 "이미 두 개를 다
  // 써서 아무것도 안 뜬다" 같은 억울한 상태가 남지 않는다.
  const candidate = selectHint(ctx, { seen: seenIds, shownThisSession })

  // React 문서가 권장하는 "이전 렌더 값과 비교해 파생 상태를 갱신" 패턴 — effect 가 아니라 렌더
  // 중에 직접 setState 한다. prevSelectedId 가 같아지는 즉시 이 분기를 벗어나므로 무한 루프는 나지 않는다.
  //
  // candidate 가 null 일 때 candidate?.id 는 undefined 다 — prevSelectedId(null 로 초기화·저장)와
  // `!==` 로 바로 비교하면 undefined !== null 이 항상 참이라 이 분기를 매 렌더 다시 타고, 값이
  // 실제로는 안 바뀌었는데도 setState 를 계속 불러 "Too many re-renders" 로 죽는다. 그래서 양쪽을
  // 같은 모양(HintId | null)으로 맞춘 뒤에 비교한다.
  //
  // 여기서는 **auto-retire 만** 한다(조건이 스스로 사라진 이전 후보를 seen 처리) — "이번 세션에
  // 실제로 보여줬다" 는 별개의 판정이라 여기서 하지 않는다. candidate 는 뽑히기만 했을 뿐 아직
  // 화면에 뜬다는 보장이 없다(앵커형이면 DOM 에 있는지 확인 전이다). 여기서 바로
  // shownThisSession 에 넣으면, 앵커가 없어 끝내 안 뜨는 힌트(예: Overview 밖에서 뽑힌
  // review-pr)가 세션 상한을 조용히 먹어 버리고, 정작 뜰 수 있었던 다른 힌트까지 막혀 아무것도
  // 안 뜨는데 이유를 알 방법이 없는 상태가 된다 — 아래 앵커 측정 effect 에서, 실제로 뜨는 게
  // 확정된 순간에만 상한을 깎는다.
  const candidateId = candidate?.id ?? null
  if (candidateId !== prevSelectedId) {
    if (prevSelectedId) {
      const prevHint = HINTS.find((h) => h.id === prevSelectedId)
      // X 로 닫은 게 아니라 조건이 스스로 사라졌다(예: repo 를 추가해 add-repo 가 거짓이 됐다) —
      // 행동으로 배운 것이니 다시 띄우지 않는다. SWITCH_HINT_DONE 과 같은 논리(uiFlags.ts).
      if (prevHint && !seenIds.has(prevHint.id) && !prevHint.when(ctx)) {
        setUiFlag(hintSeenFlag(prevHint.id), true)
        setSeenIds((s) => new Set(s).add(prevHint.id))
      }
    }
    setPrevSelectedId(candidateId)
  }

  // anyModalOpen 도 showHints 와 같은 자리에서 candidate 를 가린다 — 모달 밑에 깔려 안 보이는
  // 채로 세션 슬롯만 축내는 카드가 생기지 않도록(위 prop 주석 참고).
  const selected = showHints && !anyModalOpen ? candidate : null

  // 앵커 위치 측정(있으면). 대상이 DOM 에 없으면 렌더하지 않는다 — 투어와 달리 가운데 카드로
  // 대체하지 않는다(가리킬 게 없으면 알릴 때가 아니다).
  //
  // shownThisSession 갱신도 여기서 한다 — "실제로 화면에 떴다" 를 확정할 수 있는 유일한 지점이다.
  // 인라인 힌트(anchor 없음)는 뽑히면 곧장 뜨므로 즉시 센다. 앵커형은 observeAnchor 가 요소를
  // 찾았을 때만 센다 — 못 찾으면(그 순간 렌더되지 않으면) 카운트도 하지 않는다.
  const [rect, setRect] = useState<AnchorBox | null>(null)
  useLayoutEffect(() => {
    if (!selected) {
      setRect(null)
      return
    }
    const id = selected.id
    if (!selected.anchor) {
      setRect(null)
      setShownThisSession((s) => (s.has(id) ? s : new Set(s).add(id)))
      return
    }
    // 창 크기가 그대로여도 앵커는 움직인다(헤더에 비동기로 버튼이 붙는 등) — `observeAnchor` 가
    // 프레임마다 재고 값이 바뀔 때만 알려 준다. 자세한 이유는 `lib/anchor.ts`.
    return observeAnchor(selected.anchor, (found) => {
      setRect(found)
      if (found) setShownThisSession((s) => (s.has(id) ? s : new Set(s).add(id)))
    })
    // selected 를 그대로 deps 에 쓴다 — HINTS 는 모듈 최상단 상수라 같은 id 의 Hint 객체는 항상
    // 같은 참조다(selectHint 가 그 배열 원소를 그대로 돌려준다), 그러니 매 렌더 새 객체가 생겨
    // effect 가 불필요하게 도는 일은 없다. ctx 도 넣은 건 의도적이다 — 앵커 키가 그대로여도
    // 레이아웃에 영향을 줄 수 있는 다른 상태 변화(선택 워크스페이스 전환 등) 때마다 다시 잰다.
  }, [selected, ctx])

  if (!selected) return null
  if (selected.anchor && !rect) return null

  const dismiss = (): void => {
    if (seenIds.has(selected.id)) return
    setUiFlag(hintSeenFlag(selected.id), true)
    setSeenIds((s) => new Set(s).add(selected.id))
  }

  const body = (
    <div className="flex items-start gap-2">
      <p className="flex-1 leading-relaxed">
        {selected.body}
        {selected.shortcut && (
          <>
            {' '}
            <kbd className="font-medium text-neutral-300">{selected.shortcut}</kbd>
          </>
        )}
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss hint"
        title="Got it"
        className="shrink-0 -mr-0.5 h-4 w-4 grid place-items-center rounded text-neutral-600 hover:bg-[var(--surface-2)] hover:text-neutral-300"
      >
        <X size={11} />
      </button>
    </div>
  )

  // 앵커형: data-tour 요소 옆에 뜬다. 전체 화면 스크림·스포트라이트 링(FeatureTour 의
  // box-shadow: 0 0 0 9999px)은 쓰지 않는다 — 투어와 달리 이건 시선을 붙잡을 만한 지식이 아니다.
  // 대신 앵커 둘레에 얇은 링 하나만 둔다 — 카드가 클램핑으로 살짝 밀려도(뷰포트 가장자리 등)
  // "이게 그 얘기다" 가 분명하도록 실제 대상 위에 직접 표시를 남긴다. 화살표 대신 링을 고른
  // 이유: 카드가 어느 쪽으로 밀리든 항상 정확한 위치라 방향 계산이 필요 없다.
  if (selected.anchor && rect) {
    return (
      <>
        <div
          aria-hidden
          className="pointer-events-none fixed z-40 rounded-md ring-2 ring-[var(--info-500)]/50"
          style={{
            top: rect.top - 3,
            left: rect.left - 3,
            width: rect.width + 6,
            height: rect.height + 6
          }}
        />
        <div
          className="no-drag fixed z-40 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-neutral-500 shadow-lg"
          style={anchorStyle(rect, ANCHOR_PLACEMENT[selected.anchor] ?? 'right', CARD_W, 120)}
        >
          {body}
        </div>
      </>
    )
  }

  // 인라인형(anchor 없음): 가리킬 대상이 없는 힌트(quick-switch·keyboard-switch·shortcuts)는
  // 전부 사이드바 관련이라, 사이드바 폭에 맞춰 그 아래쪽에 떠 있는 것처럼 보이게 고정한다 —
  // Sidebar.tsx 에서 옮겨오기 전 실제로 그 자리(목록 맨 아래)에 있던 두 힌트와 같은 위치·톤이다.
  return (
    <div
      className="no-drag fixed z-40 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-neutral-500 shadow-lg"
      style={{ left: 8, bottom: 8, width: Math.max(200, sidebarWidth - 16) }}
    >
      {body}
    </div>
  )
}
