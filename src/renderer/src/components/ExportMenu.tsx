import { useEffect, useRef, useState } from 'react'
import { Download, FileText, FileJson } from 'lucide-react'
import { useStore } from '../store'
import { chatToJson, chatToMarkdown, downloadText } from '../lib/exportChat'
import type { ChatItem } from '@shared/types'

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

  // ⇧⌘X 전역 단축키(App.tsx)가 이 이벤트로 내보내기 메뉴를 연다.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspaceId) setOpen(true)
    }
    window.addEventListener('wooi:export-conversation', onOpen)
    return () => window.removeEventListener('wooi:export-conversation', onOpen)
  }, [workspaceId])

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

  const itemCls =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[var(--surface-2)]'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export conversation — ⇧⌘X"
        className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-[var(--accent-500)]"
      >
        <Download size={15} />
      </button>
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
