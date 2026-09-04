import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, PanelLeftClose, Search } from 'lucide-react'
import type { FileDiff } from '@shared/types'
import { buildDiffFileTree, filterByFileQuery } from '../../lib/diffFileTree'

/** 트리 폭의 허용 범위. 경로 한 조각도 못 읽을 만큼 좁아지지 않게 하한을 둔다. */
export const DIFF_TREE_MIN_WIDTH = 140
export const DIFF_TREE_MAX_WIDTH = 420
export const DIFF_TREE_DEFAULT_WIDTH = 220

/**
 * 변경 파일 목록을 트리로 세우고, 이름으로 좁혀 해당 파일로 건너뛰게 한다.
 *
 * 파일 50개짜리 변경에서 스크롤 말고는 방법이 없던 자리를 메운다. **필터는 이름 검색 하나뿐이다** —
 * 확장자 제외·본 파일 숨기기까지 한 번에 넣으면 이 좁은 패널에서 UI 복잡도가 값을 넘는다.
 *
 * 트리의 표시 여부와 폭은 [[ChangesPanel]] 이 패널 로컬 상태로 들고 localStorage 에 기억한다 —
 * 전역 설정이 아니다.
 */
export default function DiffFileTree({
  files,
  activePath,
  width,
  onWidthChange,
  onSelect,
  onClose
}: {
  files: FileDiff[]
  /** 마지막으로 건너뛴 파일. 어디를 보고 있었는지 표시만 한다. */
  activePath: string | null
  width: number
  onWidthChange: (width: number) => void
  onSelect: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())

  const visible = useMemo(() => filterByFileQuery(files, query), [files, query])
  // 검색 중에는 접힘을 무시한다 — 걸러 낸 결과가 접힌 폴더 뒤에 숨으면 검색이 거짓말이 된다.
  const rows = useMemo(
    () =>
      buildDiffFileTree(
        visible.map((f) => f.path),
        query.trim() ? new Set<string>() : collapsed
      ),
    [visible, collapsed, query]
  )

  const toggleDir = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** 좌우 드래그로 폭을 바꾼다. 놓을 때까지 포인터를 잡아 두면 diff 위를 지나도 끊기지 않는다. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const next = Math.min(
        DIFF_TREE_MAX_WIDTH,
        Math.max(DIFF_TREE_MIN_WIDTH, startWidth + (ev.clientX - startX))
      )
      onWidthChange(next)
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  return (
    <div
      className="relative shrink-0 flex flex-col min-h-0 border-r border-[var(--border)]"
      style={{ width }}
    >
      <div className="shrink-0 flex items-center gap-1 px-2 py-2">
        <div className="relative flex-1 min-w-0">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-600"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Esc 로 검색만 비운다. 여기서 멈추지 않으면 패널이 통째로 닫혀 검색어를 지울 수 없다.
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="Filter files"
            aria-label="Filter changed files by name"
            className="w-full rounded bg-[var(--surface)] py-1 pl-6 pr-2 text-xs text-neutral-200 placeholder:text-neutral-600 outline-none focus:ring-1 focus:ring-[var(--info-500)]"
          />
        </div>
        <button
          onClick={onClose}
          title="Hide the file tree"
          aria-label="Hide the file tree"
          className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-100"
        >
          <PanelLeftClose size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-neutral-600">No files match “{query.trim()}”.</p>
        ) : (
          rows.map((row) =>
            row.kind === 'dir' ? (
              <button
                key={`dir:${row.path}`}
                onClick={() => toggleDir(row.path)}
                title={row.path}
                className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-neutral-500 hover:bg-[var(--surface)]"
                style={{ paddingLeft: 8 + row.depth * 10 }}
              >
                {collapsed.has(row.path) && !query.trim() ? (
                  <ChevronRight size={11} className="shrink-0" />
                ) : (
                  <ChevronDown size={11} className="shrink-0" />
                )}
                <span className="truncate">{row.name}</span>
              </button>
            ) : (
              <button
                key={`file:${row.path}`}
                onClick={() => onSelect(row.path)}
                title={row.path}
                className={`flex w-full items-center py-0.5 pr-2 text-left text-xs hover:bg-[var(--surface)] ${
                  row.path === activePath
                    ? 'bg-[var(--info-500)]/15 text-neutral-100'
                    : 'text-neutral-400'
                }`}
                style={{ paddingLeft: 8 + row.depth * 10 + 12 }}
              >
                <span className="truncate font-mono">{row.name}</span>
              </button>
            )
          )
        )}
      </div>

      <div
        onPointerDown={startResize}
        role="separator"
        aria-label="Resize the file tree"
        aria-orientation="vertical"
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[var(--info-500)]/40"
      />
    </div>
  )
}
