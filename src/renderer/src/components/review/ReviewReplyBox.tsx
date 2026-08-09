import { useState } from 'react'
import { useStore } from '../../store'

/**
 * 스레드에 답장하는 입력 상자.
 *
 * 활동 타임라인과 diff 위의 스레드가 **같은 상자**를 쓴다 — 답장은 어디서 하든 같은 일이므로
 * 모양도 키도 같아야 한다.
 */
export default function ReviewReplyBox({
  reviewId,
  commentId,
  onDone,
  onCancel,
  placeholder = 'Reply in this thread…'
}: {
  reviewId: string
  /** 답장을 붙일 코멘트. GitHub 이 알아서 스레드 루트에 매단다. */
  commentId: number
  onDone: () => void
  onCancel: () => void
  placeholder?: string
}): React.JSX.Element {
  const replyToThread = useStore((s) => s.replyToThread)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    const ok = await replyToThread(reviewId, commentId, text)
    setBusy(false)
    if (ok) {
      setText('')
      onDone()
    }
  }

  return (
    <div>
      <textarea
        autoFocus
        className="min-h-[56px] w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-2 py-1.5 text-sm text-neutral-100 focus:border-[var(--border-strong)] focus:outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            void send()
          }
        }}
        placeholder={placeholder}
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={() => void send()}
          disabled={!text.trim() || busy}
          className="rounded-md border border-[var(--border-2)] px-2 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send reply'}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
