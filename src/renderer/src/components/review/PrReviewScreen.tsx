import { useMemo, useState } from 'react'
import {
  Archive,
  ExternalLink,
  FileCheck,
  Loader2,
  MessageSquarePlus,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import type { ReviewVerdict } from '@shared/types'
import { useStore } from '../../store'
import { countByFile, selectionSummary, STATUS_LABEL } from '../../lib/review'
import ReviewDiffView from './ReviewDiffView'
import ReviewActivityPanel from './ReviewActivityPanel'
import ReviewOverviewPanel from './ReviewOverviewPanel'
import ReviewProgressPane from './ReviewProgressPane'
import ReviewSubmitModal from './ReviewSubmitModal'

/**
 * PR 리뷰 화면. 사이드바 옆 본문 영역을 차지한다(대화창과 같은 자리).
 *
 * 리뷰는 워크스페이스 작업과 병행하는 별개의 일이라, 사이드바에 자기 행을 갖고 그 행을 눌러
 * 오간다. 그래서 여기에는 화면을 "닫는" 개념이 없다 — 닫기(×)는 리뷰 세션 자체를 끝내고
 * 리뷰용 워크트리까지 정리한다.
 */
export default function PrReviewScreen({ reviewId }: { reviewId: string }): React.JSX.Element {
  const session = useStore((s) => s.app?.reviews.find((r) => r.id === reviewId))
  const view = useStore((s) => s.reviewViews[reviewId])
  const requestCloseReview = useStore((s) => s.requestCloseReview)
  const requestArchiveReview = useStore((s) => s.requestArchiveReview)
  const cancelReview = useStore((s) => s.cancelReview)
  const postFindings = useStore((s) => s.postFindings)
  const toggleAllFindings = useStore((s) => s.toggleAllFindings)
  const setReviewTab = useStore((s) => s.setReviewTab)
  const [submitOpen, setSubmitOpen] = useState(false)
  // 탭은 스토어가 리뷰별로 들고 있다 — 워크스페이스를 오가면 이 화면은 언마운트되므로
  // 로컬 state 로 두면 돌아올 때마다 findings 로 되돌아간다.
  const tab = view?.tab ?? 'findings'

  const counts = useMemo(() => countByFile(view?.findings ?? []), [view?.findings])

  // 레코드는 상태 방송으로 도착한다. 리뷰를 막 시작한 직후에는 activeReviewId 가 먼저
  // 세팅될 수 있으므로, 그 짧은 틈에 본문이 빈 화면이 되지 않도록 자리를 지켜 준다.
  if (!session || !view) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 size={14} className="animate-spin" />
        Starting review…
      </div>
    )
  }

  const running = session.status === 'preparing' || session.status === 'running'
  const inlineCount = view.findings.filter((f) => f.anchor).length
  const { selectableCount, pendingIds, allSelected, someSelected } = selectionSummary(session, view)

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-[var(--bg)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="shrink-0 font-mono text-sm text-neutral-500">#{session.prNumber}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-100" title={session.prTitle}>
          {session.prTitle}
        </span>

        <span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
          {running && <Loader2 size={12} className="animate-spin text-[var(--info-400)]" />}
          {STATUS_LABEL[session.status]}
        </span>

        {/* 마지막으로 낸 판정. 다시 내려면 제출 화면에서 새 본문을 쓰면 된다. */}
        {session.lastSubmission && <VerdictChip verdict={session.lastSubmission.verdict} />}

        {running && (
          <button
            onClick={() => void cancelReview(reviewId)}
            title="Stop the review"
            className="flex shrink-0 items-center gap-1 h-7 px-2 rounded-md text-xs text-[var(--danger-300)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 hover:bg-[var(--danger-500)]/20"
          >
            <Square size={11} fill="currentColor" />
            Stop
          </button>
        )}
        <button
          onClick={() => void window.api.openExternal(session.prUrl)}
          title="Open this pull request in your browser"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
        >
          <ExternalLink size={15} />
        </button>
        {/* 워크스페이스와 같은 어휘·같은 단축키 — 결과는 남기고 워크트리만 정리한다. */}
        <button
          onClick={() => void requestArchiveReview(reviewId)}
          title="Archive review (⇧⌘⌫) — keeps the findings, removes the worktree"
          aria-label="Archive review"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
        >
          <Archive size={15} />
        </button>
        <button
          onClick={() => void requestCloseReview(reviewId)}
          title="Close review (removes the review worktree)"
          aria-label="Close review"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
        >
          <X size={15} />
        </button>
      </header>

      {view.error && (
        <div className="flex items-start gap-2 border-b border-[var(--border)] bg-[var(--danger-500)]/10 px-3 py-2 text-xs text-[var(--danger-300)]">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="break-words">{view.error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 좌: 변경 파일 */}
        <nav className="w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
          <h2 className="px-1 pb-1.5 text-xs font-medium text-neutral-500">
            Files {view.diff ? `(${view.diff.files.length})` : ''}
          </h2>
          {view.diff?.files.map((f) => (
            <button
              key={f.path}
              onClick={() =>
                document
                  .getElementById(`file-${f.path}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            >
              <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                {f.path}
              </span>
              {(counts[f.path] ?? 0) > 0 && (
                <span className="shrink-0 rounded-full bg-[var(--info-500)]/20 px-1.5 text-[10px] text-[var(--info-300)]">
                  {counts[f.path]}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* 중앙: 실행 중에는 진행 상황, 끝나면 diff + 인라인 카드 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {running && view.findings.length === 0 ? (
            <ReviewProgressPane status={session.status} view={view} />
          ) : view.diff ? (
            <ReviewDiffView session={session} view={view} files={view.diff.files} />
          ) : (
            <p className="p-8 text-center text-sm text-neutral-500">
              Couldn&rsquo;t load the diff.
            </p>
          )}
        </main>

        {/* 우: 총평·전반 지적 / 활동 타임라인 */}
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border)]">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
            {(['findings', 'activity'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setReviewTab(reviewId, t)}
                className={
                  'flex items-center gap-1 rounded-md px-2 py-1 text-xs capitalize ' +
                  (tab === t
                    ? 'bg-[var(--surface-2)] text-neutral-100'
                    : 'text-neutral-400 hover:bg-[var(--surface)] hover:text-neutral-200')
                }
              >
                {t}
                {/* 안 읽은 활동이 있으면 탭에서 바로 알린다 — 탭을 안 열면 놓치기 때문. */}
                {t === 'activity' && session.unread && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--info-500)]" />
                )}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {tab === 'findings' ? (
              <ReviewOverviewPanel session={session} view={view} />
            ) : (
              <ReviewActivityPanel session={session} view={view} />
            )}
          </div>
        </aside>
      </div>

      <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--border)] px-3">
        {/* 3상태 체크박스 — 일부만 고른 상태에서도 한 번에 전체 선택이 된다.
            (선택 여부로 라벨을 뒤집으면 "일부 선택됨" 에서 전체 선택하려고 두 번 눌러야 했다.) */}
        <label
          className={
            'flex items-center gap-1.5 text-xs select-none ' +
            (selectableCount === 0
              ? 'text-neutral-600 cursor-not-allowed'
              : 'text-neutral-400 hover:text-neutral-200 cursor-pointer')
          }
          title={
            selectableCount === 0
              ? 'Nothing left to select'
              : allSelected
                ? 'Clear selection'
                : `Select all ${selectableCount} unposted finding${selectableCount === 1 ? '' : 's'}`
          }
        >
          <input
            type="checkbox"
            className="accent-[var(--info-500)]"
            disabled={selectableCount === 0}
            checked={allSelected}
            // indeterminate 는 속성이 아니라 DOM 프로퍼티라 ref 로만 설정할 수 있다.
            ref={(el) => {
              if (el) el.indeterminate = someSelected
            }}
            onChange={() => toggleAllFindings(reviewId, !allSelected)}
          />
          Select all
        </label>

        <span className="text-xs text-neutral-500">
          {inlineCount} inline · {view.findings.length - inlineCount} general
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void postFindings(reviewId, pendingIds)}
          disabled={pendingIds.length === 0}
          title="Post each selected finding as its own comment on the pull request"
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-200 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:text-neutral-600"
        >
          <MessageSquarePlus size={14} />
          Comment{pendingIds.length > 0 && ` (${pendingIds.length})`}
        </button>
        {/* 개별 코멘트와 별개의 마무리 행위 — PR 전체에 대한 판정을 남긴다. */}
        <button
          onClick={() => setSubmitOpen(true)}
          title={
            session.viewerIsAuthor
              ? 'Comment on the pull request as a whole'
              : 'Approve, request changes, or comment on the pull request as a whole'
          }
          className="flex items-center gap-1.5 rounded-lg bg-[var(--info-600)] px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-[var(--info-500)]"
        >
          <FileCheck size={14} />
          Submit review
        </button>
      </footer>

      {submitOpen && <ReviewSubmitModal session={session} onClose={() => setSubmitOpen(false)} />}
    </div>
  )
}

const VERDICT_CHIP: Record<ReviewVerdict, { label: string; className: string }> = {
  approve: {
    label: 'Approved',
    className: 'border-[var(--success-500)]/30 bg-[var(--success-500)]/10 text-[var(--success-200)]'
  },
  'request-changes': {
    label: 'Changes requested',
    className: 'border-[var(--danger-500)]/30 bg-[var(--danger-500)]/10 text-[var(--danger-200)]'
  },
  comment: {
    label: 'Commented',
    className: 'border-[var(--border-2)] bg-[var(--surface)] text-neutral-300'
  }
}

function VerdictChip({ verdict }: { verdict: ReviewVerdict }): React.JSX.Element {
  const { label, className } = VERDICT_CHIP[verdict]
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${className}`}
      title="The last review you submitted from here"
    >
      {label}
    </span>
  )
}
