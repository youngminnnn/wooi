import React, { useState } from 'react'
import { GitMerge, Loader2, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'

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
  const [busy, setBusy] = useState(false)

  const plan = workspace.stackSync
  if (!plan) return null

  const closed = plan.affected.filter((a) => a.prClosed)
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
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void applyStackSync(workspace.id).finally(() => setBusy(false))
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
