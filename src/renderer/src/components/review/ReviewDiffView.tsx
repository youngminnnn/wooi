import { useMemo, useState } from 'react'
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
  files
}: {
  session: ReviewSession
  view: ReviewViewState
  files: ReviewFileDiff[]
}): React.JSX.Element {
  const index = useMemo(() => indexFindingsByRow(view.findings), [view.findings])
  const counts = useMemo(() => countByFile(view.findings), [view.findings])

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
        />
      ))}
    </div>
  )
}

function FileBlock({
  file,
  session,
  view,
  index,
  findingCount
}: {
  file: ReviewFileDiff
  session: ReviewSession
  view: ReviewViewState
  index: Map<string, ReviewFinding[]>
  findingCount: number
}): React.JSX.Element {
  // 지적이 달린 파일은 펼쳐서 보여준다. 리뷰 화면에서 사용자가 가장 먼저 보고 싶은 것이다.
  const [open, setOpen] = useState(findingCount > 0 || file.additions + file.deletions <= 300)

  return (
    <div
      className="rounded-lg border border-[var(--border)] overflow-hidden"
      id={`file-${file.path}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
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
              <div className="px-3 py-1 text-cyan-400/80 bg-[var(--surface)]/40">{hunk.header}</div>
              {hunk.rows.map((row, ri) => (
                <Row
                  key={ri}
                  row={row}
                  session={session}
                  view={view}
                  findings={findingsForRow(index, file.path, row)}
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
  findings
}: {
  row: DiffRow
  session: ReviewSession
  view: ReviewViewState
  findings: ReviewFinding[]
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
        <ReviewFindingCard key={f.id} session={session} view={view} finding={f} compact />
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
