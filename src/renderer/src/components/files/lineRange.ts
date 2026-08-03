/**
 * 뷰어에서 드래그로 고른 영역의 줄 범위(1-based). 선택이 없거나 뷰어 밖이면 null.
 *
 * 하이라이트된 DOM 은 <span> 으로 잘게 쪼개져 있어 노드 단위로는 줄을 셀 수 없다.
 * 그래서 <pre> 전체 텍스트에서 선택 시작까지의 문자 수를 세어 개행 개수로 환산한다
 * (hljs 는 텍스트를 그대로 보존하므로 원본 문자열과 오프셋이 일치한다).
 *
 * 줄 번호 gutter 를 이 <pre> **안에** 넣으면 오프셋이 어긋나 범위가 통째로 밀린다 —
 * gutter 는 반드시 형제 요소로 둘 것.
 */
export function selectedLineRange(
  pre: HTMLElement | null,
  text: string
): { from: number; to: number } | null {
  const sel = window.getSelection()
  if (!pre || !sel || sel.isCollapsed || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)
  if (!pre.contains(range.commonAncestorContainer)) return null

  const upToStart = range.cloneRange()
  upToStart.selectNodeContents(pre)
  upToStart.setEnd(range.startContainer, range.startOffset)
  const start = upToStart.toString().length
  const selected = range.toString()
  if (!selected) return null

  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length
  // 끝은 -1 해서 선택이 개행으로 끝날 때 다음 줄까지 삼키지 않게 한다.
  return { from: lineOf(start), to: lineOf(start + selected.length - 1) }
}
