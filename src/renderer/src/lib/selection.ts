/**
 * 읽으라고 내놓은 글자는 고를 수 있어야 한다.
 *
 * 대화의 도구 결과·셸 출력·승인 카드는 "누르면 접히는" 덩어리 전체가 <button> 이다. 그런데
 * 크로미움은 버튼 안의 글자를 드래그로 고르지 못하게 막아서(브라우저 기본 스타일이
 * user-select: none), 화면에 뻔히 보이는 오류 메시지나 명령줄을 복사할 길이 없어진다.
 *
 * 그래서 두 가지를 함께 쓴다 — 선택을 되돌리는 클래스(SELECTABLE)와, 그렇게 고른 뒤 손을 뗄 때
 * 따라오는 클릭을 흘려보내는 래퍼(unlessSelecting). 하나만 쓰면 복사하려던 순간 카드가 접히거나
 * (승인 카드에선) 답이 제출돼 버린다.
 */

/**
 * 버튼 안의 글자에 드래그 선택을 되돌려 준다.
 *
 * 한 가지 단서가 있다 — 크로미움은 **버튼 자신의 글자**(직속 텍스트 노드)에서는 이 클래스가
 * 있어도 선택을 시작하지 못한다. 고르게 하려는 글자는 <pre>·<span> 같은 자식 요소 안에 있어야
 * 한다. 라벨 한 단어가 버튼에 그대로 박혀 있다면 span 으로 감싸 준다.
 */
export const SELECTABLE = 'select-text'

/**
 * 글자를 고르고 손을 뗀 클릭은 "누름" 으로 치지 않는다.
 *
 * 그냥 누르는 손짓은 mousedown 이 선택을 이미 접어 버리므로 여기 걸리지 않는다 — 걸리는 것은
 * 방금 드래그(또는 더블클릭)로 글자를 고른 경우뿐이다.
 */
export function unlessSelecting(run: () => void): () => void {
  return () => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return
    run()
  }
}
