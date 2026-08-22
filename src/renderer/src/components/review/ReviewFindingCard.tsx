import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCheck,
  CornerDownRight,
  ExternalLink,
  History,
  Layers,
  Loader2,
  MoveVertical,
  Pencil,
  Trash2
} from 'lucide-react'
import type { ReviewActivityItem, ReviewFinding, ReviewSession } from '@shared/types'
import { useStore } from '../../store'
import { formatTime } from '../../lib/format'
import {
  bodyOf,
  isPosted,
  postedCommentFor,
  repliesByThread,
  SEVERITY_STYLE,
  type ReviewViewState
} from '../../lib/review'
import { MarkdownBody } from '../ChatPrimitives'
import ReviewReplyBox from './ReviewReplyBox'

/**
 * 지적 1건 카드. 인라인(코드 줄 아래)과 전반(우측 패널) 양쪽에서 같은 카드를 쓴다.
 *
 * 본문을 편집할 수 있는 게 핵심이다 — 에이전트 문장을 그대로 남의 PR 에 올리는 사람은 없다.
 * 편집본은 store 의 edits 에 남고, 게시할 때 그 값이 그대로 GitHub 으로 간다.
 */
export default function ReviewFindingCard({
  session,
  view,
  finding,
  compact = false,
  focused = false,
  onFocus,
  layerLabel
}: {
  /** 영속 레코드 — 게시 여부의 권위. */
  session: ReviewSession
  /** 화면 상태 — 편집 중인 본문·선택·게시 진행. */
  view: ReviewViewState
  finding: ReviewFinding
  /** diff 안에 끼워 넣을 때는 여백을 줄인다. */
  compact?: boolean
  /** 다음/이전 코멘트 이동으로 지금 지목된 카드인가. */
  focused?: boolean
  /** 이 카드를 건드렸을 때 — 다음/이전 이동이 여기서부터 이어지게 한다. */
  onFocus?: () => void
  /** 이 지적이 올라갈 PR 번호. 스택 리뷰에서만 준다 — 어디로 가는지 게시 전에 보여야 한다. */
  layerLabel?: number
}): React.JSX.Element {
  const toggleFinding = useStore((s) => s.toggleFinding)
  const editFinding = useStore((s) => s.editFinding)
  const postFindings = useStore((s) => s.postFindings)
  const dismissFinding = useStore((s) => s.dismissFinding)

  const [editing, setEditing] = useState(false)
  const [replying, setReplying] = useState(false)

  const body = bodyOf(view, finding)
  const posted = isPosted(session, finding.id)
  const comment = postedCommentFor(session, finding.id)
  const pending = view.posting[finding.id]
  const posting = pending?.state === 'posting'
  const failure = pending?.state === 'failed' ? pending.error : undefined
  const url = comment?.htmlUrl || undefined
  const severity = SEVERITY_STYLE[finding.severity]

  // 이 지적으로 올린 코멘트에 달린 답글. 활동 타임라인과 같은 자료를 스레드로 묶어 본다 —
  // 답글을 읽으려고 탭을 옮겨 다니면 지적과 답이 머릿속에서 분리된다.
  const replies = useMemo(() => {
    if (!comment) return [] as Extract<ReviewActivityItem, { kind: 'reply' }>[]
    return repliesByThread(view.activity).get(comment.commentId) ?? []
  }, [view.activity, comment])

  return (
    <div
      // 이동(⌥⌘↑/↓)이 이 id 로 카드를 찾아 화면 가운데로 데려온다.
      id={`finding-${finding.id}`}
      // 손을 댄 카드가 곧 "지금 보고 있는 곳" 이다 — 여기서 다음/이전 이동이 이어진다.
      onMouseDownCapture={onFocus}
      className={`rounded-lg border bg-[var(--surface)] ${
        focused
          ? 'border-[var(--info-500)] ring-2 ring-[var(--info-500)]/40'
          : 'border-[var(--border)]'
      } ${compact ? 'my-1.5 mx-3' : ''} ${posted ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <input
          type="checkbox"
          className="mt-1 accent-[var(--info-500)]"
          checked={!!view.selected[finding.id]}
          disabled={posted}
          onChange={() => toggleFinding(session.id, finding.id)}
          aria-label={`Select: ${finding.title}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${severity.className}`}>
              {severity.label}
            </span>
            <span className="text-sm font-medium text-neutral-100">{finding.title}</span>
            {/* 스택 지적은 여러 층에 대한 말이고, 게시는 그중 가장 아래로 간다. 어느 층들인지
                보이지 않으면 카드만 봐서는 무엇에 대한 지적인지 알 수 없다. */}
            {(finding.stackPrNumbers?.length ?? 0) > 0 ? (
              <span
                className="flex items-center gap-1 rounded bg-[var(--accent-400)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-300)]"
                title={`About ${finding.stackPrNumbers!.map((n) => `#${n}`).join(', ')} — posted on #${finding.prNumber ?? finding.stackPrNumbers![0]}`}
              >
                <Layers size={10} />
                {finding.stackPrNumbers!.map((n) => `#${n}`).join(' → ')}
              </span>
            ) : (
              layerLabel !== undefined && (
                <span
                  className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                  title={`Posted on #${layerLabel}`}
                >
                  #{layerLabel}
                </span>
              )
            )}
            {/* 상대가 이 스레드를 Resolved 로 접었다 — 답글 없이 조용히 접히는 일이 흔해서,
                여기서 알리지 않으면 "처리됨" 과 "무시당함" 이 화면에서 똑같아 보인다. */}
            {comment?.resolved && (
              <span
                title="This thread is marked resolved on GitHub."
                className="flex items-center gap-1 rounded bg-[var(--success-500)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--success-300)]"
              >
                <CheckCheck size={10} />
                Resolved
              </span>
            )}
            {/* 상대가 그 줄을 이미 고쳐 코멘트가 밀려났다 — GitHub 이 Outdated 로 접어 두는 상태.
                여기서 알리지 않으면 사용자는 아직 살아 있는 지적으로 착각한다. */}
            {comment?.outdated && (
              <span
                title="The line this comment is on has changed — GitHub marks it outdated."
                className="flex items-center gap-1 rounded bg-[var(--warning-500)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning-300)]"
              >
                <History size={10} />
                Outdated
              </span>
            )}
          </div>

          {/* 줄이 옮겨졌으면 반드시 알린다 — 사용자가 엉뚱한 줄에 다는 걸 눈으로 잡을 수 있어야 한다. */}
          {finding.anchor?.snappedFrom != null && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-[var(--warning-300)]">
              <MoveVertical size={11} />
              Line {finding.anchor.snappedFrom} isn&rsquo;t in the diff — moved to line{' '}
              {finding.anchor.line}.
            </p>
          )}
        </div>
      </div>

      <div className="px-3 pb-2.5 pl-8">
        {editing ? (
          <textarea
            autoFocus
            className="mt-1.5 w-full min-h-[100px] resize-y rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-2 text-sm text-neutral-100 focus:outline-none focus:border-[var(--border-strong)]"
            value={body}
            onChange={(e) => editFinding(session.id, finding.id, e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <div className="md mt-1 text-sm text-neutral-300">
            <MarkdownBody text={body} />
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          {!posted && (
            <>
              <button
                onClick={() => setEditing((v) => !v)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
              >
                <Pencil size={11} />
                {editing ? 'Done' : 'Edit'}
              </button>
              <button
                onClick={() => void postFindings(session.id, [finding.id])}
                disabled={posting}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-50"
              >
                {posting && <Loader2 size={11} className="animate-spin" />}
                {posting ? 'Posting…' : 'Comment'}
              </button>
              {/* 안 달 제안은 지워 둬야 "아직 안 단 코멘트" 를 세는 곳들이 조용해진다. */}
              <button
                onClick={() => void dismissFinding(session.id, finding.id)}
                disabled={posting}
                title="Discard this suggestion — it won't be posted"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-[var(--danger-500)]/10 hover:text-[var(--danger-300)] disabled:opacity-50"
              >
                <Trash2 size={11} />
                Discard
              </button>
            </>
          )}

          {posted && (
            <span className="flex items-center gap-1 text-xs text-[var(--success-400)]">
              <Check size={12} /> {comment?.resolved ? 'Posted · resolved' : 'Posted'}
              {url && (
                <button
                  onClick={() => void window.api.openExternal(url)}
                  className="ml-1 inline-flex items-center gap-0.5 text-neutral-400 hover:text-neutral-100"
                >
                  <ExternalLink size={11} /> View
                </button>
              )}
            </span>
          )}

          {/* 답장은 인라인 스레드에만 붙는다 — 타임라인(issue) 코멘트에는 GitHub 이 자리를 주지 않는다. */}
          {comment?.kind === 'inline' && !replying && (
            <button
              onClick={() => setReplying(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            >
              <CornerDownRight size={11} />
              Reply
            </button>
          )}
        </div>

        {failure && (
          <p className="mt-1.5 flex items-start gap-1 text-xs text-[var(--danger-400)]">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{failure}</span>
          </p>
        )}

        {(replies.length > 0 || replying) && (
          <div className="mt-2 space-y-2 border-l-2 border-[var(--border-2)] pl-2.5">
            {replies.map((reply) => (
              <div key={reply.id}>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-medium text-neutral-300">@{reply.author}</span>
                  <span className="text-neutral-600">{formatTime(reply.ts)}</span>
                  {reply.htmlUrl && (
                    <button
                      onClick={() => void window.api.openExternal(reply.htmlUrl)}
                      title="Open on GitHub"
                      className="text-neutral-500 hover:text-neutral-200"
                    >
                      <ExternalLink size={10} />
                    </button>
                  )}
                </div>
                <div className="md mt-0.5 text-sm text-neutral-300">
                  <MarkdownBody text={reply.body} />
                </div>
              </div>
            ))}
            {replying && comment && (
              <ReviewReplyBox
                reviewId={session.id}
                commentId={comment.commentId}
                onDone={() => setReplying(false)}
                onCancel={() => setReplying(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
