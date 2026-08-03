import { useEffect, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, File as FileIcon, Loader2 } from 'lucide-react'
import type { DirEntry } from '@shared/types'

/**
 * worktree 파일 트리(lazy). 우측 작업 패널과 큰 파일 뷰어가 함께 쓴다.
 *
 * 새로고침은 `key` 를 바꿔 통째로 다시 마운트하는 방식이다 — 펼친 노드마다 캐시를 무효화하는
 * 것보다 단순하고, 트리는 다시 그려도 저렴하다.
 */
export default function FileTree({
  workspaceId,
  selected,
  onSelect,
  onOpen
}: {
  workspaceId: string
  /** 현재 선택된 파일 경로(강조용). */
  selected: string | null
  onSelect: (path: string) => void
  /** 더블클릭 등 '크게 열기' 동작. 주지 않으면 더블클릭은 선택과 같다. */
  onOpen?: (path: string) => void
}): React.JSX.Element {
  return (
    <DirNode
      workspaceId={workspaceId}
      relPath=""
      name=""
      depth={0}
      defaultOpen
      onSelectFile={onSelect}
      onOpenFile={onOpen}
      selected={selected}
    />
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
  onOpenFile,
  selected
}: {
  workspaceId: string
  relPath: string
  name: string
  depth: number
  defaultOpen?: boolean
  onSelectFile: (path: string) => void
  onOpenFile?: (path: string) => void
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
                onOpenFile={onOpenFile}
                selected={selected}
              />
            ) : (
              <FileLeaf
                key={entry.path}
                entry={entry}
                depth={depth + 1}
                onSelect={onSelectFile}
                onOpen={onOpenFile}
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
  onOpen,
  active
}: {
  entry: DirEntry
  depth: number
  onSelect: (path: string) => void
  onOpen?: (path: string) => void
  active: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onOpen?.(entry.path)}
      title={onOpen ? `${entry.path}\n(double-click to open in the file viewer)` : entry.path}
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
