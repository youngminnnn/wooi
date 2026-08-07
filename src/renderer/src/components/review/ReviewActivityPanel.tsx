import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CornerDownRight, ExternalLink, GitCommitHorizontal, Loader2, Send } from 'lucide-react'
import type { ReviewActivityItem, ReviewSession } from '@shared/types'
import { useStore } from '../../store'
import { toolParts, type ReviewViewState } from '../../lib/review'
import { AgentMessage, ErrorRow, MarkdownBody, ToolUseRow, UserMessage } from '../ChatPrimitives'
import ReviewReplyBox from './ReviewReplyBox'

/**
 * 활동 타임라인 + 후속 지시 입력.
 *
 * 에이전트와의 대화, 상대가 단 답글, 새 커밋을 **한 줄기로** 합친다 — 사용자가 알고 싶은 건
 * "이 리뷰에서 무슨 일이 있었나" 라는 하나의 흐름이지, 출처별로 나뉜 목록이 아니다.
 *
 * 말풍선·도구 행·입력창은 워크스페이스 대화와 **같은 조각**을 쓴다(ChatPrimitives). 리뷰라고
 * 해서 대화의 문법까지 달라질 이유가 없고, 다르면 사용자는 매번 다시 익혀야 한다.
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
  const taRef = useRef<HTMLTextAreaElement>(null)

  const running = session.status === 'preparing' || session.status === 'running'
  const canSend = text.trim().length > 0 && !running && !!session.agentSessionId

  // 지금 도는 턴의 진행 줄. progress 는 리뷰 내내 쌓이므로 **마지막 질문 이후** 것만 본다 —
  // 앞선 리뷰 때의 줄을 지금 하는 일인 양 보여주면 없느니만 못하다.
  const live = useMemo(() => {
    const askedAt = view.activity.reduce(
      (ts, a) => (a.kind === 'turn' && a.role === 'user' ? a.ts : ts),
      0
    )
    return view.progress.filter((p) => p.ts >= askedAt)
  }, [view.activity, view.progress])
  const latestLine = live.at(-1)

  /**
   * 활동과 진행 줄을 시각 순으로 하나의 흐름에 끼워 넣는다.
   *
   * 도구 호출은 대화 흐름에 그대로 남긴다(워크스페이스와 같다) — 다만 **답변보다 뒤로 밀리면
   * 안 된다.** 답변은 턴이 끝난 뒤 활동으로 들어오므로, 그냥 이어 붙이면 "답 → 그 답을 위해
   * 부른 도구들" 이라는 거꾸로 된 순서가 된다. 중간 서술 문장은 빼 둔다 — 최종 답변과 같은
   * 말이 두 번 보이기 때문이다.
   */
  const rows = useMemo(() => {
    const tools = live.filter((p) => p.kind !== 'text')
    const out: Array<
      | { key: string; activity: ReviewActivityItem }
      | { key: string; progress: (typeof tools)[number] }
    > = []
    let i = 0
    for (const a of view.activity) {
      while (i < tools.length && tools[i].ts <= a.ts) {
        out.push({ key: tools[i].id, progress: tools[i] })
        i++
      }
      out.push({ key: a.id, activity: a })
    }
    for (; i < tools.length; i++) out.push({ key: tools[i].id, progress: tools[i] })
    return out
  }, [view.activity, live])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [view.activity.length, view.progress.length])

  // 입력이 길어지면 워크스페이스 입력창처럼 같이 자란다.
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const send = (): void => {
    if (!canSend) return
    const message = text
    setText('')
    void followUpReview(session.id, message)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {view.activity.length === 0 && !running && (
          <p className="text-sm text-neutral-500">
            Nothing yet. Replies to your comments and new commits show up here.
          </p>
        )}

        <div className="space-y-3">
          {rows.map((row) =>
            'activity' in row ? (
              <ActivityRow key={row.key} item={row.activity} session={session} />
            ) : row.progress.kind === 'error' ? (
              <ErrorRow key={row.key} text={row.progress.text} />
            ) : (
              <ToolUseRow key={row.key} {...toolParts(row.progress)} />
            )
          )}
        </div>

        {running && (
          <div className="mt-3 space-y-1">
            <div className="flex items-center gap-1.5 text-sm text-neutral-500">
              <Loader2 size={13} className="animate-spin text-[var(--info-400)]" />
              {session.status === 'preparing' ? 'Checking out the latest commits…' : 'Working…'}
            </div>
            {latestLine?.kind === 'text' && (
              <p className="max-h-10 overflow-hidden text-xs leading-5 text-neutral-600">
                {latestLine.text}
              </p>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* 입력창도 워크스페이스와 같은 모양·같은 키다 — Enter 로 보내고 ⇧Enter 로 줄을 바꾼다. */}
      <div className="shrink-0 border-t border-[var(--border)] p-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 transition-shadow focus-within:border-[var(--border-strong)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_12%,transparent)]">
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              rows={1}
              className="flex-1 resize-none bg-transparent py-1 text-base leading-relaxed text-neutral-200 outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed"
              value={text}
              disabled={running || !session.agentSessionId}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // IME 조합 중의 Enter 는 한글 확정이지 전송이 아니다.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                if (e.shiftKey) return
                e.preventDefault()
                send()
              }}
              placeholder={
                session.agentSessionId
                  ? running
                    ? 'Working…  (the agent is on it)'
                    : 'Ask a follow-up…  (e.g. "is their answer fair?")'
                  : 'No agent session to continue.'
              }
            />
            <button
              onClick={send}
              disabled={!canSend}
              title="Send"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--info-600)] text-white shadow-sm hover:bg-[var(--info-500)] active:scale-95 disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-neutral-600 disabled:shadow-none"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-xs text-neutral-600">
          Enter to send · &#8679;Enter for a new line
        </p>
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
    const { name, summary } = toolParts(item)
    return <ToolUseRow name={name} summary={summary} />
  }

  if (item.kind === 'error') return <ErrorRow text={item.text} />

  if (item.kind === 'commits') {
    return (
      <div className="flex items-center justify-center gap-1.5 py-1 text-xs text-[var(--warning-300)]">
        <GitCommitHorizontal size={12} className="shrink-0" />
        <span>
          New commits pushed — the diff below may be out of date.{' '}
          <span className="font-mono text-neutral-500">{item.headSha.slice(0, 7)}</span>
        </span>
      </div>
    )
  }

  if (item.kind === 'turn') {
    return item.role === 'user' ? (
      <UserMessage text={item.text} />
    ) : (
      <AgentMessage text={item.text} />
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
  const [open, setOpen] = useState(false)

  // 타임라인(issue) 코멘트에는 스레드가 없어 GitHub 이 답장을 붙일 자리를 주지 않는다.
  const canReply = item.threadRootId !== null && item.commentId > 0

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
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
        <MarkdownBody text={item.body} />
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
          <ReviewReplyBox
            reviewId={session.id}
            commentId={item.commentId}
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
