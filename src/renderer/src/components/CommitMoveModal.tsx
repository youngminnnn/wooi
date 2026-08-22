import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, Minus } from 'lucide-react'
import type {
  CommitEntry,
  CommitMoveBlocker,
  CommitMovePreview,
  CommitMoveResult,
  StackCascadeStep
} from '@shared/types'
import { useStore } from '../store'
import Modal, { ghostBtn } from './Modal'

const dangerBtn =
  'text-sm px-3.5 py-1.5 rounded-lg bg-[var(--danger-500)]/90 text-white font-medium shadow-sm hover:bg-[var(--danger-500)] disabled:bg-[var(--border)] disabled:text-neutral-600 disabled:cursor-not-allowed'

function pr(branch: string, number: number | null): React.JSX.Element {
  return (
    <span className="font-mono">
      {branch}
      {number ? ` (#${number})` : ''}
    </span>
  )
}

function Blockers({ blockers }: { blockers: CommitMoveBlocker[] }): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--danger-400)]/40 bg-[var(--danger-400)]/10 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--danger-400)]">
        <AlertTriangle size={14} /> This operation is blocked
      </div>
      {blockers.map((blocker, index) => (
        <div
          key={`${blocker.kind}-${blocker.branch}-${index}`}
          className="text-xs text-neutral-300"
        >
          <span className="font-mono text-neutral-200">{blocker.branch || 'Stack'}</span> —{' '}
          {blocker.message}
        </div>
      ))}
    </div>
  )
}

