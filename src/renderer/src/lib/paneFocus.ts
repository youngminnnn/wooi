import { createContext, useContext } from 'react'
import type { PaneSlot } from './splitPanes'

/**
 * "이 화면이 지금 포커스된 칸인가" 를 아래로 흘려 보내는 통로.
 *
 * 대화·리뷰 화면은 window 에 전역 리스너를 여럿 건다 — ⌘F 대화 검색, ⇧⌘↓ 맨 아래로, 드래그
 * 앤 드롭, Esc, 리뷰의 n/p. 지금까지는 그중 하나만 화면에 있었으므로 필터가 필요 없었다.
 * 나란히 두 개를 띄우는 순간 이 리스너들이 전부 두 번 발동한다 — 끌어다 놓은 파일이 두 대화에
 * 붙고, 한 번의 ⌘F 가 검색창 두 개를 연다.
 *
 * 그래서 각 칸을 이 context 로 감싸고, 전역 리스너는 `usePaneFocused()` 가 false 면 손을 뗀다.
 * **기본값이 focused: true** 라는 점이 중요하다 — provider 없이 그냥 렌더되던 기존 경로는
 * 한 글자도 달라지지 않는다.
 */
export type PaneFocusValue = {
  /** 이 칸이 키보드 입력의 주인인가. 분할이 아니면 늘 true. */
  focused: boolean
  /** 지금 화면이 둘로 나뉘어 있는가. 칸 안의 UI 가 자리를 아껴야 하는지 판단한다. */
  split: boolean
  slot: PaneSlot
}

export const PaneFocusContext = createContext<PaneFocusValue>({
  focused: true,
  split: false,
  slot: 'main'
})

/** 전역 리스너가 "내 차례인가" 를 묻는 자리. 분할이 아니면 언제나 true 다. */
export function usePaneFocused(): boolean {
  return useContext(PaneFocusContext).focused
}

export function usePaneFocus(): PaneFocusValue {
  return useContext(PaneFocusContext)
}
