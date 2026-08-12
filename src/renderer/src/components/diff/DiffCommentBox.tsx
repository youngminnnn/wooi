import { useEffect, useRef, useState } from 'react'

/**
 * diff 라인 코멘트 입력 상자. 새로 달 때와 고칠 때가 같은 상자를 쓴다.
 *
 * Enter 는 줄바꿈이고 ⌘/Ctrl+Enter 가 저장이다 — 코멘트는 대개 한 줄보다 길다.
 * Esc 는 여기서 삼킨다(stopPropagation): 그대로 두면 Composer 의 전역 Esc 핸들러까지 올라가
 * 실행 중인 턴이 중단된다.
 */
export default function DiffCommentBox({
  initial = '',
  submitLabel,
  placeholder,
  onSubmit,
  onCancel
}: {
  initial?: string
  submitLabel: string
  placeholder?: string
  onSubmit: (body: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [])

  // 내용에 맞춰 높이를 늘린다(Composer 의 입력창과 같은 방식).
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [body])

  const submit = (): void => {
    const trimmed = body.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div className="border-y border-[var(--border)] bg-[var(--bg-3)] px-3 py-2 font-sans">
      <textarea
        ref={ref}
        value={body}
        placeholder={placeholder ?? 'What should the agent change here?'}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
            return
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            // Esc 와 같은 이유로 여기서 삼킨다 — 이 상자의 ⌘↵ 는 "이 코멘트 저장"이고,
            // 흘려보내면 Changes 패널의 ⌘↵(모아 둔 코멘트 전송)가 같은 타건에 이어서 돈다
            // (저장으로 상자가 사라진 뒤라 그쪽 입력창 가드에도 걸리지 않는다).
            e.stopPropagation()
            submit()
          }
        }}
        rows={2}
        className="w-full resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[var(--info-500)]"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="flex-1 text-[10px] text-neutral-600">⌘↵ to save · Esc to cancel</span>
        <button
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!body.trim()}
          className="rounded bg-[var(--info-600)] px-2 py-1 text-xs font-medium text-white hover:bg-[var(--info-500)] disabled:opacity-40 disabled:hover:bg-[var(--info-600)]"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
