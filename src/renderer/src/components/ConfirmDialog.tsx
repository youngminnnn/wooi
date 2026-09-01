import { useEffect, useState } from 'react'
import { useStore } from '../store'

/**
 * 인앱 확인 대화상자. window.confirm 을 대체한다.
 * store.confirm(opts) 가 Promise<boolean> 를 반환하고, 여기서 resolve 한다.
 *
 * opts.skipKey 가 있으면 "Don't ask again" 체크박스가 붙는다. 체크는 **승인했을 때만**
 * 저장된다(resolveConfirm 이 그렇게 판단한다).
 */
export default function ConfirmDialog(): React.JSX.Element | null {
  const state = useStore((s) => s.confirmState)
  const resolve = useStore((s) => s.resolveConfirm)
  const [skip, setSkip] = useState(false)

  // 대화상자가 새로 열릴 때마다 체크박스는 꺼진 상태로 시작한다.
  useEffect(() => setSkip(false), [state])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolve(false)
      else if (e.key === 'Enter') resolve(true, skip)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, resolve, skip])

  if (!state) return null

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50"
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
        <div className="mt-5 flex items-center justify-between gap-4">
          {/*
            체크박스는 언제나 꺼진 채로 열리고, 포커스는 확인 버튼이 가져간다(autoFocus).
            Enter 로 연 대화상자가 그 Enter 로 즉시 승인되는 알려진 함정이 있는데, 그때 넘어가는
            skip 은 false 다 — 사용자가 스킵을 켤 의도가 없었으므로 아무것도 저장되지 않는다.
            켜려면 마우스로 누르거나 Tab 으로 옮겨 Space 를 눌러야 한다.
          */}
          {state.skipKey ? (
            <label className="flex select-none items-center gap-2 text-xs text-neutral-400 hover:text-neutral-300">
              <input
                type="checkbox"
                checked={skip}
                onChange={(e) => setSkip(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--info-600)]"
              />
              Don&apos;t ask again
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={() => resolve(false)}
              className="text-sm px-3.5 py-1.5 rounded-lg text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100"
            >
              Cancel
            </button>
            <button
              autoFocus
              onClick={() => resolve(true, skip)}
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
    </div>
  )
}
