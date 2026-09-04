import { useRef } from 'react'
import { useStore } from '../store'
import { PaneFocusContext } from '../lib/paneFocus'
import type { PaneSlot, PaneView } from '../lib/splitPanes'
import ChatView from './ChatView'
import PrReviewScreen from './review/PrReviewScreen'
import Splitter from './Splitter'

/**
 * 관계 있는 두 개를 나란히 놓는 화면.
 *
 * 자유롭게 쪼갤 수 있는 레이아웃이 아니다 — 칸은 언제나 둘이고, 무엇과 무엇이 나란히 설 수
 * 있는지는 `lib/splitPanes` 가 이미 판정해 둔 뒤다. 여기서 하는 일은 그 둘을 그리고, **어느
 * 쪽이 지금 키보드의 주인인지**를 눈에 보이게 하는 것뿐이다. 포커스가 보이지 않으면 사이드바를
 * 클릭했을 때 어느 칸이 바뀔지 알 수 없고, 그 순간 분할은 예측할 수 없는 화면이 된다.
 */
export default function SplitPanes({
  main,
  split,
  contentWidth
}: {
  main: PaneView
  split: PaneView
  /** 두 칸이 나눠 쓰는 영역의 실제 너비(px). 분할바의 픽셀 이동을 비율로 환산하는 데 쓴다. */
  contentWidth: number
}): React.JSX.Element {
  const focus = useStore((s) => s.splitFocus)
  const fraction = useStore((s) => s.splitFraction)
  const setFraction = useStore((s) => s.setSplitFraction)
  const base = useRef(fraction)

  return (
    <>
      <PaneFrame slot="main" focused={focus === 'main'} width={`${fraction * 100}%`}>
        <PaneBody view={main} />
      </PaneFrame>
      <Splitter
        axis="x"
        label="Resize the two panes"
        onStart={() => (base.current = useStore.getState().splitFraction)}
        onDelta={(dx) => contentWidth && setFraction(base.current + dx / contentWidth)}
        onReset={() => setFraction(0.5)}
      />
      <PaneFrame slot="split" focused={focus === 'split'}>
        <PaneBody view={split} />
      </PaneFrame>
    </>
  )
}

/**
 * 칸 하나의 테두리.
 *
 * 포커스는 **누른 곳**을 따라간다 — 칸 안 어디를 눌러도(입력창, 버튼, 스크롤) 그 칸이 주인이
 * 된다. mousedown 캡처로 받는 이유는 그 안의 버튼이 클릭을 삼켜도 포커스는 옮겨져야 하기
 * 때문이고, focus 캡처를 함께 받는 이유는 탭 이동만으로 칸을 옮기는 경우가 있기 때문이다.
 */
function PaneFrame({
  slot,
  focused,
  width,
  children
}: {
  slot: PaneSlot
  focused: boolean
  /** 주 칸만 폭을 정한다. 나머지 폭은 분할 칸이 가져간다. */
  width?: string
  children: React.ReactNode
}): React.JSX.Element {
  const focusPane = useStore((s) => s.focusPane)
  return (
    <div
      data-pane={slot}
      data-pane-focused={focused ? 'true' : undefined}
      style={width ? { width } : undefined}
      onMouseDownCapture={() => focusPane(slot)}
      onFocusCapture={() => focusPane(slot)}
      className={`relative flex min-w-0 ${width ? 'shrink-0' : 'flex-1'} ${
        focused ? 'ring-1 ring-inset ring-[var(--focus-ring)]/40' : ''
      }`}
    >
      <PaneFocusContext.Provider value={{ focused, split: true, slot }}>
        <div className="flex-1 min-w-0">{children}</div>
      </PaneFocusContext.Provider>
    </div>
  )
}

/** 칸이 담은 것을 그린다. 담을 수 있는 것은 대화와 리뷰 둘뿐이다. */
function PaneBody({ view }: { view: PaneView }): React.JSX.Element | null {
  const workspace = useStore((s) =>
    view.kind === 'workspace' ? s.app?.workspaces.find((w) => w.id === view.workspaceId) : undefined
  )
  if (view.kind === 'review') return <PrReviewScreen key={view.reviewId} reviewId={view.reviewId} />
  // 워크스페이스가 막 사라진 순간 — 스토어가 다음 방송에서 이 칸을 접는다.
  if (!workspace) return null
  return <ChatView key={workspace.id} workspace={workspace} />
}
