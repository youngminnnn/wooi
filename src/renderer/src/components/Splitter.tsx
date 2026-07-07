import { useRef } from 'react'

/**
 * 드래그로 인접 영역 크기를 조절하는 분할바.
 * axis='x' 는 세로 막대(좌우 너비 조절), axis='y' 는 가로 막대(상하 높이 조절).
 * onStart 에서 기준값을 스냅샷하고, onDelta(dx, dy)(드래그 시작점 대비 누적 이동)로 적용한다.
 */
export default function Splitter({
  axis,
  onStart,
  onDelta
}: {
  axis: 'x' | 'y'
  onStart: () => void
  onDelta: (dx: number, dy: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startY = e.clientY
    onStart()
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      onDelta(ev.clientX - startX, ev.clientY - startY)
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const base = 'shrink-0 bg-[var(--border)] hover:bg-[var(--border-strong)] transition-colors'
  const cls =
    axis === 'x'
      ? `${base} w-px hover:w-0.5 cursor-col-resize`
      : `${base} h-px hover:h-0.5 cursor-row-resize`

  // 1px 막대는 잡기 어려우므로 투명한 넓은 히트 영역을 겹쳐 둔다.
  const hit =
    axis === 'x'
      ? 'absolute inset-y-0 -left-1 -right-1 cursor-col-resize'
      : 'absolute inset-x-0 -top-1 -bottom-1 cursor-row-resize'

  return (
    <div className={`relative ${cls}`} onMouseDown={onMouseDown}>
      <div className={hit} />
    </div>
  )
}
