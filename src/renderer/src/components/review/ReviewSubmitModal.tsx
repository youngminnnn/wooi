import { useState } from 'react'
import { Check, MessageSquare, XCircle } from 'lucide-react'
import type { ReviewSession, ReviewVerdict } from '@shared/types'
import { SELF_REVIEW_BLOCKED } from '@shared/types'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from '../Modal'
import { useStore } from '../../store'

interface VerdictOption {
  value: ReviewVerdict
  label: string
  hint: string
  icon: React.ReactNode
  /** 선택됐을 때의 테두리·글자색. 판정의 무게를 색으로 드러낸다. */
  activeClass: string
}

const OPTIONS: VerdictOption[] = [
  {
    value: 'comment',
    label: 'Comment',
    hint: 'Leave feedback without approving or blocking.',
    icon: <MessageSquare size={14} />,
    activeClass: 'border-[var(--info-500)]/60 bg-[var(--info-500)]/10 text-[var(--info-200)]'
  },
  {
    value: 'approve',
    label: 'Approve',
    hint: 'Sign off on this pull request.',
    icon: <Check size={14} />,
    activeClass:
      'border-[var(--success-500)]/60 bg-[var(--success-500)]/10 text-[var(--success-200)]'
  },
  {
    value: 'request-changes',
    label: 'Request changes',
    hint: 'Block the merge until the feedback is addressed.',
    icon: <XCircle size={14} />,
    activeClass: 'border-[var(--danger-500)]/60 bg-[var(--danger-500)]/10 text-[var(--danger-200)]'
  }
]

/**
 * PR 전체에 대한 판정을 제출한다.
 *
 * 본문은 에이전트의 총평으로 미리 채운다 — 대부분 그 문장이 곧 리뷰 요약이고, 사용자는
 * 다듬기만 하면 된다. 빈 화면에서 요약을 다시 쓰게 하는 건 낭비다.
 */
export default function ReviewSubmitModal({
  session,
  onClose
}: {
  session: ReviewSession
  onClose: () => void
}): React.JSX.Element {
  const submitReview = useStore((s) => s.submitReview)

  // 내 PR 이면 GitHub 이 승인·변경 요청을 거부한다. 선택지를 남겨 두면 사용자는 누르고 나서야
  // GraphQL 에러를 보게 되므로 애초에 코멘트만 남긴다.
  const options = session.viewerIsAuthor ? OPTIONS.filter((o) => o.value === 'comment') : OPTIONS

  const [verdict, setVerdict] = useState<ReviewVerdict>('comment')
  const [body, setBody] = useState(session.summary)
  const [busy, setBusy] = useState(false)

  // GitHub 은 승인이 아닌 판정에 본문을 요구한다. 눌러 보고 실패하는 대신 미리 막는다.
  const needsBody = verdict !== 'approve'
  const canSubmit = !busy && (!needsBody || body.trim().length > 0)

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    const ok = await submitReview(session.id, verdict, body)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Modal
      title={`Review pull request #${session.prNumber}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button onClick={submit} disabled={!canSubmit} className={primaryBtn}>
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className={labelClass}>Verdict</span>
          <div className="space-y-1.5">
            {options.map((o) => {
              const active = verdict === o.value
              return (
                <button
                  key={o.value}
                  onClick={() => setVerdict(o.value)}
                  aria-pressed={active}
                  className={
                    'w-full flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ' +
                    (active
                      ? o.activeClass
                      : 'border-[var(--border-2)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <span className="mt-0.5 shrink-0">{o.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs opacity-70">{o.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {session.viewerIsAuthor && (
            <p className="mt-1.5 text-xs text-neutral-500">
              {SELF_REVIEW_BLOCKED} You can still leave a comment.
            </p>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="review-verdict-body">
            Message {needsBody && <span className="text-[var(--danger-400)]">*</span>}
          </label>
          <textarea
            id="review-verdict-body"
            className={`${inputClass} min-h-[120px] resize-y`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // IME 조합 중의 Enter 는 한글 확정이지 전송이 아니다.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                void submit()
              }
            }}
            placeholder={needsBody ? 'Required — what should the author know?' : 'Optional'}
          />
          <p className="mt-1.5 text-xs text-neutral-500">
            Prefilled with the agent&rsquo;s summary — edit it however you like. &#8984;&#8629; to
            submit.
          </p>
        </div>
      </div>
    </Modal>
  )
}
