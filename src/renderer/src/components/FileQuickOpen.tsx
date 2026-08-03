import { useEffect, useRef, useState } from 'react'
import { File as FileIcon, Search } from 'lucide-react'
import { useStore } from '../store'
import { parsePathWithLine } from '../lib/fileViewer'
import type { FileHit } from '@shared/types'

/** 타이핑이 멈춘 뒤 검색을 보내기까지의 지연(ms). */
const DEBOUNCE_MS = 90

/**
 * ⇧⌘O 파일 퀵 오픈. 입력창 `@` 자동완성과 **같은 인덱스**(fs.search — git 이 아는 파일)를 써서
 * 후보 집합이 어긋나지 않는다. `src/main/git.ts#L42` 처럼 줄 번호를 붙이면 그 줄로 바로 간다.
 */
export default function FileQuickOpen({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const openFileViewer = useStore((s) => s.openFileViewer)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FileHit[]>([])
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // 늦게 도착한 옛 응답이 최신 결과를 덮지 않도록 요청마다 번호를 매긴다.
  const seq = useRef(0)

  const { path: queryPath, line } = parsePathWithLine(query)

  useEffect(() => {
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.api.fs.search(workspaceId, queryPath).then((res) => {
        if (seq.current !== mine) return
        setHits(res.filter((h) => !h.isDir))
        setCursor(0)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [workspaceId, queryPath])

  const active = hits.length ? Math.min(cursor, hits.length - 1) : 0

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commit = (hit: FileHit | undefined): void => {
    if (!hit) return
    openFileViewer(workspaceId, hit.path, line)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      if (hits.length) setCursor((c) => (Math.min(c, hits.length - 1) + 1) % hits.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      if (hits.length)
        setCursor((c) => (Math.min(c, hits.length - 1) - 1 + hits.length) % hits.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(hits[active])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open a file"
        className="no-drag w-[min(620px,92vw)] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-[var(--border)]">
          <Search size={15} className="text-neutral-500 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Open a file — type part of a path, add #L42 to jump to a line…"
            aria-label="Open a file"
            className="flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
          {line !== undefined && (
            <span className="shrink-0 text-xs text-neutral-500 tabular-nums">line {line}</span>
          )}
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {hits.length === 0 && (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">No matching file.</p>
          )}
          {hits.map((hit, i) => {
            const cut = hit.path.lastIndexOf('/')
            const dir = cut < 0 ? '' : hit.path.slice(0, cut + 1)
            const name = cut < 0 ? hit.path : hit.path.slice(cut + 1)
            return (
              <div
                key={hit.path}
                data-idx={i}
                role="button"
                tabIndex={-1}
                onMouseMove={() => setCursor(i)}
                onClick={() => commit(hit)}
                className={
                  'mx-1 px-2 py-1.5 rounded-md flex items-center gap-2.5 cursor-pointer ' +
                  (i === active ? 'bg-[var(--surface-3)]' : '')
                }
              >
                <FileIcon size={13} className="shrink-0 text-neutral-500" />
                <span className="min-w-0 truncate font-mono text-sm">
                  <span className="text-neutral-500">{dir}</span>
                  <span className={i === active ? 'text-neutral-100' : 'text-neutral-300'}>
                    {name}
                  </span>
                </span>
              </div>
            )
          })}
        </div>

        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[var(--border)] text-xs text-neutral-500">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
