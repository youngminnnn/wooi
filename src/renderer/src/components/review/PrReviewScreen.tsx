import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCheck,
  Layers,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  Play,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import type { ReviewSession, ReviewVerdict } from '@shared/types'
import { isStackReview, stackHead } from '@shared/types'
import { viewedFilePaths, viewedKey } from '@shared/reviewViewed'
import { REVIEW_BUSY_LABEL, useStore } from '../../store'
import {
  countByFile,
  fileKey,
  orderedAnchoredFindings,
  reviewTitle,
  selectionSummary,
  stepFinding,
  STATUS_LABEL
} from '../../lib/review'
import ReviewDiffView from './ReviewDiffView'
import ReviewViewedToggle from './ReviewViewedToggle'
import ReviewActivityPanel from './ReviewActivityPanel'
import ReviewOverviewPanel from './ReviewOverviewPanel'
import ReviewProgressPane from './ReviewProgressPane'
import ReviewSubmitModal from './ReviewSubmitModal'
import { formatCountdown, formatTime } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { usePaneFocus } from '../../lib/paneFocus'

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
  const toggleFileViewed = useStore((s) => s.toggleFileViewed)
  // 아카이브·삭제가 도는 동안 헤더 버튼을 잠근다 — 두 번 눌러 봐야 두 번째는 이미 사라진
  // 리뷰를 향한다.
  const busy = useStore((s) => s.busyReviews[reviewId])
  // 나란히 두 칸을 띄우면 이 화면의 코멘트 이동 단축키가 두 번 발동한다 — 포커스된 칸만 받는다.
  const { focused: paneFocused, split: inSplit } = usePaneFocus()
  const closeFocusedPane = useStore((s) => s.closeFocusedPane)
  const [submitOpen, setSubmitOpen] = useState(false)
  /** 지금 지목한 코멘트. diff 가 여기로 스크롤하고 그 카드에 테두리를 준다. */
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // 탭은 스토어가 리뷰별로 들고 있다 — 워크스페이스를 오가면 이 화면은 언마운트되므로
  // 로컬 state 로 두면 돌아올 때마다 findings 로 되돌아간다.
  const tab = view?.tab ?? 'findings'

  const counts = useMemo(() => countByFile(view?.findings ?? []), [view?.findings])
  const diffs = useMemo(() => view?.diffs ?? [], [view?.diffs])
  /** 좌측 파일 목록의 행 — 스택이면 레이어 머리글이 섞여 들어온다. */
  const fileRows = useMemo(
    () =>
      diffs.flatMap((layer) =>
        layer.diff.files.map((f) => ({ prNumber: layer.prNumber, file: f }))
      ),
    [diffs]
  )
  // 파일마다 diff 를 해시하므로 한 번만 계산해 목록·헤더가 나눠 쓴다.
  const viewedKeys = useMemo(
    () =>
      viewedFilePaths(
        view?.viewed ?? {},
        diffs.map((d) => ({ prNumber: d.prNumber, files: d.diff.files }))
      ),
    [view?.viewed, diffs]
  )
  const ordered = useMemo(
    () => orderedAnchoredFindings(diffs, view?.findings ?? []),
    [diffs, view?.findings]
  )
  const focusedIndex = focusedId ? ordered.findIndex((f) => f.id === focusedId) : -1

  const step = useCallback(
    (delta: 1 | -1) => {
      if (ordered.length === 0) {
        // 눌렀는데 아무 일도 안 일어나면 단축키가 고장 난 줄 안다 — 갈 곳이 없다고 말해 준다.
        useStore.getState().pushToast('info', 'No comments on the diff to jump to yet.')
        return
      }
      setFocusedId((current) => stepFinding(ordered, current, delta) ?? current)
    },
    [ordered]
  )

  /**
   * 코멘트 사이 이동 단축키. **이 화면이 직접 듣는다** — 리뷰가 떠 있을 때만 마운트되므로
   * 전역 핸들러의 긴 분기를 거칠 이유가 없다.
   *
   * 두 벌을 받는다: `n`/`p` 는 아무 수식키도 타지 않아 OS·메뉴·창 관리 앱이 가로챌 여지가
   * 없고(diff 를 훑는 손이 홈 포지션에 있기도 하다), ⌥⌘↑/↓ 는 파일 뷰어의 ⌥⌘←/→ 와 같은
   * "열려 있는 화면 안에서 이동" 어휘를 잇는다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!paneFocused) return
      const st = useStore.getState()
      // 제출 모달은 이 화면이 직접 띄우므로 store 의 overlayOpen 에 잡히지 않는다.
      if (submitOpen || st.overlayOpen || st.confirmState) return

      let delta: 1 | -1 | null = null
      if (e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey) {
        // 한글 IME 등에서 e.key 가 흔들릴 수 있어 물리 키(e.code)도 함께 본다.
        if (e.key === 'ArrowDown' || e.code === 'ArrowDown') delta = 1
        else if (e.key === 'ArrowUp' || e.code === 'ArrowUp') delta = -1
      } else if (!e.metaKey && !e.altKey && !e.ctrlKey && !isTyping()) {
        if (e.code === 'KeyN') delta = 1
        else if (e.code === 'KeyP') delta = -1
      }
      if (delta === null) return
      e.preventDefault()
      step(delta)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, submitOpen, paneFocused])

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
  const head = stackHead(session)
  const title = reviewTitle(session)
  const stacked = isStackReview(session)
  // 판정 칩은 스택에서 레이어마다 다를 수 있다 — 하나로 뭉뚱그리지 않고 맨 위의 것을 보여주되,
  // 몇 개나 냈는지 함께 적는다.
  const submissions = session.layers.filter((l) => l.lastSubmission)

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-[var(--bg)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="shrink-0 font-mono text-sm text-neutral-500">#{title.number}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-100" title={title.title}>
          {title.title}
        </span>
        {stacked && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--accent-400)]/30 bg-[var(--accent-400)]/10 px-2 py-0.5 text-xs text-[var(--accent-300)]"
            title={`Reviewed as one stack: ${session.layers.map((l) => `#${l.prNumber}`).join(' → ')}`}
          >
            <Layers size={11} />
            Stack of {session.layers.length}
          </span>
        )}

        <span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
          {running && <Loader2 size={12} className="animate-spin text-[var(--info-400)]" />}
          {STATUS_LABEL[session.status]}
        </span>

        {/* 마지막으로 낸 판정. 다시 내려면 제출 화면에서 새 본문을 쓰면 된다. */}
        {head?.lastSubmission && (
          <VerdictChip
            verdict={head.lastSubmission.verdict}
            note={
              stacked && submissions.length < session.layers.length
                ? `${submissions.length}/${session.layers.length}`
                : undefined
            }
          />
        )}

        {/* 코멘트 사이 이동. 긴 diff 에서는 지적이 화면 밖에 흩어져 있어, 스크롤로 찾는 것이
            리뷰에서 가장 많이 하는 헛일이다. */}
        {ordered.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-2)] px-0.5">
            <button
              onClick={() => step(-1)}
              title="Previous comment (p or ⌥⌘↑)"
              aria-label="Previous comment"
              className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
            >
              <ChevronUp size={14} />
            </button>
            <span
              className="px-0.5 text-xs tabular-nums text-neutral-500"
              title={`${ordered.length} comment${ordered.length === 1 ? '' : 's'} on the diff`}
            >
              {focusedIndex >= 0 ? `${focusedIndex + 1}/${ordered.length}` : ordered.length}
            </span>
            <button
              onClick={() => step(1)}
              title="Next comment (n or ⌥⌘↓)"
              aria-label="Next comment"
              className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}

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
        {/* 나란히 편 칸에서만 뜬다. 옆의 X 는 리뷰 자체를 닫는(워크트리를 지우는) 버튼이라
            아예 다른 일이므로, 붙여 두지 않고 도구 묶음의 앞머리에 따로 세운다. */}
        {inSplit && (
          <button
            onClick={() => closeFocusedPane()}
            title="Close this pane (⇧⌘W) — the review stays open in the sidebar"
            aria-label="Close this pane"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
        <button
          onClick={() => void window.api.openExternal(head?.prUrl ?? '')}
          title="Open this pull request in your browser"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
        >
          <ExternalLink size={15} />
        </button>
        {/* 워크스페이스와 같은 어휘·같은 단축키 — 결과는 남기고 워크트리만 정리한다.
            정리가 도는 동안은 스피너로 바꿔 잠근다(워크트리·ref 를 지우는 데 몇 초가 걸린다). */}
        <button
          onClick={() => void requestArchiveReview(reviewId)}
          disabled={!!busy}
          title={
            busy
              ? REVIEW_BUSY_LABEL[busy]
              : 'Archive review (⇧⌘⌫) — keeps the findings, removes the worktree'
          }
          aria-label="Archive review"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          {busy === 'archiving' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Archive size={15} />
          )}
        </button>
        <button
          onClick={() => void requestCloseReview(reviewId)}
          disabled={!!busy}
          title={busy ? REVIEW_BUSY_LABEL[busy] : 'Close review (removes the review worktree)'}
          aria-label="Close review"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          {busy === 'deleting' ? <Loader2 size={14} className="animate-spin" /> : <X size={15} />}
        </button>
      </header>

      <StoppedBanner session={session} liveError={view.error} />

      <div className="flex min-h-0 flex-1">
        {/* 좌: 변경 파일 */}
        <nav className="w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
          <h2 className="flex items-center gap-1 px-1 pb-1.5 text-xs font-medium text-neutral-500">
            <span>Files</span>
            {fileRows.length > 0 && (
              <span
                className="ml-auto shrink-0 tabular-nums"
                title={`${viewedKeys.size} of ${fileRows.length} files marked as viewed`}
              >
                {viewedKeys.size}/{fileRows.length} viewed
              </span>
            )}
          </h2>
          {diffs.map((layer) => (
            <div key={layer.prNumber}>
              {/* 스택에서는 파일 목록도 레이어로 나눠 놓아야 한다 — 같은 경로가 여러 번 나오는데
                  구분이 없으면 어느 층의 파일인지 알 수 없다. */}
              {stacked && (
                <div className="mt-2 flex items-center gap-1 px-1.5 pb-0.5 text-xs text-[var(--accent-300)]">
                  <Layers size={10} className="shrink-0" />
                  <span className="truncate" title={layerTitle(session, layer.prNumber)}>
                    #{layer.prNumber}
                  </span>
                </div>
              )}
              {layer.diff.files.map((f) => {
                const key = viewedKey(f.path, layer.prNumber)
                const isViewed = viewedKeys.has(key)
                const count = counts[fileKey(layer.prNumber, f.path)] ?? 0
                return (
                  // 체크와 "그 파일로 이동" 은 다른 행동이라 버튼을 나눈다(버튼 안에 버튼을 넣을 수도 없다).
                  <div
                    key={key}
                    className={
                      'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs hover:bg-[var(--surface-2)] ' +
                      // 본 파일은 눌러 둔다 — 목록을 훑을 때 남은 것이 먼저 눈에 들어와야 한다.
                      (isViewed ? 'text-neutral-600' : 'text-neutral-400')
                    }
                  >
                    <ReviewViewedToggle
                      viewed={isViewed}
                      path={f.path}
                      onToggle={() => void toggleFileViewed(reviewId, f.path, layer.prNumber)}
                    />
                    <button
                      onClick={() =>
                        document
                          .getElementById(`file-${fileKey(layer.prNumber, f.path)}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                      className={
                        'min-w-0 flex-1 truncate text-left font-mono hover:text-neutral-100 ' +
                        (isViewed ? 'line-through decoration-neutral-700' : '')
                      }
                      title={f.path}
                    >
                      {f.path}
                    </button>
                    {count > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--info-500)]/20 px-1.5 text-2xs text-[var(--info-300)]">
                        {count}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </nav>

        {/* 중앙: 실행 중에는 진행 상황, 끝나면 diff + 인라인 카드 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {running && view.findings.length === 0 ? (
            <ReviewProgressPane status={session.status} view={view} />
          ) : diffs.length > 0 ? (
            <>
              {/* 예산에 못 들어간 파일이 있으면 반드시 알린다 — 에이전트가 워크트리에서 직접
                  읽었을 수는 있어도, "전부 봤다" 고 믿게 두면 안 된다. */}
              {session.truncatedFiles > 0 && (
                <p className="mx-3 mt-3 rounded-md border border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10 px-3 py-2 text-xs text-[var(--warning-200)]">
                  {session.truncatedFiles} file{session.truncatedFiles === 1 ? ' was' : 's were'}{' '}
                  too large to include in the prompt — the agent was told to read{' '}
                  {session.truncatedFiles === 1 ? 'it' : 'them'} from the worktree instead.
                </p>
              )}
              <ReviewDiffView
                session={session}
                view={view}
                diffs={diffs}
                focusedId={focusedId}
                onFocusFinding={setFocusedId}
                viewedKeys={viewedKeys}
                onToggleViewed={(path, prNumber) => void toggleFileViewed(reviewId, path, prNumber)}
              />
            </>
          ) : (
            <p className="p-8 text-center text-sm text-neutral-500">
              Couldn&rsquo;t load the diff.
            </p>
          )}
        </main>

        {/* 우: 총평·전반 지적 / 활동 타임라인 */}
        {/* 대화가 워크스페이스와 같은 말풍선·도구 행으로 그려지므로 그만한 폭이 필요하다. */}
        <aside className="flex w-[22rem] shrink-0 flex-col overflow-hidden border-l border-[var(--border)]">
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
            session.layers.every((l) => l.viewerIsAuthor)
              ? 'Comment on the pull request as a whole'
              : stacked
                ? 'Approve, request changes, or comment — submitted to every layer of the stack'
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

/** 레이어 머리글의 툴팁 — 번호만으로는 어느 층인지 떠올리기 어렵다. */
function layerTitle(
  session: { layers: Array<{ prNumber: number; prTitle: string }> },
  n: number
): string {
  const at = session.layers.findIndex((l) => l.prNumber === n)
  const layer = session.layers[at]
  return layer ? `Layer ${at + 1} of ${session.layers.length} — ${layer.prTitle}` : `#${n}`
}

/**
 * 리뷰가 멈춰 있을 때의 안내 줄 — 왜 멈췄는지와, 이어서 돌리는 버튼.
 *
 * 멈춤은 **끝이 아니다**. 사용량 제한이든 일시적 오류든 리뷰의 결론과는 상관없는 사고라,
 * 여기서 이어 갈 길을 주지 않으면 사용자는 리뷰를 지우고 처음부터 다시 돌리는 수밖에 없다
 * (워크트리를 다시 만들고, 같은 diff 를 또 태우고, 읽은 것을 다시 읽는다).
 *
 * 이유는 레코드(lastError)에서 읽는다 — 이번 실행에만 있는 view.error 로는 앱을 껐다 켜면
 * "Failed" 만 남는다. 옛 레코드에는 그 필드가 없어 그때만 view.error 로 떨어진다.
 */
function StoppedBanner({
  session,
  liveError
}: {
  session: ReviewSession
  /** 이번 실행 중에 흘러온 오류 문구. 레코드에 남은 이유가 있으면 그쪽이 이긴다. */
  liveError: string | null
}): React.JSX.Element | null {
  const resumeReview = useStore((s) => s.resumeReview)
  const failure = session.lastError ?? null
  const stopped = session.status === 'error' || session.status === 'cancelled'
  // 카운트다운은 제한이 풀릴 때까지만 흐르면 된다.
  const now = useNow(30_000, !!failure?.resetsAt)
  if (!stopped && !liveError) return null

  const waiting = failure?.resetsAt && failure.resetsAt > now ? failure.resetsAt : null
  const reason = failure?.rateLimited
    ? `Stopped at your usage limit.${
        waiting
          ? ` Resumes cleanly in ${formatCountdown(waiting - now)} (${formatTime(waiting)}).`
          : ''
      }`
    : (failure?.message ?? liveError ?? 'The review stopped before it finished.')

  // 사용자가 직접 멈춘 것은 사고가 아니다 — 같은 줄을 쓰되 빨강으로 겁주지 않는다.
  const byHand = session.status === 'cancelled' && !failure
  return (
    <div
      className={
        'flex items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-xs ' +
        (byHand
          ? 'bg-[var(--surface)] text-neutral-400'
          : 'bg-[var(--danger-500)]/10 text-[var(--danger-300)]')
      }
    >
      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {byHand ? 'You stopped this review.' : reason}
      </span>
      {stopped && (
        <button
          onClick={() => void resumeReview(session.id)}
          title={
            session.agentSessionId
              ? 'Continue the same agent session where it stopped'
              : 'Run this review again from the start (nothing was kept from the stopped run)'
          }
          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-2)] bg-[var(--surface)] px-2 py-0.5 text-neutral-200 hover:bg-[var(--surface-2)] active:scale-95"
        >
          <Play size={11} />
          Resume
        </button>
      )}
    </div>
  )
}

/** 글을 쓰는 중인가. 수식키 없는 단축키(n/p)가 입력을 가로채지 않도록. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
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

function VerdictChip({
  verdict,
  note
}: {
  verdict: ReviewVerdict
  /** 스택에서 일부 레이어만 제출됐을 때 "2/4" 처럼 적는다 — 다 냈다고 착각하면 안 된다. */
  note?: string
}): React.JSX.Element {
  const { label, className } = VERDICT_CHIP[verdict]
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${className}`}
      title={
        note
          ? `The last verdict you submitted — only ${note} layers of this stack have one`
          : 'The last review you submitted from here'
      }
    >
      {label}
      {note && <span className="ml-1 opacity-70 tabular-nums">{note}</span>}
    </span>
  )
}
