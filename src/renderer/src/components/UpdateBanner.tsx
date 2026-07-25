import { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'

/**
 * 자동 업데이트 배너. main 의 evtUpdate 를 구독해, 새 버전이 다운로드 완료(`ready`)되면
 * "재시작하여 업데이트" 배너를 띄운다. 다운로드 중에는 진행률만 조용히 보여 준다.
 * 사용자가 닫으면(dismiss) 이번 실행 동안은 다시 뜨지 않는다(앱 종료 시 자동 설치됨).
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => window.api.onUpdate(setStatus), [])

  if (dismissed) return null

  if (status.state === 'ready') {
    return (
      <div className="no-drag shrink-0 flex items-center justify-center gap-3 h-8 bg-[var(--accent-500)]/12 border-b border-[var(--accent-500)]/25 text-sm text-[var(--accent-300)]">
        <Download size={13} />
        <span>A new version{status.version ? ` (${status.version})` : ''} is ready.</span>
        <button
          onClick={() => window.api.update.quitAndInstall()}
          className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
        >
          <RefreshCw size={12} />
          Restart to update
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="ml-1 opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    )
  }

  if (status.state === 'downloading') {
    return (
      <div className="no-drag shrink-0 flex items-center justify-center gap-2 h-7 bg-[var(--bg-2)] border-b border-[var(--border)] text-xs text-neutral-400">
        <Download size={12} className="animate-pulse" />
        Downloading update… {status.percent ?? 0}%
      </div>
    )
  }

  return null
}
