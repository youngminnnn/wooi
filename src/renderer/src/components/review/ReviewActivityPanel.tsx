import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CornerDownRight, ExternalLink, GitCommitHorizontal, Loader2, Send } from 'lucide-react'
import type { ReviewActivityItem, ReviewSession } from '@shared/types'
import { useStore } from '../../store'
import type { ReviewViewState } from '../../lib/review'

/**
 * 활동 타임라인 + 후속 지시 입력.
 *
 * 에이전트와의 대화, 상대가 단 답글, 새 커밋을 **한 줄기로** 합친다 — 사용자가 알고 싶은 건
 * "이 리뷰에서 무슨 일이 있었나" 라는 하나의 흐름이지, 출처별로 나뉜 목록이 아니다.
 */
export default function ReviewActivityPanel({
  session,
  view
}: {
  session: ReviewSession
  view: ReviewViewState
}): React.JSX.Element {
  const followUpReview = useStore((s) => s.followUpReview)
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const running = session.status === 'preparing' || session.status === 'running'
  const canSend = text.trim().length > 0 && !running && !!session.agentSessionId

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [view.activity.length, view.progress.length])

  const send = (): void => {
    if (!canSend) return
    const message = text
    setText('')
    void followUpReview(session.id, message)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {view.activity.length === 0 && !running && (
          <p className="text-xs text-neutral-500">
            Nothing yet. Replies to your comments and new commits show up here.
          </p>
        )}

        <div className="space-y-3">
          {view.activity.map((item) => (
            <ActivityRow key={item.id} item={item} session={session} />
          ))}
        </div>

        {running && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-neutral-500">
            <Loader2 size={12} className="animate-spin text-[var(--info-400)]" />
            Working…
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] p-2">
        <textarea
          className="w-full min-h-[60px] resize-y rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-[var(--border-strong)] focus:outline-none disabled:opacity-50"
          value={text}
          disabled={running || !session.agentSessionId}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // IME 조합 중의 Enter 는 한글 확정이지 전송이 아니다.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) send()
          }}
          placeholder={
            session.agentSessionId
              ? 'Ask a follow-up — e.g. "is their answer fair?"'
              : 'No agent session to continue.'
          }
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-xs text-neutral-600">&#8984;&#8629; to send</span>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={11} />
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function ActivityRow({
  item,
  session
}: {
  item: ReviewActivityItem
  session: ReviewSession
}): React.JSX.Element | null {
  if (item.kind === 'tool') {
    return <p className="font-mono text-xs text-neutral-600 break-all">{item.text}</p>
  }

  if (item.kind === 'error') {
    return <p className="text-xs text-[var(--danger-400)] break-words">{item.text}</p>
  }

  if (item.kind === 'commits') {
    return (
      <div className="flex items-start gap-1.5 text-xs text-[var(--warning-300)]">
        <GitCommitHorizontal size={12} className="mt-0.5 shrink-0" />
        <span>
          New commits pushed — the diff below may be out of date.{' '}
          <span className="font-mono text-neutral-500">{item.headSha.slice(0, 7)}</span>
        </span>
      </div>
    )
  }

  if (item.kind === 'turn') {
    const mine = item.role === 'user'
    return (
      <div
        className={
          'rounded-lg px-2.5 py-2 text-sm ' +
          (mine ? 'bg-[var(--surface-2)] text-neutral-200' : 'text-neutral-300')
        }
      >
        {mine ? (
          <p className="whitespace-pre-wrap">{item.text}</p>
        ) : (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {item.text}
            </ReactMarkdown>
          </div>
        )}
      </div>
    )
  }

  return <ReplyRow item={item} session={session} />
}

/** 상대가 단 답글. 인라인 스레드면 바로 답장할 수 있다. */
function ReplyRow({
  item,
  session
}: {
  item: Extract<ReviewActivityItem, { kind: 'reply' }>
  session: ReviewSession
}): React.JSX.Element {
  const replyToThread = useStore((s) => s.replyToThread)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // 타임라인(issue) 코멘트에는 스레드가 없어 GitHub 이 답장을 붙일 자리를 주지 않는다.
  const canReply = item.threadRootId !== null && item.commentId > 0

  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    const ok = await replyToThread(session.id, item.commentId, text)
    setBusy(false)
    if (ok) {
      setText('')
      setOpen(false)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium text-neutral-300">@{item.author}</span>
        {item.path && (
          <span className="truncate font-mono text-neutral-500" title={item.path}>
            {item.path}
            {item.line ? `:${item.line}` : ''}
          </span>
        )}
        {item.htmlUrl && (
          <button
            onClick={() => void window.api.openExternal(item.htmlUrl)}
            className="ml-auto shrink-0 text-neutral-500 hover:text-neutral-200"
            title="Open on GitHub"
          >
            <ExternalLink size={11} />
          </button>
        )}
      </div>

      <div className="md mt-1 text-sm text-neutral-300">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {item.body}
        </ReactMarkdown>
      </div>

      {canReply && !open && (
        <button
          onClick={() => setOpen(true)}
          className="mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
        >
          <CornerDownRight size={11} />
          Reply
        </button>
      )}

      {open && (
        <div className="mt-1.5">
          <textarea
            autoFocus
            className="w-full min-h-[56px] resize-y rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-2 py-1.5 text-sm text-neutral-100 focus:border-[var(--border-strong)] focus:outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                void send()
              }
            }}
            placeholder="Reply in this thread…"
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={() => void send()}
              disabled={!text.trim() || busy}
              className="rounded-md px-2 py-1 text-xs text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send reply'}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