function Steps({ steps }: { steps: StackCascadeStep[] }): React.JSX.Element {
  return (
    <div className="space-y-1">
      {steps.length === 0 && <div className="text-xs text-neutral-500">No cascade steps.</div>}
      {steps.map((step, index) => {
        const problem = ['conflict', 'failed', 'diverged'].includes(step.status)
        return (
          <div
            key={`${step.branch}-${step.kind}-${index}`}
            className="flex items-start gap-2 text-xs"
          >
            <span className="mt-0.5 w-3 shrink-0">
              {problem ? (
                <AlertTriangle size={12} className="text-[var(--warning-400)]" />
              ) : step.status === 'skipped' ? (
                <Minus size={12} className="text-neutral-500" />
              ) : (
                <Check size={12} className="text-[var(--success-400)]" />
              )}
            </span>
            <div>
              <span className="font-mono text-neutral-300">{step.branch}</span>{' '}
              <span className={problem ? 'text-[var(--warning-300)]' : 'text-neutral-500'}>
                {step.kind} · {step.status}
                {step.message ? ` — ${step.message}` : ''}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function CommitMoveModal({
  workspaceId,
  commit,
  onClose
}: {
  workspaceId: string
  commit: CommitEntry
  onClose: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<CommitMovePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CommitMoveResult | null>(null)
  const progress = useStore((s) => s.stackProgress[workspaceId])
  const refreshGit = useStore((s) => s.refreshGit)
  const refreshPr = useStore((s) => s.refreshPr)
  const workspaces = useStore((s) => s.app?.workspaces)

  useEffect(() => {
    let alive = true
    void window.api.stack
      .commitMovePreview(workspaceId, commit.sha)
      .then((next) => {
        if (!alive) return
        if ('error' in next) setPreviewError(next.error)
        else setPreview(next)
      })
      .catch((err) => {
        if (alive) setPreviewError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [workspaceId, commit.sha])

  const apply = async (): Promise<void> => {
    if (!preview || preview.blockers.length > 0) return
    setRunning(true)
    try {
      const next = await window.api.stack.commitMoveApply(workspaceId, commit.sha)
      setResult(next)
      if (next.status === 'moved') {
        const branches = new Set(next.after.map((tip) => tip.branch))
        for (const workspace of workspaces ?? []) {
          if (!branches.has(workspace.branch)) continue
          void refreshGit(workspace.id)
          void refreshPr(workspace.id)
        }
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const footer = result ? (
    <button onClick={onClose} className={ghostBtn}>
      Close
    </button>
  ) : (
    <>
      <button onClick={onClose} disabled={running} className={ghostBtn}>
        Cancel
      </button>
      <button
        onClick={() => void apply()}
        disabled={!preview || preview.blockers.length > 0 || running}
        className={dangerBtn}
      >
        {running ? 'Moving commit…' : 'Move commit and force-push'}
      </button>
    </>
  )

  return (
    <Modal
      title="Move commit down"
      onClose={running ? () => undefined : onClose}
      footer={footer}
      width={680}
    >
      {previewError ? (
        <div className="text-sm text-[var(--danger-400)]">{previewError}</div>
      ) : !preview ? (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 size={14} className="animate-spin" /> Checking the stack…
        </div>
      ) : result ? (
        <Result result={result} />
      ) : (
        <div className="space-y-4 text-sm text-neutral-300">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Commit</div>
            <div className="mt-1">
              <span className="font-mono text-[var(--info-400)]">{preview.commit.shortSha}</span>{' '}
              {preview.commit.subject}
            </div>
          </div>
          <div>
            Moving from {pr(preview.upper.branch, preview.upper.prNumber)} into{' '}
            {pr(preview.lower.branch, preview.lower.prNumber)}.
          </div>
          <section>
            <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Files moving between layer diffs
            </h4>
            <div className="mt-1 max-h-28 overflow-y-auto rounded-md bg-[var(--surface-2)] p-2 font-mono text-xs select-text">
              {preview.upper.filesLost.length ? (
                preview.upper.filesLost.map((file) => <div key={file}>{file}</div>)
              ) : (
                <div className="text-neutral-500">No paths reported.</div>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              These are the files touched by the commit, not a recomputed post-move diff. The exact
              result is only known after the history rewrite.
            </p>
          </section>
          <section className="rounded-lg border border-[var(--warning-400)]/50 bg-[var(--warning-400)]/10 p-3">
            <h4 className="font-medium text-[var(--warning-300)]">
              Every affected branch will be force-pushed
            </h4>
            <div className="mt-2 space-y-1 text-xs">
              <div>{pr(preview.lower.branch, preview.lower.prNumber)}</div>
              <div>{pr(preview.upper.branch, preview.upper.prNumber)}</div>
              {preview.alsoForcePushed.map((entry) => (
                <div key={entry.branch}>{pr(entry.branch, entry.prNumber)}</div>
              ))}
            </div>
          </section>
          <section>
            <h4 className="text-xs font-medium text-neutral-300">
              Branch tips before this operation (keep these to recover)
            </h4>
            <div className="mt-1 space-y-1 rounded-md bg-[var(--surface-2)] p-2 font-mono text-xs select-text">
              {preview.before.map((tip) => (
                <div key={tip.branch}>
                  {tip.branch} {tip.sha}
                </div>
              ))}
            </div>
          </section>
          {preview.blockers.length > 0 && <Blockers blockers={preview.blockers} />}
          {running && progress && (
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Loader2 size={12} className="animate-spin" />
              {progress.current
                ? `${progress.current.kind} on ${progress.current.branch}`
                : 'Preparing rewrite…'}
              {progress.total != null ? ` (${progress.done.length}/${progress.total})` : ''}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Result({ result }: { result: CommitMoveResult }): React.JSX.Element {
  // "되돌렸는가" 만 보면 성공까지 위험으로 읽힌다 — 이동이 끝난 결과도 rolledBack 은 false 다
  // (push 가 이미 나갔으므로 되감지 않는 것이 옳다). 손으로 복구해야 하는 상태는 "끝내지 못했는데
  // 되돌리지도 못했다" 뿐이다. 여기에는 push 실패, 롤백 자체의 실패, 그리고 이동은 나갔지만 위층
  // restack 이 깨진 경우가 모두 들어간다 — 마지막 것도 사용자가 tip 을 들고 손대야 하는 상태다.
  const unsafe = result.status !== 'moved' && result.status !== 'blocked' && !result.rolledBack
  return (
    <div className="space-y-4 text-sm text-neutral-300">
      {result.status === 'moved' && (
        <div className="text-[var(--success-400)]">
          The commit was moved. Rewritten branches:{' '}
          {result.after.map((tip) => tip.branch).join(', ')}.
        </div>
      )}
      {result.status === 'blocked' && (
        <>
          <div>No history was changed.</div>
          <Blockers blockers={result.blockers ?? []} />
        </>
      )}
      {result.status === 'conflict' && (
        <div className="space-y-2">
          {/* 롤백 여부를 확인하지 않고 "아무것도 바뀌지 않았다" 고 적으면, 되돌리기가 실패했거나
              이동은 이미 push 된 뒤 위층 restack 에서 충돌한 경우에 정확히 거짓말이 된다. */}
          <div className="font-medium text-[var(--warning-300)]">
            {result.rolledBack
              ? 'Nothing was changed; the local rewrite was rolled back.'
              : 'The move went out, but a branch above it hit a conflict — see the steps below.'}
          </div>
          <p>
            The usual cause is that this commit depends on commits that stay in the upper layer.
            Move those commits too, or reorder the commits first.
          </p>
          {result.conflictedFiles?.length ? (
            <ul className="font-mono text-xs space-y-0.5">
              {result.conflictedFiles.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {result.status === 'error' && (
        <div
          className={
            unsafe
              ? 'rounded-lg border border-[var(--danger-400)] bg-[var(--danger-400)]/10 p-3 text-[var(--danger-400)]'
              : 'text-[var(--danger-400)]'
          }
        >
          <div>{result.message ?? 'The operation failed.'}</div>
          {result.failedStep && (
            <div className="mt-1">
              Failed step: <span className="font-mono">{result.failedStep}</span>
            </div>
          )}
          {unsafe && (
            <p className="mt-2 font-medium">
              A push had already gone out and rollback was not safe. Recover by hand with the before
              tips below.
            </p>
          )}
        </div>
      )}
      {unsafe && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Tips title="Before (recovery tips)" tips={result.before} />
          <Tips title="After (current tips)" tips={result.after} />
        </div>
      )}
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Steps</h4>
        <Steps steps={result.steps} />
      </section>
    </div>
  )
}

function Tips({
  title,
  tips
}: {
  title: string
  tips: Array<{ branch: string; sha: string }>
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 font-medium text-neutral-300">{title}</div>
      <div className="space-y-1 rounded-md bg-[var(--surface-2)] p-2 font-mono select-text">
        {tips.map((tip) => (
          <div key={tip.branch} className="break-all">
            {tip.branch}
            <br />
            {tip.sha}
          </div>
        ))}
      </div>
    </div>
  )
}
