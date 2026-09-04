import { useState } from 'react'
import { ChevronDown, ChevronUp, Send, Trash2, X } from 'lucide-react'
import { commentLocation, type DiffComment } from '../../lib/diffComments'

/**
 * Changes 탭 아래에 붙는 "보낼 코멘트" 줄.
 *
 * 코멘트를 하나씩 보내지 않고 모아서 한 번에 보내는 것이 이 기능의 핵심이다 — 지적 3개를 대화
 * 3턴으로 쪼개면 에이전트가 매번 맥락을 다시 잡느라 느리고, 서로 얽힌 수정을 따로 하다 충돌한다.
 *
 * 펼치면 지금 모아 둔 코멘트를 위치와 함께 나열한다. diff 가 그새 바뀌어 화면에서 카드를 못 찾는
 * 코멘트도 여기에는 반드시 보이므로, "썼는데 어디 갔지" 가 생기지 않는다.
 */
export default function DiffCommentsBar({
  comments,
  onRemove,
  onDiscardAll,
  onSend
}: {
  comments: DiffComment[]
  onRemove: (id: string) => void
  onDiscardAll: () => void
  onSend: () => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (!comments.length) return null

  const n = comments.length
  const label = `Send ${n} comment${n > 1 ? 's' : ''}`

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-3)]">
      {expanded && (
        <ul className="max-h-40 overflow-y-auto border-b border-[var(--border)]">
          {comments.map((c) => (
            <li key={c.id} className="group flex items-start gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-2xs text-neutral-500">{commentLocation(c)}</p>
                <p className="truncate text-xs text-neutral-300">{c.body}</p>
              </div>
              <button
                onClick={() => onRemove(c.id)}
                title="Delete this comment"
                aria-label={`Delete the comment on ${commentLocation(c)}`}
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-600 opacity-0 hover:bg-[var(--surface-2)] hover:text-[var(--danger-400)] group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-neutral-400 hover:text-neutral-100"
          title={expanded ? 'Hide the comment list' : 'Show the comment list'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          <span className="truncate">
            {n} unsent comment{n > 1 ? 's' : ''}
          </span>
        </button>
        <button
          onClick={onDiscardAll}
          title="Discard every unsent comment"
          aria-label="Discard every unsent comment"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-[var(--danger-400)]"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={onSend}
          title={'Send every comment to the agent as one message' + ' (⌘↵)'}
          className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--info-600)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--info-500)]"
        >
          <Send size={11} />
          {label}
          {/* 같은 ⌘↵ 로 코멘트를 저장하고 그대로 마지막 전송까지 간다 — 있는 줄 알아야 쓴다. */}
          <span className="opacity-60">⌘↵</span>
        </button>
      </div>
    </div>
  )
}
