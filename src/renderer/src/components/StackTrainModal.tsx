import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, Minus } from 'lucide-react'
import type {
  PrMergeMethod,
  PrState,
  StackCascadeStep,
  StackTrainPlan,
  StackTrainResult
} from '@shared/types'
import { useStore } from '../store'
import ConflictResolveAction from './ConflictResolveAction'
import Modal, { ghostBtn, primaryBtn } from './Modal'

type Phase = 'plan' | 'running' | 'result'

// StackPopover 의 PR_DOT 과 반드시 함께 바꾼다. 계획 화면도 팝오버와 같은 상태 언어를 써야 한다.
const PR_DOT: Record<PrState, { dotClass: string; label: string }> = {
  draft: { dotClass: 'bg-neutral-400', label: 'Draft' },
  review_required: { dotClass: 'bg-[var(--warning-400)]', label: 'Review required' },
  changes_requested: { dotClass: 'bg-[var(--attention-400)]', label: 'Changes requested' },
  ci_pending: { dotClass: 'bg-[var(--warning-400)]', label: 'Checks pending' },
  ci_failed: { dotClass: 'bg-[var(--danger-400)]', label: 'Checks failed' },
  approved: { dotClass: 'bg-[var(--success-400)]', label: 'Ready to merge' },
  conflict: { dotClass: 'bg-[var(--danger-400)]', label: 'Conflict' },
  open: { dotClass: 'bg-[var(--open-400)]', label: 'Open' },
  merged: { dotClass: 'bg-[var(--merged-400)]', label: 'Merged' },
  closed: { dotClass: 'bg-neutral-500', label: 'Closed' }
}

const METHODS: { value: PrMergeMethod; label: string }[] = [
  { value: 'squash', label: 'Squash & merge' },
  { value: 'merge', label: 'Create a merge commit' },
  { value: 'rebase', label: 'Rebase & merge' }
]

function StepIcon({ step }: { step: StackCascadeStep }): React.JSX.Element {
  if (step.status === 'ok') return <Check size={12} className="text-[var(--success-400)]" />
  if (step.status === 'skipped') return <Minus size={12} className="text-neutral-500" />
  return <AlertTriangle size={12} className="text-[var(--warning-400)]" />
}

