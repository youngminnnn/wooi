import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'

export default function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 위에 confirm 대화상자가 떠 있으면 Escape 는 그쪽이 처리한다(하위 모달까지 닫히지 않게).
      if (e.key === 'Escape' && !useStore.getState().confirmState) onClose()
      if (e.key !== 'Tab' || useStore.getState().confirmState) return
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 열릴 때 '한 번만' 첫 포커스 가능한 요소로 포커스를 옮긴다. onClose 가 매 렌더 새 클로저여도
  // 재실행되지 않도록 마운트 전용 이펙트로 분리한다(리렌더마다 포커스를 뺏는 문제 방지).
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    )
    first?.focus()
    return () => openerRef.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="no-drag bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl max-w-[92vw] max-h-[88vh] flex flex-col"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 h-12 border-b border-[var(--border)]">
          <h3 id={titleId} className="text-base font-semibold text-neutral-100">
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-[var(--accent-500)]"
          >
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export const inputClass =
  'w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-base text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-[var(--border-strong)] transition-colors'

export const labelClass = 'block text-xs font-medium text-neutral-400 mb-1.5'

export const primaryBtn =
  'text-sm px-3.5 py-1.5 rounded-lg bg-[var(--info-600)] text-white font-medium shadow-sm hover:bg-[var(--info-500)] disabled:bg-[var(--border)] disabled:text-neutral-600 disabled:shadow-none disabled:cursor-not-allowed'

export const ghostBtn =
  'text-sm px-3.5 py-1.5 rounded-lg text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100'
