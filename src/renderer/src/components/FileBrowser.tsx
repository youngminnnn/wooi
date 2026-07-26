import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  File as FileIcon,
  ArrowLeft,
  AtSign,
  Loader2
} from 'lucide-react'
import { PanelToolbar } from './ChangesPanel'
import { useStore } from '../store'
import { appendMention, mentionWithRange } from '../lib/mention'
import type { DirEntry, FileContent } from '@shared/types'

/** 이보다 큰 파일은 하이라이트를 생략하고 평문으로 표시(렌더 지연 방지). */
const HIGHLIGHT_MAX = 200_000

/**
 * 뷰어에서 드래그로 고른 영역의 줄 범위(1-based). 선택이 없거나 뷰어 밖이면 null.
 *
 * 하이라이트된 DOM 은 <span> 으로 잘게 쪼개져 있어 노드 단위로는 줄을 셀 수 없다.
 * 그래서 <pre> 전체 텍스트에서 선택 시작까지의 문자 수를 세어 개행 개수로 환산한다
 * (hljs 는 텍스트를 그대로 보존하므로 원본 문자열과 오프셋이 일치한다).
 */
function selectedLineRange(
  pre: HTMLElement | null,
  text: string
): { from: number; to: number } | null {
  const sel = window.getSelection()
  if (!pre || !sel || sel.isCollapsed || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)
  if (!pre.contains(range.commonAncestorContainer)) return null

  const upToStart = range.cloneRange()
  upToStart.selectNodeContents(pre)
  upToStart.setEnd(range.startContainer, range.startOffset)
  const start = upToStart.toString().length
  const selected = range.toString()
  if (!selected) return null

  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length
  // 끝은 -1 해서 선택이 개행으로 끝날 때 다음 줄까지 삼키지 않게 한다.
  return { from: lineOf(start), to: lineOf(start + selected.length - 1) }
}

/**
 * 우측 패널의 All files 탭. worktree 파일을 lazy 트리로 탐색하고, 파일을 고르면
 * 읽기 전용 뷰어로 본문을 표시한다(github-dark 하이라이트 재사용).
 */
export default function FileBrowser({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [content, setContent] = useState<FileContent | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  // 새로고침 시 트리를 통째로 다시 마운트하기 위한 키.
  const [treeKey, setTreeKey] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)

  const setDraft = useStore((s) => s.setDraft)
  const pushToast = useStore((s) => s.pushToast)

  const selectFile = (path: string): void => {
    setOpenFile(path)
    setContent(null)
    setLoadingFile(true)
    void window.api.fs.read(workspaceId, path).then((c) => {
      setContent(c)
      setLoadingFile(false)
    })
  }

  /**
   * 열려 있는 파일을 입력창 초안에 `@멘션` 으로 붙인다.
   * 본문을 드래그해 뒀으면 `#L시작-끝` 범위로 좁혀 넣는다 — 큰 파일을 통째로 넣으면
   * CLI 가 앞부분만 잘라 넣거나 아예 버릴 수 있어서, 필요한 구간만 지목하는 편이 확실하다.
   */
  const mentionOpenFile = (): void => {
    if (!openFile) return
    const range = content?.binary ? null : selectedLineRange(preRef.current, content?.text ?? '')
    const token = mentionWithRange(openFile, range?.from, range?.to)
    const draft = useStore.getState().drafts[workspaceId] ?? ''
    setDraft(workspaceId, appendMention(draft, token))
    pushToast('info', `Added ${token.trim()} to the message box`)
  }

  if (openFile !== null) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border)]">
          <button
            onClick={() => setOpenFile(null)}
            className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100 px-1.5 py-0.5 rounded hover:bg-[var(--surface-2)]"
          >
            <ArrowLeft size={12} /> Files
          </button>
          <span className="flex-1 truncate text-xs font-mono text-neutral-300" title={openFile}>
            {openFile}
          </span>
          <button
            onClick={mentionOpenFile}
            title="Mention this file in the message box (select lines first to mention just that range)"
            className="shrink-0 flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100 px-1.5 py-0.5 rounded hover:bg-[var(--surface-2)]"
          >
            <AtSign size={12} /> Mention
          </button>
        </div>
        <FileViewer content={content} loading={loadingFile} preRef={preRef} />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar label="Files" onRefresh={() => setTreeKey((k) => k + 1)} spinning={false} />
      <div className="flex-1 overflow-auto py-1">
        <DirNode
          key={treeKey}
          workspaceId={workspaceId}
          relPath=""
          name=""
          depth={0}
          defaultOpen
          onSelectFile={selectFile}
          selected={openFile}
        />
      </div>
    </div>
  )
}