export default function StackTrainModal({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('plan')
  const [plan, setPlan] = useState<StackTrainPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [method, setMethod] = useState<PrMergeMethod>('squash')
  const [result, setResult] = useState<StackTrainResult | null>(null)
  const progress = useStore((s) => s.stackProgress[workspaceId])
  const runMergeTrain = useStore((s) => s.runMergeTrain)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const workspaces = useStore((s) => s.app?.workspaces)

  useEffect(() => {
    setOverlayOpen(true)
    return () => setOverlayOpen(false)
  }, [setOverlayOpen])

  useEffect(() => {
    let active = true
    void window.api.stack
      .trainPlan(workspaceId)
      .then((next) => {
        if (!active) return
        setPlan(next)
        setPlanError(next.error ?? null)
      })
      .catch((err) => {
        if (active) setPlanError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [workspaceId])

  const run = async (): Promise<void> => {
    if (!plan || plan.mergeableCount === 0) return
    setPhase('running')
    const next = await runMergeTrain(workspaceId, method, plan.mergeableCount)
    setResult(next)
    setPhase('result')
  }

  const close = phase === 'running' ? (): void => undefined : onClose
  // 승인 한 번이 무엇을 삼키는지 — 머지 N 번과 리모트 히스토리를 되쓰는 force-push M 번 — 을
  // 숫자와 브랜치 이름으로 못 박는다. 이 문장이 없으면 버튼 하나가 조용히 그 일을 다 해 버린다.
  const approval =
    plan && plan.mergeableCount > 0
      ? `Merges ${plan.mergeableCount} pull request${plan.mergeableCount === 1 ? '' : 's'} in order, then force-pushes ${plan.forcePushCount} branch${plan.forcePushCount === 1 ? '' : 'es'}${plan.forcePushBranches.length > 0 ? `: ${plan.forcePushBranches.join(', ')}.` : '.'}`
      : ''
  const problems =
    result?.steps.filter((step) => ['conflict', 'failed', 'diverged'].includes(step.status)) ?? []
  const skipped = result?.steps.filter((step) => step.status === 'skipped') ?? []
  const stoppedProblem = result?.stoppedAt
    ? [...(result.steps ?? [])].reverse().find((step) => step.branch === result.stoppedAt?.branch)
    : undefined
  const diverged =
    stoppedProblem?.status === 'diverged' ||
    /diverg|rewritten/i.test(result?.stoppedAt?.reason ?? '')
  const conflict =
    stoppedProblem?.status === 'conflict' || /conflict/i.test(result?.stoppedAt?.reason ?? '')
  // 충돌은 트레인을 시작한 워크스페이스가 아니라 그 층의 워크트리에 남는다 — 단계가 들고 온
  // workspaceId 로만 대상을 정한다. 위 conflict 는 reason 문구까지 훑는 느슨한 판정이라
  // 안내 문구용으로는 맞지만, 토큰을 쓰는 액션의 근거로 삼기에는 느슨하다.
  const conflictWorkspace =
    stoppedProblem?.status === 'conflict' && stoppedProblem.workspaceId
      ? workspaces?.find((candidate) => candidate.id === stoppedProblem.workspaceId)
      : undefined

  return (
    <Modal
      title="Merge stack"
      onClose={close}
      width={600}
      footer={
        phase === 'plan' ? (
          <>
            <button className={ghostBtn} onClick={onClose}>
              Close
            </button>
            {!planError && plan && plan.mergeableCount > 0 && (
              <button className={primaryBtn} onClick={() => void run()}>
                Start merge train
              </button>
            )}
          </>
        ) : phase === 'running' ? (
          <button className={ghostBtn} disabled>
            Merge train in progress
          </button>
        ) : (
          <button className={primaryBtn} onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {phase === 'plan' && (
        <div className="space-y-4">
          {!plan && !planError && (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-neutral-400">
              <Loader2 size={15} className="animate-spin" /> Planning merge train…
            </div>
          )}
          {planError && (
            <div className="rounded-lg border border-[var(--danger-400)]/40 bg-[var(--danger-400)]/10 p-3 text-sm text-[var(--danger-300)]">
              {planError}
            </div>
          )}
          {plan && !planError && (
            <>
              <div className="space-y-1.5">
                {plan.layers.map((layer, index) => {
                  const dot = layer.state ? PR_DOT[layer.state] : null
                  const notReached = index >= plan.mergeableCount
                  return (
                    <div
                      key={layer.branch}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className={
                            'h-2 w-2 shrink-0 rounded-full ' + (dot?.dotClass ?? 'bg-neutral-600')
                          }
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-neutral-200">
                          {layer.branch}
                        </span>
                        {layer.prNumber !== null && (
                          <span className="tabular-nums text-neutral-400">#{layer.prNumber}</span>
                        )}
                        <span className="text-xs text-neutral-400">
                          {dot?.label ?? 'No pull request'}
                        </span>
                        {notReached && (
                          <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                            Not reached
                          </span>
                        )}
                      </div>
                      {layer.blockedReason && (
                        <div className="mt-1 pl-4 text-xs text-[var(--warning-300)]">
                          {layer.blockedReason}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {plan.mergeableCount === 0 && (
                <div className="text-sm text-[var(--warning-300)]">
                  The bottom layer blocks the train:{' '}
                  {plan.layers[0]?.blockedReason ?? 'It cannot be merged.'}
                </div>
              )}
              <label className="block text-xs text-neutral-400">
                Merge method
                <select
                  value={method}
                  onChange={(event) => setMethod(event.target.value as PrMergeMethod)}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-[var(--border-strong)]"
                >
                  {METHODS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm leading-relaxed text-neutral-200">{approval}</p>
            </>
          )}
        </div>
      )}

      {phase === 'running' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-neutral-300">
            <Loader2 size={15} className="animate-spin text-[var(--accent-400)]" /> Merging the
            stack. This dialog cannot be closed while remote history is being rewritten.
          </div>
          <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
            {/* 한 브랜치에 merge·retarget·restack 이 연달아 생기므로 branch 가 아니라 단계 인덱스로 식별한다. */}
            {progress?.done.map((step, index) => (
              <div
                key={`${index}-${step.branch}-${step.kind}`}
                className="flex items-center gap-2 text-xs"
              >
                <span className="grid w-4 place-items-center">
                  <StepIcon step={step} />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
                  {step.branch}
                </span>
                <span className="text-neutral-500">
                  {step.kind} · {step.status}
                </span>
              </div>
            ))}
            {progress?.current && (
              <div className="flex items-center gap-2 text-xs">
                <span className="grid w-4 place-items-center">
                  <Loader2 size={12} className="animate-spin text-[var(--accent-400)]" />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
                  {progress.current.branch}
                </span>
                <span className="text-neutral-500">{progress.current.kind}…</span>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="space-y-4 text-sm">
          {result.error ? (
            <div className="rounded-lg border border-[var(--danger-400)]/40 bg-[var(--danger-400)]/10 p-3 text-[var(--danger-300)]">
              The merge train could not run: {result.error}
            </div>
          ) : result.stoppedAt ? (
            <div className="rounded-lg border border-[var(--warning-400)]/40 bg-[var(--warning-400)]/10 p-3 text-neutral-200">
              <div className="font-medium text-[var(--warning-300)]">
                Merge train stopped at <span className="font-mono">{result.stoppedAt.branch}</span>.
              </div>
              <div className="mt-1">{result.stoppedAt.reason}</div>
              <div className="mt-2 text-neutral-300">
                {diverged ? (
                  <>
                    Inspect the branch against <span className="font-mono">origin</span> and take
                    whichever side is right. Run{' '}
                    <span className="font-mono">git fetch origin {result.stoppedAt.branch}</span>;
                    if GitHub is ahead, use{' '}
                    <span className="font-mono">
                      git reset --hard origin/{result.stoppedAt.branch}
                    </span>
                    .
                  </>
                ) : conflict ? (
                  <>
                    Resolve the conflict in the worktree, then re-run the merge train.
                    {conflictWorkspace && (
                      <>
                        {' '}
                        <ConflictResolveAction
                          workspace={conflictWorkspace}
                          conflictedFileCount={stoppedProblem?.conflictedFiles?.length}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <>Address the reason above, refresh the stack, and re-run the merge train.</>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[var(--success-400)]">
              <Check size={15} /> Merge train complete.
            </div>
          )}
          <div>
            <span className="text-neutral-400">Merged pull requests:</span>{' '}
            {result.mergedPrs.length > 0
              ? result.mergedPrs.map((number) => `#${number}`).join(', ')
              : 'None'}
          </div>
          {(problems.length > 0 || skipped.length > 0) && (
            <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
              {[...problems, ...skipped].map((step, index) => (
                <div
                  key={`${index}-${step.branch}-${step.kind}`}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="mt-0.5 grid w-4 place-items-center">
                    <StepIcon step={step} />
                  </span>
                  <span className="font-mono text-neutral-300">{step.branch}</span>
                  <span
                    className={
                      step.status === 'skipped' ? 'text-neutral-500' : 'text-[var(--warning-300)]'
                    }
                  >
                    {step.kind} · {step.status}
                    {step.message ? ` — ${step.message}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
