import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type RowAction = {
  key: string
  label: string
  icon: React.ReactNode
  onSelect: () => void
  /** 파괴적 동작(아카이브 등)은 붉게 표시하고 구분선 위에 둔다. */
  danger?: boolean
  /** 위에 구분선을 넣는다. */
  separatorBefore?: boolean
  /** 같은 일을 하는 단축키(예: '⇧⌘⌫'). 메뉴 오른쪽에 흐리게 붙는다. */
  shortcut?: string
}

/**
 * 행(사이드바 워크스페이스) 오버플로 액션 메뉴.
 *
 * 사이드바 리스트는 `overflow-y-auto` 라서 행 안에 absolute 로 띄우면 위아래가 잘린다.
 * 그래서 body 로 portal 해 fixed 로 띄우고, 좌표는 호출측이 앵커(버튼 rect 또는 커서)로 넘긴다.
 * 스크롤/리사이즈가 일어나면 앵커와 어긋나므로 그냥 닫는다.
 */
export default function RowActionsMenu({
  at,
  align = 'left',
  actions,
  onClose
}: {
  at: { x: number; y: number }
  /** 'right' 면 메뉴의 우측 끝을 at.x 에 맞춘다(버튼 기준 정렬). */
  align?: 'left' | 'right'
  actions: RowAction[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  // 측정 전에는 숨겨서, 뒤집힐 때 한 프레임 튀는 걸 막는다.
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const M = 8
    let x = align === 'right' ? at.x - width : at.x
    let y = at.y
    if (x + width > window.innerWidth - M) x = window.innerWidth - M - width
    if (x < M) x = M
    // 아래로 넘치면 앵커 위쪽으로 뒤집는다.
    if (y + height > window.innerHeight - M) y = Math.max(M, at.y - height)
    setPos({ x, y })
    setReady(true)
  }, [at, align])

  useEffect(() => {
    if (!ready) return
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    )
    items[0]?.focus()

    const onDown = (e: MouseEvent): void => {
      // 메뉴가 portal 로 떠 있어 트리거 버튼은 ref 밖이다. 트리거의 mousedown 까지 "바깥 클릭"
      // 으로 처리하면 닫힌 직후 버튼의 onClick 이 다시 열어서 토글이 동작하지 않는다.
      if ((e.target as HTMLElement).closest?.('[data-row-actions-trigger]')) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      let next: number | null = null
      if (e.key === 'ArrowDown') next = (Math.max(current, -1) + 1) % items.length
      else if (e.key === 'ArrowUp') next = (current <= 0 ? items.length : current) - 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = items.length - 1
      if (next !== null && items.length) {
        e.preventDefault()
        items[next]?.focus()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    // capture: 사이드바 내부 스크롤도 잡는다(스크롤은 버블링하지 않는다).
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose, ready])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y, visibility: ready ? 'visible' : 'hidden' }}
      className="fixed z-50 w-52 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-xl"
      // portal 이어도 React 이벤트는 논리적 부모(행)로 버블링한다. 막지 않으면 메뉴 클릭이
      // 행 선택으로, 메뉴 우클릭이 다시 컨텍스트 메뉴로 새어 나간다.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {actions.map((a) => (
        <div key={a.key}>
          {a.separatorBefore && <div className="my-1 border-t border-[var(--border)]" />}
          <button
            role="menuitem"
            onClick={() => {
              onClose()
              a.onSelect()
            }}
            className={
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--surface-2)] ' +
              (a.danger ? 'text-[var(--danger-fg)]' : 'text-neutral-200')
            }
          >
            <span className="grid h-3.5 w-3.5 shrink-0 place-items-center text-neutral-400">
              {a.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            {a.shortcut && (
              <span className="shrink-0 text-[10px] text-neutral-600 tabular-nums">
                {a.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
