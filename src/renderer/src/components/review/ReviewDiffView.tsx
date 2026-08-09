import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileMinus2, FilePen, FilePlus2, FileCode } from 'lucide-react'
import type { DiffRow, ReviewFileDiff, ReviewFinding, ReviewSession } from '@shared/types'
import {
  countByFile,
  findingsForRow,
  indexFindingsByRow,
  type ReviewViewState
} from '../../lib/review'
import ReviewFindingCard from './ReviewFindingCard'

/**
 * 리뷰용 diff 뷰.
 *
 * 워크스페이스의 DiffView 와 나누어 둔 이유는 요구사항이 다르기 때문이다 — 저쪽은 색만 입힌
 * `<pre>` 로 충분하지만, 여기는 **줄마다 번호가 보이고 그 줄 아래에 카드를 끼워 넣을 수** 있어야
 * 한다. 기존 컴포넌트를 확장하면 Changes 탭까지 위험해져서 새로 만들었다.
 */
export default function ReviewDiffView({
  session,
  view,
  files,
  focusedId,
  onFocusFinding
}: {
  session: ReviewSession
  view: ReviewViewState
  files: ReviewFileDiff[]
  /** 지금 지목한 지적. 그 카드로 스크롤하고 테두리를 준다. */
  focusedId?: string | null
  /** 카드를 직접 눌렀을 때. 다음/이전 이동이 그 자리에서 이어지게 한다. */
  onFocusFinding?: (id: string) => void
}): React.JSX.Element {
  const index = useMemo(() => indexFindingsByRow(view.findings), [view.findings])
  const counts = useMemo(() => countByFile(view.findings), [view.findings])

  /**
   * 사용자가 직접 접거나 편 파일. FileBlock 안이 아니라 여기서 들고 있어야, 코멘트 사이를
   * 오갈 때 **접혀 있는 파일도 펼쳐 보여 줄 수** 있다(그러지 않으면 다음 코멘트가 있는데도
   * 화면은 그대로여서 이동이 먹히지 않은 것처럼 보인다).
   */
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({})
  const focusedFile = focusedId
    ? view.findings.find((f) => f.id === focusedId)?.anchor?.file
    : undefined

  const isOpen = (file: ReviewFileDiff): boolean => {
    const chosen = openFiles[file.path]
    if (chosen !== undefined) return chosen
    // 손대지 않은 파일이라면, 지목된 코멘트가 그 안에 있을 때 펼쳐 준다. 직접 접은 파일은
    // 접힌 채로 둔다 — 사용자가 방금 내린 결정을 이동이 뒤집으면 안 된다.
    return file.path === focusedFile || defaultOpen(file, counts[file.path] ?? 0)
  }

  // 카드가 화면에 놓인 뒤에 옮겨간다. 같은 코멘트를 두 번 끌고 가지 않도록 마지막 것을 기억한다.
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (!focusedId || scrolledTo.current === focusedId) return
    const el = document.getElementById(`finding-${focusedId}`)
    if (!el) return
    scrolledTo.current = focusedId
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusedId, openFiles])

  // 직접 누른 카드는 이미 눈앞에 있다 — 지목만 옮기고 화면은 건드리지 않는다(눌렀는데 화면이
  // 덜컥 움직이면 손이 미끄러진 것처럼 느껴진다).
  const focusFromClick = (id: string): void => {
    scrolledTo.current = id
    onFocusFinding?.(id)
  }

  return (
    <div className="space-y-3 p-3">
      {files.map((file) => (
        <FileBlock
          key={file.path}
          file={file}
          session={session}
          view={view}
          index={index}
          findingCount={counts[file.path] ?? 0}
          focusedId={focusedId ?? null}
          onFocusFinding={focusFromClick}
          open={isOpen(file)}
          onToggle={() =>
            setOpenFiles((prev) => ({ ...prev, [file.path]: !(prev[file.path] ?? isOpen(file)) }))
          }
        />
      ))}
    </div>
  )
}

