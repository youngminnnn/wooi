import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitMerge, Loader2, RefreshCw } from 'lucide-react'
import type { GitStatus, Workspace } from '@shared/types'
import { useStore } from '../store'

export default function BaseSyncControl({
  workspace,
  git,
  prNeedsBaseUpdate,
  refresh
}: {
  workspace: Workspace
  git: GitStatus
  prNeedsBaseUpdate?: boolean
  refresh: () => Promise<void>
}): React.JSX.Element | null {
  const progress = useStore((s) => s.stackProgress[workspace.id])
  const restackWorkspace = useStore((s) => s.restackWorkspace)
  const applyStackSync = useStore((s) => s.applyStackSync)
  const requireGithub = useStore((s) => s.requireGithub)
  const pushToast = useStore((s) => s.pushToast)
  const [menuOpen, setMenuOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [showFinished, setShowFinished] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!progress?.finished) {
      setShowFinished(false)
      return
    }
    setShowFinished(true)
    const timer = setTimeout(() => setShowFinished(false), 1500)
    return () => clearTimeout(timer)
  }, [progress?.finished, progress?.startedAt])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const busy = !!progress && !progress.finished
  if (
    git.behind <= 0 &&
    !prNeedsBaseUpdate &&
    !workspace.stackSync &&
    !busy &&
    !showFinished
  )
    return null

  const doneBranches = new Set(progress?.done.map((step) => step.branch) ?? []).size
  const problems = progress?.done.filter((step) =>
    ['conflict', 'failed', 'diverged'].includes(step.status)
  ).length
  const stackSize = workspace.stack?.length ?? 0
  const baseBranch = workspace.stackSync?.newBase ?? workspace.baseBranch

  let label = workspace.stackSync
    ? 'Sync stack'
    : stackSize > 1
      ? `Rebase stack onto ${baseBranch}`
      : `Rebase onto ${baseBranch}`
  if (busy) {
    const branch = progress.current?.branch
    const count =
      progress.total == null
        ? ''
        : ` (${Math.min(doneBranches + 1, progress.total)}/${progress.total})`
    label = branch ? `Rebasing ${branch}…${count}` : 'Preparing rebase…'
  } else if (showFinished) {
    label = problems
      ? `Finished with ${problems} issue${problems > 1 ? 's' : ''}`
      : progress?.kind === 'sync'
        ? 'Stack sync complete'
        : 'Rebase complete'
  }

  const runPrimary = (): void => {
    void requireGithub(
      workspace.stackSync
        ? 'Syncing a stack retargets its pull requests on GitHub.'
        : 'Restacking updates the branch and its pull request.',
      () => (workspace.stackSync ? applyStackSync(workspace.id) : restackWorkspace(workspace.id))
    )
  }

  const mergeBase = async (): Promise<void> => {
    setMenuOpen(false)
    setMerging(true)
    const result = await window.api.git.updateFromBase(workspace.id)
    setMerging(false)
    if (result.status === 'updated') pushToast('success', `Updated from ${result.baseBranch}.`)
    else if (result.status === 'up-to-date')
      pushToast('info', `Already up to date with ${result.baseBranch}.`)
    else if (result.status === 'conflict')
      pushToast(
        'error',
        `Merge conflicts in ${result.conflictedFiles?.length ?? 0} file(s). Resolve them, or abort the merge.`
      )
    else pushToast('error', result.message ?? 'Failed to update from base.')
    await refresh()
  }

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={runPrimary}
        disabled={busy || merging || showFinished}
        className="h-6 flex items-center gap-1 rounded-l-md border border-[var(--accent-400)]/40 bg-[var(--accent-500)]/15 px-2 text-[11px] text-[var(--accent-200)] hover:bg-[var(--accent-500)]/25 disabled:opacity-60"
        title={label}
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
        {label}
      </button>
      <button
        onClick={() => setMenuOpen((open) => !open)}
        disabled={busy || merging}
        className="h-6 w-5 grid place-items-center rounded-r-md border-y border-r border-[var(--accent-400)]/40 bg-[var(--accent-500)]/15 text-[var(--accent-200)] hover:bg-[var(--accent-500)]/25 disabled:opacity-60"
        title="More base update options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {merging ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
      </button>
      {menuOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-xl">
          {/* rebase 는 force-push 로 히스토리를 다시 쓰므로, 기존 merge 경로도 되돌리기 쉬운 보조
              선택지로 남긴다. 헤더의 1차 액션만 rebase 로 승격한다. */}
          <button
            onClick={() => void mergeBase()}
            className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-[var(--surface-3)] hover:text-neutral-100"
          >
            <GitMerge size={12} />
            {/* main 의 updateFromBase 는 기록된 ws.baseBranch 를 머지하므로, 캐스케이드 대기 중이라
                1차 액션이 newBase 를 가리키더라도 이 줄만은 실제로 머지될 브랜치를 말해야 한다. */}
            Merge {workspace.baseBranch} into this branch
          </button>
        </div>
      )}
    </div>
  )
}
