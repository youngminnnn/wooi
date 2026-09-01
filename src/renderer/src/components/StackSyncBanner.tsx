import React from 'react'
import { AlertTriangle, Check, GitMerge, Loader2, Minus, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'
import ConflictResolveAction from './ConflictResolveAction'

/**
 * 부모 PR 이 병합돼 스택이 stale 해졌을 때 뜨는 배너.
 *
 * 병합을 wooi 에서 했든 `gh pr merge`·GitHub 웹에서 했든 똑같이 뜬다 — 병합은 어디서나 할 수
 * 있는 행위라, 캐스케이드를 특정 병합 경로에 묶지 않고 감지에 묶었다.
 *
 * 감지는 자동이지만 실행은 자동이 아니다 — 캐스케이드는 자식 브랜치를 rebase 한 뒤
 * force-push 하므로, 사용자가 모르는 사이에 리모트 히스토리가 바뀌면 안 된다.
 * 그래서 무엇을 할지 먼저 보여 주고 승인을 받는다.
 */
export default function StackSyncBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const applyStackSync = useStore((s) => s.applyStackSync)
  const dismissStackSync = useStore((s) => s.dismissStackSync)
  const requireGithub = useStore((s) => s.requireGithub)
  const progress = useStore((s) => s.stackProgress[workspace.id])
  const workspaces = useStore((s) => s.app?.workspaces)
  const busy = !!progress && !progress.finished

  const plan = workspace.stackSync
  if (!plan) return null

  const closed = plan.affected.filter((a) => a.prClosed)
  const diverged = plan.affected.filter((a) => a.remoteDiverged)
  const names = plan.affected.map((a) => (a.prNumber ? `#${a.prNumber}` : a.branch)).join(', ')

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-start gap-2.5 rounded-lg border border-[var(--warning-400)]/40 bg-[var(--warning-400)]/10 px-3 py-2.5">
        <GitMerge size={14} className="mt-0.5 shrink-0 text-[var(--warning-400)]" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-200">
          <div className="font-medium">
            <span className="font-mono">{plan.mergedBranch}</span> was merged.
          </div>
          <div className="text-neutral-400">
            {names} still {plan.affected.length > 1 ? 'target' : 'targets'} it. Syncing retargets{' '}
            {plan.affected.length > 1 ? 'them' : 'it'} onto{' '}
            <span className="font-mono">{plan.newBase}</span>, rebases, and force-pushes.
            {closed.length > 0 && (
              <>
                {' '}
                {closed.map((c) => (c.prNumber ? `#${c.prNumber}` : c.branch)).join(', ')}{' '}
                {closed.length > 1 ? 'were' : 'was'} closed by GitHub when the base branch was
                deleted — {closed.length > 1 ? 'they' : 'it'} will be reopened first.
              </>
            )}
          </div>
          {/* 갈라짐은 "실패 예고"가 아니라 "여기는 손대지 않는다"는 예고다 — 깨끗한 worktree 라
              캐스케이드가 조용히 넘어갈 수 있으므로, 승인 전에 따로 떼어 보여 준다. */}
          {diverged.length > 0 && (
            <div className="mt-1 text-[var(--warning-300)]">
              {diverged.map((d) => (d.prNumber ? `#${d.prNumber}` : d.branch)).join(', ')}{' '}
              {diverged.length > 1 ? 'were' : 'was'} rewritten on the remote without Wooi pushing —
              GitHub rebases the branches above a stacked pull request when a lower one merges, and
              your worktree still holds the older commits. Syncing retargets{' '}
              {diverged.length > 1 ? 'them' : 'it'} but skips the rebase, because replaying the old
              commits would fold the merged layer back into{' '}
              {diverged.length > 1 ? 'those PRs' : 'that PR'}. Check the branch against{' '}
              <span className="font-mono">origin</span> and take whichever side is right.
            </div>
          )}
          {progress && (
            <div className="mt-2 space-y-1 border-t border-[var(--warning-400)]/20 pt-2">
              {plan.affected.map((affected) => {
                const current = progress.current?.branch === affected.branch
                const done = [...progress.done]
                  .reverse()
                  .find((step) => step.branch === affected.branch)
                const problem = done && ['conflict', 'failed', 'diverged'].includes(done.status)
                const conflictWorkspace =
                  done?.status === 'conflict' && done.workspaceId
                    ? workspaces?.find((candidate) => candidate.id === done.workspaceId)
                    : undefined
                return (
                  <div key={affected.branch} className="flex items-center gap-1.5 text-xs">
                    <span className="w-3 shrink-0 grid place-items-center">
                      {current ? (
                        <Loader2 size={11} className="animate-spin text-[var(--warning-300)]" />
                      ) : problem ? (
                        <AlertTriangle size={11} className="text-[var(--warning-400)]" />
                      ) : done?.status === 'ok' ? (
                        <Check size={11} className="text-[var(--success-400)]" />
                      ) : done?.status === 'skipped' ? (
                        <Minus size={11} className="text-neutral-500" />
                      ) : (
                        <span className="text-neutral-600">·</span>
                      )}
                    </span>
                    <span className="font-mono text-neutral-300">{affected.branch}</span>
                    {current && <span className="text-neutral-500">{progress.current?.kind}…</span>}
                    {done && !current && (
                      <span className={problem ? 'text-[var(--warning-300)]' : 'text-neutral-500'}>
                        {done.status}
                      </span>
                    )}
                    {conflictWorkspace && (
                      <ConflictResolveAction
                        workspace={conflictWorkspace}
                        conflictedFileCount={done?.conflictedFiles?.length}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            disabled={busy}
            // 캐스케이드는 PR retarget·reopen 을 거치므로 gh 가 필요하다. 배너는 gh 로 감지한
            // 계획이 workspace 에 남아 있으면(연결이 끊긴 뒤에도) 계속 뜨므로 실행 직전에 요구한다.
            onClick={() => {
              void requireGithub('Syncing a stack retargets its pull requests on GitHub.', () => {
                return applyStackSync(workspace.id)
              })
            }}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--warning-500)]/90 text-black text-xs font-medium hover:bg-[var(--warning-400)] disabled:opacity-60"
            title={`Retarget onto ${plan.newBase}, rebase, and force-push`}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Sync stack
          </button>
          <button
            disabled={busy}
            onClick={() => void dismissStackSync(workspace.id)}
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:opacity-60"
            title="Dismiss — handle this stack manually"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