/** 트리의 디렉토리 노드. 펼칠 때 자식을 lazy 로 불러온다. */
function DirNode({
  workspaceId,
  relPath,
  name,
  depth,
  defaultOpen,
  onSelectFile,
  selected
}: {
  workspaceId: string
  relPath: string
  name: string
  depth: number
  defaultOpen?: boolean
  onSelectFile: (path: string) => void
  selected: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(!!defaultOpen)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || children !== null) return
    setLoading(true)
    void window.api.fs.list(workspaceId, relPath).then((entries) => {
      setChildren(entries)
      setLoading(false)
    })
  }, [open, children, workspaceId, relPath])

  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  return (
    <div>
      {/* 루트(이름 없음)는 헤더 행을 그리지 않고 바로 자식만 표시한다. */}
      {name && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={pad}
          className="w-full flex items-center gap-1.5 pr-2 py-1 text-left text-sm text-neutral-300 hover:bg-[var(--surface)]"
        >
          <ChevronRight
            size={11}
            className={(open ? 'rotate-90 ' : '') + 'shrink-0 transition text-neutral-500'}
          />
          {open ? (
            <FolderOpen size={13} className="shrink-0 text-[var(--brand-400)]/80" />
          ) : (
            <Folder size={13} className="shrink-0 text-[var(--brand-400)]/80" />
          )}
          <span className="truncate">{name}</span>
        </button>
      )}

      {open && (
        <div>
          {loading && (
            <div
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              className="py-1 text-neutral-600"
            >
              <Loader2 size={11} className="animate-spin" />
            </div>
          )}
          {children?.map((entry) =>
            entry.isDir ? (
              <DirNode
                key={entry.path}
                workspaceId={workspaceId}
                relPath={entry.path}
                name={entry.name}
                depth={depth + 1}
                onSelectFile={onSelectFile}
                selected={selected}
              />
            ) : (
              <FileLeaf
                key={entry.path}
                entry={entry}
                depth={depth + 1}
                onSelect={onSelectFile}
                active={selected === entry.path}
              />
            )
          )}
          {children && children.length === 0 && (
            <div
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              className="py-1 text-xs text-neutral-600"
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FileLeaf({
  entry,
  depth,
  onSelect,
  active
}: {
  entry: DirEntry
  depth: number
  onSelect: (path: string) => void
  active: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={() => onSelect(entry.path)}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={
        'w-full flex items-center gap-1.5 pr-2 py-1 text-left text-sm hover:bg-[var(--surface)] ' +
        (active ? 'bg-[var(--surface-3)] text-neutral-100' : 'text-neutral-400')
      }
    >
      <span className="w-[11px] shrink-0" />
      <FileIcon size={13} className="shrink-0 text-neutral-500" />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}

function FileViewer({
  content,
  loading,
  preRef
}: {
  content: FileContent | null
  loading: boolean
  /** 본문 선택 영역을 줄 번호로 환산할 때 쓰는 <pre> 참조(@멘션 라인 범위용). */
  preRef: React.RefObject<HTMLPreElement | null>
}): React.JSX.Element {
  const html = useMemo(() => {
    if (!content || content.binary || content.text.length > HIGHLIGHT_MAX) return null
    try {
      return hljs.highlightAuto(content.text).value
    } catch {
      return null
    }
  }, [content])

  if (loading) {
    return (
      <div className="flex-1 grid place-items-center text-neutral-500">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  if (!content) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-neutral-600">
        Couldn’t read file.
      </div>
    )
  }
  if (content.binary) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-neutral-600">
        Binary file — not shown.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <pre
        ref={preRef}
        className="hljs text-xs font-mono leading-[1.5] p-3 m-0 bg-[var(--code-bg)] whitespace-pre"
      >
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{content.text}</code>}
      </pre>
      {content.truncated && (
        <div className="px-3 py-1 text-xs text-[var(--warning-500)]/80">
          File truncated (too large to show fully).
        </div>
      )}
    </div>
  )
}
