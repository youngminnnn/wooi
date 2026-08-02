import { useState } from 'react'
import { AlertTriangle, ExternalLink, Info, OctagonAlert, X } from 'lucide-react'
import type { AppNotice, NoticeLevel } from '@shared/types'
import { useStore } from '../store'
import { noticeDismissedFlag, readUiFlag, setUiFlag } from '../lib/uiFlags'

/**
 * 원격 공지 배너(타이틀바 바로 아래).
 *
 * main 이 원격 JSON 에서 가져온 공지를 띄운다 — 앱 버전과 무관하게 메시지를 전달하는 통로다.
 * 사용자가 X 로 닫으면 그 공지 id 는 이 기기에서 다시 뜨지 않는다(uiFlags 에 영구 기록).
 *
 * 한 번에 **하나만** 띄운다. 상단 띠가 여러 겹으로 쌓이면 그 자체가 방해가 되기 때문이다.
 * 우선순위는 원격 JSON 의 배열 순서 — 위에 쓴 공지가 먼저 보인다.
 *
 * 보안 주의: message 는 앱 밖에서 바뀌는 입력이므로 반드시 **텍스트로만** 그린다(마크다운/HTML
 * 렌더링 금지). 링크는 main 이 http/https 로 이미 걸렀고, 여기서는 외부 브라우저로만 연다.
 */

const STYLES: Record<NoticeLevel, { wrap: string; Icon: typeof Info }> = {
  info: {
    wrap: 'bg-[var(--info-500)]/10 border-[var(--info-500)]/25 text-[var(--info-300)]',
    Icon: Info
  },
  warn: {
    wrap: 'bg-[var(--warning-500)]/10 border-[var(--warning-500)]/25 text-[var(--warning-300)]',
    Icon: AlertTriangle
  },
  critical: {
    wrap: 'bg-[var(--danger-500)]/12 border-[var(--danger-500)]/30 text-[var(--danger-300)]',
    Icon: OctagonAlert
  }
}

export function NoticeBanner(): React.JSX.Element | null {
  const notices = useStore((s) => s.notices)
  // localStorage 는 React 밖의 값이라, 닫는 즉시 다시 그리려면 이 세션의 기억도 따로 들고 있어야 한다.
  const [dismissed, setDismissed] = useState<string[]>([])

  const notice: AppNotice | undefined = notices.find(
    (n) => !dismissed.includes(n.id) && !readUiFlag(noticeDismissedFlag(n.id))
  )
  if (!notice) return null

  const { wrap, Icon } = STYLES[notice.level]

  const dismiss = (): void => {
    setUiFlag(noticeDismissedFlag(notice.id), true)
    setDismissed((prev) => [...prev, notice.id])
  }

  return (
    <div
      className={`no-drag shrink-0 flex items-center justify-center gap-3 min-h-8 px-3 py-1 border-b text-sm ${wrap}`}
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 truncate" title={notice.message}>
        {notice.message}
      </span>
      {notice.link && (
        <button
          onClick={() => void window.api.openExternal(notice.link!.url)}
          className="shrink-0 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
        >
          {notice.link.label}
          <ExternalLink size={11} />
        </button>
      )}
      <button
        onClick={dismiss}
        className="shrink-0 ml-1 opacity-60 hover:opacity-100"
        aria-label="Dismiss notice"
        title="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  )
}
