import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  MoveVertical,
  Pencil,
  Trash2
} from 'lucide-react'
import type { ReviewFinding, ReviewSession } from '@shared/types'
import { useStore } from '../../store'
import { bodyOf, isPosted, postedUrl, SEVERITY_STYLE, type ReviewViewState } from '../../lib/review'

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
  compact = false
}: {
  /** 영속 레코드 — 게시 여부의 권위. */
  session: ReviewSession
  /** 화면 상태 — 편집 중인 본문·선택·게시 진행. */
  view: ReviewViewState
  finding: ReviewFinding
  /** diff 안에 끼워 넣을 때는 여백을 줄인다. */
  compact?: boolean
}): React.JSX.Element {
  const toggleFinding = useStore((s) => s.toggleFinding)
  const editFinding = useStore((s) => s.editFinding)
  const postFindings = useStore((s) => s.postFindings)
  const dismissFinding = useStore((s) => s.dismissFinding)

  const [editing, setEditing] = useState(false)

  const body = bodyOf(view, finding)
  const posted = isPosted(session, finding.id)
  const pending = view.posting[finding.id]
  const posting = pending?.state === 'posting'
  const failure = pending?.state === 'failed' ? pending.error : undefined
  const url = postedUrl(session, finding.id)
  const severity = SEVERITY_STYLE[finding.severity]

  return (
    <div
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] ${
        compact ? 'my-1.5 mx-3' : ''
      } ${posted ? 'opacity-70' : ''}`}
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
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {body}
            </ReactMarkdown>
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
              <Check size={12} /> Posted
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
        </div>

        {failure && (
          <p className="mt-1.5 flex items-start gap-1 text-xs text-[var(--danger-400)]">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{failure}</span>
          </p>
        )}
      </div>
    </div>
  )
}