/** 지적이 달린 파일과 짧은 파일은 펼친 채로 연다 — 리뷰에서 가장 먼저 보고 싶은 것들이다. */
function defaultOpen(file: ReviewFileDiff, findingCount: number): boolean {
  return findingCount > 0 || file.additions + file.deletions <= 300
}

function FileBlock({
  file,
  session,
  view,
  index,
  findingCount,
  focusedId,
  onFocusFinding,
  open,
  onToggle
}: {
  file: ReviewFileDiff
  session: ReviewSession
  view: ReviewViewState
  index: Map<string, ReviewFinding[]>
  findingCount: number
  focusedId: string | null
  onFocusFinding: (id: string) => void
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div
      className="rounded-lg border border-[var(--border)] overflow-hidden"
      id={`file-${file.path}`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-3)] hover:bg-[var(--surface)] text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-neutral-500" />
        )}
        <StatusIcon status={file.status} />
        <span className="flex-1 truncate text-sm font-mono text-neutral-200">{file.path}</span>
        {findingCount > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--info-500)]/20 px-2 py-0.5 text-[10px] font-medium text-[var(--info-300)]">
            {findingCount}
          </span>
        )}
        {file.binary ? (
          <span className="text-xs text-neutral-500">binary</span>
        ) : (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-[var(--success-400)]">+{file.additions}</span>{' '}
            <span className="text-[var(--danger-400)]">−{file.deletions}</span>
          </span>
        )}
      </button>

      {open && !file.binary && (
        <div className="bg-[var(--code-bg)] text-xs font-mono leading-[1.5]">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="px-3 py-1 text-[var(--diff-hunk)] bg-[var(--surface)]/40">
                {hunk.header}
              </div>
              {hunk.rows.map((row, ri) => (
                <Row
                  key={ri}
                  row={row}
                  session={session}
                  view={view}
                  findings={findingsForRow(index, file.path, row)}
                  focusedId={focusedId}
                  onFocusFinding={onFocusFinding}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({
  row,
  session,
  view,
  findings,
  focusedId,
  onFocusFinding
}: {
  row: DiffRow
  session: ReviewSession
  view: ReviewViewState
  findings: ReviewFinding[]
  focusedId: string | null
  onFocusFinding: (id: string) => void
}): React.JSX.Element {
  const tone =
    row.kind === 'add'
      ? 'bg-[var(--success-500)]/10 text-[var(--success-300)]'
      : row.kind === 'del'
        ? 'bg-[var(--danger-500)]/10 text-[var(--danger-300)]'
        : 'text-neutral-400'
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '

  return (
    <>
      <div className={`flex ${tone}`}>
        {/* 줄 번호 거터. GitHub 과 같은 배치라 눈으로 대조하기 쉽다. */}
        <span className="w-12 shrink-0 select-none px-2 text-right text-neutral-600 tabular-nums">
          {row.oldLine ?? ''}
        </span>
        <span className="w-12 shrink-0 select-none px-2 text-right text-neutral-600 tabular-nums">
          {row.newLine ?? ''}
        </span>
        <span className="w-3 shrink-0 select-none text-neutral-600">{sign}</span>
        <span className="whitespace-pre-wrap break-all pr-3">{row.text || ' '}</span>
      </div>
      {findings.map((f) => (
        <ReviewFindingCard
          key={f.id}
          session={session}
          view={view}
          finding={f}
          compact
          focused={f.id === focusedId}
          onFocus={() => onFocusFinding(f.id)}
        />
      ))}
    </>
  )
}

function StatusIcon({ status }: { status: ReviewFileDiff['status'] }): React.JSX.Element {
  const common = 'shrink-0'
  if (status === 'added')
    return <FilePlus2 size={13} className={`${common} text-[var(--success-400)]`} />
  if (status === 'deleted')
    return <FileMinus2 size={13} className={`${common} text-[var(--danger-400)]`} />
  if (status === 'renamed')
    return <FileCode size={13} className={`${common} text-[var(--accent-400)]`} />
  return <FilePen size={13} className={`${common} text-[var(--warning-400)]`} />
}
