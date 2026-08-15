import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileMinus2,
  FilePen,
  FilePlus2,
  FileCode,
  Layers
} from 'lucide-react'
import type {
  DiffRow,
  ReviewFileDiff,
  ReviewFinding,
  ReviewLayerDiff,
  ReviewSession
} from '@shared/types'
import { isStackReview } from '@shared/types'
import { viewedKey } from '@shared/reviewViewed'
import {
  countByFile,
  fileKey,
  findingsForRow,
  indexFindingsByRow,
  type ReviewViewState
} from '../../lib/review'
import ReviewFindingCard from './ReviewFindingCard'
import ReviewViewedToggle from './ReviewViewedToggle'

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
  diffs,
  focusedId,
  onFocusFinding,
  viewedKeys,
  onToggleViewed
}: {
  session: ReviewSession
  view: ReviewViewState
  /** 레이어별 diff(아래→위). PR 하나짜리 리뷰는 원소가 하나다. */
  diffs: ReviewLayerDiff[]
  /** 지금 지목한 지적. 그 카드로 스크롤하고 테두리를 준다. */
  focusedId?: string | null
  /** 카드를 직접 눌렀을 때. 다음/이전 이동이 그 자리에서 이어지게 한다. */
  onFocusFinding?: (id: string) => void
  /** 지금 diff 기준으로 "봤음" 인 파일 키들. 해시 계산을 화면당 한 번만 하려고 위에서 받는다. */
  viewedKeys: Set<string>
  onToggleViewed: (path: string, prNumber: number) => void
}): React.JSX.Element {
  const index = useMemo(
    () => indexFindingsByRow(view.findings, diffs.length === 1 ? diffs[0].prNumber : undefined),
    [view.findings, diffs]
  )
  const counts = useMemo(() => countByFile(view.findings), [view.findings])

  /**
   * 사용자가 직접 접거나 편 파일. FileBlock 안이 아니라 여기서 들고 있어야, 코멘트 사이를
   * 오갈 때 **접혀 있는 파일도 펼쳐 보여 줄 수** 있다(그러지 않으면 다음 코멘트가 있는데도
   * 화면은 그대로여서 이동이 먹히지 않은 것처럼 보인다).
   */
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({})
  const focusedAnchor = focusedId
    ? view.findings.find((f) => f.id === focusedId)?.anchor
    : undefined
  const stacked = isStackReview(session)

  const isOpen = (file: ReviewFileDiff, prNumber: number): boolean => {
    const key = fileKey(prNumber, file.path)
    const chosen = openFiles[key]
    if (chosen !== undefined) return chosen
    // 손대지 않은 파일이라면, 지목된 코멘트가 그 안에 있을 때 펼쳐 준다. 직접 접은 파일은
    // 접힌 채로 둔다 — 사용자가 방금 내린 결정을 이동이 뒤집으면 안 된다.
    const isFocusedFile =
      focusedAnchor?.file === file.path &&
      (focusedAnchor.prNumber === undefined || focusedAnchor.prNumber === prNumber)
    return isFocusedFile || defaultOpen(file, counts[key] ?? 0)
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
      {diffs.map((layer, i) => (
        <div key={layer.prNumber} className="space-y-3">
          {/* 레이어 머리글. 스택 리뷰에서 지금 보고 있는 것이 몇 층인지가 diff 를 읽는 내내
              보여야 한다 — 같은 파일이 여러 층에 나오기 때문이다. */}
          {stacked && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--accent-400)]/25 bg-[var(--accent-400)]/5 px-3 py-1.5">
              <Layers size={13} className="shrink-0 text-[var(--accent-400)]" />
              <span className="shrink-0 font-mono text-xs text-[var(--accent-300)]">
                #{layer.prNumber}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-300">
                {session.layers.find((l) => l.prNumber === layer.prNumber)?.prTitle ?? ''}
              </span>
              <span className="shrink-0 text-[11px] text-neutral-500">
                Layer {i + 1} of {diffs.length}
              </span>
            </div>
          )}
          {layer.diff.files.map((file) => {
            const key = fileKey(layer.prNumber, file.path)
            return (
              <FileBlock
                key={key}
                file={file}
                fileId={key}
                prNumber={layer.prNumber}
                session={session}
                view={view}
                index={index}
                findingCount={counts[key] ?? 0}
                focusedId={focusedId ?? null}
                onFocusFinding={focusFromClick}
                viewed={viewedKeys.has(viewedKey(file.path, layer.prNumber))}
                onToggleViewed={() => onToggleViewed(file.path, layer.prNumber)}
                open={isOpen(file, layer.prNumber)}
                onToggle={() =>
                  setOpenFiles((prev) => ({
                    ...prev,
                    [key]: !(prev[key] ?? isOpen(file, layer.prNumber))
                  }))
                }
              />
            )
          })}
        </div>
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
  fileId,
  prNumber,
  session,
  view,
  index,
  findingCount,
  focusedId,
  onFocusFinding,
  viewed,
  onToggleViewed,
  open,
  onToggle
}: {
  file: ReviewFileDiff
  /** 파일 블록의 DOM id. 좌측 목록의 "이 파일로 이동" 이 이 값을 찾는다. */
  fileId: string
  /** 이 파일이 속한 레이어. 최신 단일 PR 앵커에도 번호가 들어가므로 항상 넘긴다. */
  prNumber: number
  session: ReviewSession
  view: ReviewViewState
  index: Map<string, ReviewFinding[]>
  findingCount: number
  focusedId: string | null
  onFocusFinding: (id: string) => void
  viewed: boolean
  onToggleViewed: () => void
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden" id={`file-${fileId}`}>
      {/* 접기(헤더 전체)와 "봤음" 체크는 다른 행동이라 버튼을 나눈다 — 버튼 안에 버튼을 둘 수도 없다. */}
      <div className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-3)] hover:bg-[var(--surface)]">
        <button
          onClick={onToggle}
          className={
            'flex min-w-0 flex-1 items-center gap-2 text-left ' + (viewed ? 'opacity-50' : '')
          }
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
        {/* 스크롤하며 읽다가 그 자리에서 체크하는 게 실제 흐름이라, 목록만이 아니라 여기에도 둔다. */}
        <ReviewViewedToggle viewed={viewed} path={file.path} onToggle={onToggleViewed} size="md" />
      </div>

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
                  findings={findingsForRow(index, prNumber, file.path, row)}
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
