import { CheckCircle2, Info, AlertTriangle, X } from 'lucide-react'
import { useStore, type ToastKind } from '../store'

/** 인앱 토스트. window.alert 를 대체해 다크 테마와 일관된 비차단 알림을 띄운다. */
export default function Toaster(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
      {/* role="alert" 를 여기 두지 않는다 — 토스트 내용은 LiveRegion(유일한 라이브 리전
          호스트)이 polite 로 읽는다. 여기 다시 붙이면 같은 문장이 두 리전에서 겹쳐 읽히고,
          방금 한 행동의 결과 보고일 뿐인 토스트가 읽던 것을 끊고 끼어든다. */}
      {toasts.map((t) => (
        <div
          key={t.id}
          // e2e 가 토스트를 집는 손잡이(fixtures.mjs 의 dismissToasts). 예전에는 role="alert" 로
          // 집었는데, ARIA 를 셀렉터로 겸용하면 접근성 결정을 바꾸는 순간 픽스처가 조용히 깨진다.
          data-toast=""
          className="flex items-start gap-2.5 rounded-lg border bg-[var(--surface)] px-3.5 py-2.5 shadow-2xl border-[var(--border)]"
        >
          <Icon kind={t.kind} />
          <div className="flex-1 min-w-0">
            <span className="block text-sm text-neutral-200 whitespace-pre-wrap break-words">
              {t.message}
            </span>
            {t.actions && t.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {t.actions.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      a.run()
                      dismiss(t.id)
                    }}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 py-1 text-xs font-medium text-neutral-100 hover:border-[var(--accent-500)]"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Icon({ kind }: { kind: ToastKind }): React.JSX.Element {
  if (kind === 'success')
    return <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[var(--success-400)]" />
  if (kind === 'error')
    return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--danger-400)]" />
  return <Info size={15} className="mt-0.5 shrink-0 text-[var(--info-400)]" />
}
