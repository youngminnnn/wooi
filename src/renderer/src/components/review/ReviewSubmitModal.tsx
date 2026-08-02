import { useState } from 'react'
import { Check, MessageSquare, XCircle } from 'lucide-react'
import type { ReviewSession, ReviewVerdict } from '@shared/types'
import { DUPLICATE_REVIEW_BLOCKED, SELF_REVIEW_BLOCKED } from '@shared/types'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from '../Modal'
import { useStore } from '../../store'
import { isPosted } from '../../lib/review'

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
  const postFindings = useStore((s) => s.postFindings)
  // 셀렉터에서 새 배열을 만들면 스냅샷이 매번 달라져 렌더가 멈추지 않는다 — 뷰를 통째로 받는다.
  const view = useStore((s) => s.reviewViews[session.id])

  // 내 PR 이면 GitHub 이 승인·변경 요청을 거부한다. 선택지를 남겨 두면 사용자는 누르고 나서야
  // GraphQL 에러를 보게 되므로 애초에 코멘트만 남긴다.
  const options = session.viewerIsAuthor ? OPTIONS.filter((o) => o.value === 'comment') : OPTIONS

  // 리뷰 제출은 사용자가 이 PR 을 마무리하는 자리다. 여기서 묻지 않으면 읽어 본 지적을
  // 그대로 두고 판정만 내고 나가게 되고, 그 지적은 상대에게 영영 전달되지 않는다.
  const unposted = (view?.findings ?? []).filter((f) => !isPosted(session, f.id))
  const [alsoPost, setAlsoPost] = useState(true)

  const [verdict, setVerdict] = useState<ReviewVerdict>('comment')
  const [body, setBody] = useState(session.summary)
  const [busy, setBusy] = useState(false)

  // GitHub 은 승인이 아닌 판정에 본문을 요구한다. 눌러 보고 실패하는 대신 미리 막는다.
  const needsBody = verdict !== 'approve'

  // 같은 판정·같은 문장을, 그 사이 움직이지 않은 PR 에 또 내는 것은 상대의 타임라인만
  // 어지럽힌다. main 도 제출 직전에 실제 head sha 로 다시 확인하지만, 버튼이 눌리기 전에
  // 이유를 보여 주는 편이 낫다.
  const last = session.lastSubmission
  const duplicate =
    !!last &&
    last.verdict === verdict &&
    last.body === body.trim() &&
    last.headSha === session.lastSeenHeadSha

  const posting = alsoPost && unposted.length > 0
  // 판정이 중복이어도 아직 안 단 코멘트는 올릴 수 있어야 한다 — 그러지 않으면 이 화면이
  // 막다른 길이 되고, 사용자는 코멘트를 달려고 목록으로 돌아가야 한다.
  const submitsVerdict = !duplicate
  const canSubmit =
    !busy &&
    (submitsVerdict || posting) &&
    (!submitsVerdict || !needsBody || body.trim().length > 0)

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    if (posting) {
      const res = await postFindings(
        session.id,
        unposted.map((f) => f.id)
      )
      // 코멘트가 하나라도 못 올라갔으면 판정은 보류한다 — "변경 요청" 만 덩그러니 올라가고
      // 근거가 되는 지적은 없는 상태가 사용자가 원한 결과일 리 없다. 토스트가 이유를 말해 준다.
      if (res.failed > 0) {
        setBusy(false)
        return
      }
    }
    if (submitsVerdict) {
      const ok = await submitReview(session.id, verdict, body)
      setBusy(false)
      if (ok) onClose()
      return
    }
    setBusy(false)
    onClose()
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
            {busy
              ? 'Submitting…'
              : !submitsVerdict
                ? `Post ${unposted.length} comment${unposted.length === 1 ? '' : 's'}`
                : posting
                  ? `Post ${unposted.length} & submit`
                  : 'Submit review'}
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
          {duplicate ? (
            <p className="mt-1.5 text-xs text-[var(--warning-300)]">
              {DUPLICATE_REVIEW_BLOCKED} Change the verdict or the message to submit again
              {posting ? ' — your comments still go up.' : '.'}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-neutral-500">
              Prefilled with the agent&rsquo;s summary — edit it however you like. &#8984;&#8629; to
              submit.
            </p>
          )}
        </div>

        {unposted.length > 0 && (
          <div className="rounded-lg border border-[var(--border-2)] bg-[var(--surface)] px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--info-500)]"
                checked={alsoPost}
                onChange={(e) => setAlsoPost(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-sm text-neutral-200">
                  Post {unposted.length} unposted comment{unposted.length === 1 ? '' : 's'} with
                  this review
                </span>
                <span className="block text-xs text-neutral-500">
                  They go up first, then the verdict. Uncheck to submit the verdict alone — or
                  discard the ones you don&rsquo;t want from the findings list.
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}
