import { useState } from 'react'
import { MessageSquare, Pencil, Trash2 } from 'lucide-react'
import type { DiffComment } from '../../lib/diffComments'
import DiffCommentBox from './DiffCommentBox'

/**
 * diff 줄 아래에 끼워 넣는, 아직 보내지 않은 코멘트 카드.
 * 리뷰 모드의 [[ReviewFindingCard]] 와 같은 자리(줄 바로 밑)에 놓이지만 성격이 다르다 —
 * 이쪽은 에이전트가 남긴 지적이 아니라 사용자가 쓰는 중인 초안이다.
 */
export default function DiffCommentCard({
  comment,
  onEdit,
  onRemove
}: {
  comment: DiffComment
  onEdit: (body: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <DiffCommentBox
        initial={comment.body}
        submitLabel="Save"
        onSubmit={(body) => {
          onEdit(body)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  const range = comment.from === comment.to ? `L${comment.from}` : `L${comment.from}-${comment.to}`

  return (
    <div className="group/card border-y border-[var(--border)] bg-[var(--bg-3)] px-3 py-2 font-sans">
      <div className="flex items-center gap-1.5 text-2xs text-neutral-500">
        <MessageSquare size={11} className="shrink-0 text-[var(--info-400)]" />
        <span className="font-mono">{range}</span>
        <span className="flex-1" />
        <button
          onClick={() => setEditing(true)}
          title="Edit this comment"
          aria-label="Edit this comment"
          className="grid h-5 w-5 place-items-center rounded text-neutral-600 opacity-0 transition-opacity hover:bg-[var(--surface-2)] hover:text-neutral-200 group-hover/card:opacity-100 focus-visible:opacity-100"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={onRemove}
          title="Delete this comment"
          aria-label="Delete this comment"
          className="grid h-5 w-5 place-items-center rounded text-neutral-600 opacity-0 transition-opacity hover:bg-[var(--surface-2)] hover:text-[var(--danger-400)] group-hover/card:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-200">
        {comment.body}
      </p>
    </div>
  )
}
