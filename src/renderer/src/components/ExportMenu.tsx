import { useEffect, useRef, useState } from 'react'
import { Download, FileText, FileJson } from 'lucide-react'
import { useStore } from '../store'
import { chatToJson, chatToMarkdown, downloadText } from '../lib/exportChat'
import HeaderButton from './HeaderButton'
import type { ChatItem } from '@shared/types'

export type ExportConversationDetail = {
  workspaceId: string
  format?: 'md' | 'json'
}

/** 대화 내보내기 메뉴(마크다운 / JSON). 헤더 버튼에서 열린다. */
export default function ExportMenu({
  workspaceId,
  title
}: {
  workspaceId: string
  title: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const transcript = useStore((s) => s.transcripts[workspaceId]) ?? EMPTY
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const exportAs = (kind: 'md' | 'json'): void => {
    setOpen(false)
    if (transcript.length === 0) {
      pushToast('info', 'Nothing to export yet.')
      return
    }
    if (kind === 'md') {
      downloadText(title, 'md', chatToMarkdown(transcript, title), 'text/markdown')
    } else {
      downloadText(title, 'json', chatToJson(transcript, title), 'application/json')
    }
    pushToast('success', 'Conversation exported.')
  }

  // Composer 도 메뉴와 같은 내보내기를 써야 하므로 형식을 이벤트에 싣는다. exportAs 를 복제하면
  // 헤더 메뉴와 슬래시 명령의 동작이 서로 어긋날 수 있다.
  // 최신 상태를 보는 핸들러는 매 렌더 갱신하고 전역 리스너는 한 번만 바인딩한다.
  const exportHandlerRef = useRef<(e: Event) => void>(() => {})
  exportHandlerRef.current = (e: Event): void => {
    const detail = (e as CustomEvent<ExportConversationDetail>).detail
    if (detail.workspaceId !== workspaceId) return
    if (detail.format) exportAs(detail.format)
    else setOpen(true)
  }

  useEffect(() => {
    const onOpen = (e: Event): void => exportHandlerRef.current(e)
    window.addEventListener('wooi:export-conversation', onOpen)
    return () => window.removeEventListener('wooi:export-conversation', onOpen)
  }, [])

  const itemCls =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[var(--surface-2)]'

  return (
    <div className="relative" ref={ref}>
      {/* 헤더의 다른 아이콘 버튼과 같은 커스텀 호버 툴팁을 쓴다(native title 은 뜨지 않는다). */}
      <HeaderButton
        title="Export conversation"
        shortcut="⇧⌘X"
        onClick={() => setOpen((v) => !v)}
        active={open}
        hasPopup
        expanded={open}
        suppressTooltip={open}
      >
        <Download size={15} />
      </HeaderButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-xl"
        >
          <button role="menuitem" className={itemCls} onClick={() => exportAs('md')}>
            <FileText size={13} className="text-neutral-400" />
            Export as Markdown
          </button>
          <button role="menuitem" className={itemCls} onClick={() => exportAs('json')}>
            <FileJson size={13} className="text-neutral-400" />
            Export as JSON
          </button>
        </div>
      )}
    </div>
  )
}

const EMPTY: ChatItem[] = []
