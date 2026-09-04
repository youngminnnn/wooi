/**
 * 뷰포트가 **실제로** 커지거나 작아졌을 때만 부른다.
 *
 * 맨 `resize` 리스너를 쓰면 안 된다 — main 프로세스가 창을 되살릴 때(reveal·restore) 렌더러를
 * 한 번 리플로우시키는데, 크로미움은 `innerWidth`/`innerHeight` 가 그대로여도 그 순간 진짜
 * `resize` 를 쏜다. 그래서 `resize` 에 곧장 매달린 임시 UI(선택 복사 버블 같은 것)는 사용자가
 * 아무것도 하지 않았는데 창을 복원할 때마다 사라진다. 크기를 기억해 두고 달라졌을 때만 알린다.
 */
type ViewportTarget = Pick<Window, 'innerWidth' | 'innerHeight'> & {
  addEventListener: (type: 'resize', listener: () => void) => void
  removeEventListener: (type: 'resize', listener: () => void) => void
}

export function addViewportSizeChangeListener(
  onChange: () => void,
  target: ViewportTarget = window
): () => void {
  let lastWidth = target.innerWidth
  let lastHeight = target.innerHeight
  const onResize = (): void => {
    const { innerWidth, innerHeight } = target
    if (innerWidth === lastWidth && innerHeight === lastHeight) return
    lastWidth = innerWidth
    lastHeight = innerHeight
    onChange()
  }
  target.addEventListener('resize', onResize)
  return () => target.removeEventListener('resize', onResize)
}
