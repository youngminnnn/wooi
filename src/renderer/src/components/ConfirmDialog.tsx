import { useEffect } from 'react'
import { useStore } from '../store'

/**
 * 인앱 확인 대화상자. window.confirm 을 대체한다.
 * store.confirm(opts) 가 Promise<boolean> 를 반환하고, 여기서 resolve 한다.
 */
export default function ConfirmDialog(): React.JSX.Element | null {
  const state = useStore((s) => s.confirmState)
  const resolve = useStore((s) => s.resolveConfirm)

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolve(false)
      else if (e.key === 'Enter') resolve(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, resolve])

  if (!state) return null

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55"
      onMouseDown={() => resolve(false)}
    >
      <div
        className="no-drag w-[400px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-neutral-100">{state.title}</h3>
        {state.body && (
          <p className="mt-2 text-sm text-neutral-400 leading-relaxed whitespace-pre-wrap">
            {state.body}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => resolve(false)}
            className="text-sm px-3.5 py-1.5 rounded-lg text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={() => resolve(true)}
            className={
              'text-sm px-3.5 py-1.5 rounded-lg font-medium shadow-sm ' +
              (state.danger
                ? 'bg-[var(--danger-500)]/90 text-white hover:bg-[var(--danger-500)]'
                : 'bg-[var(--info-600)] text-white hover:bg-[var(--info-500)]')
            }
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
