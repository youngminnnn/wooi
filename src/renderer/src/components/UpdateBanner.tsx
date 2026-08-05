import { useEffect, useState } from 'react'
import { Clock, Download, RefreshCw, X } from 'lucide-react'
import { useStore } from '../store'
import { DOWNLOAD_URL, scheduledRestartText } from '../lib/update'
import { useNow } from '../lib/useNow'

/**
 * 자동 업데이트 배너. main 의 evtUpdate 를 구독해 새 릴리스를 눈에 띄게 알린다.
 *
 * - `available`  — 새 버전을 찾았고 백그라운드로 받는 중.
 * - `downloading`— 진행률만 조용히.
 * - `ready`      — "재시작하여 업데이트" + "작업 끝나면 재시작" 예약.
 * - `blocked`    — 자동 설치가 막힌 위치인데 새 버전이 나온 경우 → 수동 내려받기 안내.
 *
 * ready 에서 재시작은 두 갈래다. 지금 누르면 진행 중인 턴이 끊기므로, 여러 워크스페이스를
 * 돌려 두고 자리를 비우는 쓰임새를 위해 "다 끝나면 알아서 재시작"을 예약할 수 있다. 예약 중에는
 * 무엇을 기다리는지(남은 작업 수)와, 조건이 충족된 뒤의 카운트다운을 그대로 보여 준다 —
 * 앱이 예고 없이 사라지지 않게 하는 것이 이 배너의 역할이다.
 *
 * 닫기(dismiss)는 "지금은 그만"이지 "영원히 숨김"이 아니다. 상태나 버전이 바뀌면 다시 뜨고,
 * 같은 상태라도 RESHOW_MS 가 지나면 다시 뜬다 — 며칠씩 켜 두는 앱이라 한 번 닫으면
 * 영영 못 보는 게 새 버전을 놓치는 가장 큰 원인이었다.
 */

const RESHOW_MS = 8 * 60 * 60 * 1000 // 8h

export function UpdateBanner(): React.JSX.Element | null {
  const status = useStore((s) => s.updateStatus)
  // 닫은 대상(`상태:버전`). 다른 대상이 되면 자동으로 다시 보인다.
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (!dismissed) return
    const timer = setTimeout(() => setDismissed(null), RESHOW_MS)
    return () => clearTimeout(timer)
  }, [dismissed])

  // 카운트다운이 걸려 있는 동안만 1초마다 다시 그린다(남은 시간을 보여 줘야 취소할 수 있다).
  const now = useNow(1000, !!status.restartAt)

  const key = `${status.state}:${status.version ?? ''}`
  // 예약이 걸려 있으면 닫아 뒀더라도 다시 보인다 — 예고 없이 재시작되지 않게 하는 유일한 창이다.
  const hidden = dismissed === key && !status.restartWhenIdle
  const version = status.version ? ` (${status.version})` : ''

  const close = (
    <button
      onClick={() => setDismissed(key)}
      className="ml-1 opacity-60 hover:opacity-100"
      aria-label="Dismiss"
    >
      <X size={13} />
    </button>
  )

  if (status.state === 'ready' && !hidden) {
    const scheduled = !!status.restartWhenIdle
    return (
      <div className="no-drag shrink-0 flex items-center justify-center gap-3 h-8 bg-[var(--accent-500)]/12 border-b border-[var(--accent-500)]/25 text-sm text-[var(--accent-300)]">
        {scheduled ? <Clock size={13} /> : <Download size={13} />}
        <span>
          {scheduled ? scheduledRestartText(status, now) : `A new version${version} is ready.`}
        </span>
        <button
          onClick={() => window.api.update.quitAndInstall()}
          className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
        >
          <RefreshCw size={12} />
          {scheduled ? 'Restart now' : 'Restart to update'}
        </button>
        <button
          onClick={() => void window.api.update.setRestartWhenIdle(!scheduled)}
          className="inline-flex items-center gap-1 underline underline-offset-2 opacity-80 hover:opacity-100"
        >
          {scheduled ? 'Cancel' : 'Restart when work finishes'}
        </button>
        {close}
      </div>
    )
  }

  // 자동 설치가 막힌 위치 — 새 버전을 찾아냈을 때만 알린다(설치 위치 안내는 설정에 있다).
  if (status.state === 'blocked' && status.version && !hidden) {
    return (
      <div className="no-drag shrink-0 flex items-center justify-center gap-3 h-8 bg-[var(--warning-500)]/12 border-b border-[var(--warning-500)]/25 text-sm text-[var(--warning-300)]">
        <Download size={13} />
        <span>Version {status.version} is out — Wooi can’t update itself from here.</span>
        <button
          onClick={() => void window.api.openExternal(DOWNLOAD_URL)}
          className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
        >
          Download it
        </button>
        {close}
      </div>
    )
  }

  if (status.state === 'available' && !hidden) {
    return (
      <div className="no-drag shrink-0 flex items-center justify-center gap-3 h-8 bg-[var(--accent-500)]/12 border-b border-[var(--accent-500)]/25 text-sm text-[var(--accent-300)]">
        <Download size={13} className="animate-pulse" />
        <span>A new version{version} is out — downloading it in the background.</span>
        {close}
      </div>
    )
  }

  // 진행률은 정보일 뿐이라 닫기를 두지 않는다(끝나면 ready 배너로 바뀐다).
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
