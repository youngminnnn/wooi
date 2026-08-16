import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitMerge, Loader2, RefreshCw } from 'lucide-react'
import type { GitStatus, PrState, Workspace } from '@shared/types'
import { useStore } from '../store'
import HeaderChip from './HeaderChip'
import MenuPanel, { menuItemCls } from './MenuPanel'

/** 뒤처지지 않았을 때의 톤 — 자리는 지키되 행동을 재촉하지 않는다. */
const IDLE_TONE =
  'bg-[var(--surface)] border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'

export default function BaseSyncControl({
  workspace,
  git,
  prState,
  prNeedsBaseUpdate,
  refresh
}: {
  workspace: Workspace
  git: GitStatus
  prState?: PrState
  prNeedsBaseUpdate?: boolean
  refresh: () => Promise<void>
}): React.JSX.Element | null {
  const progress = useStore((s) => s.stackProgress[workspace.id])
  const restackWorkspace = useStore((s) => s.restackWorkspace)
  const requireGithub = useStore((s) => s.requireGithub)
  const pushToast = useStore((s) => s.pushToast)
  const [menuOpen, setMenuOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [hiddenFinishedAt, setHiddenFinishedAt] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!progress?.finished) return
    const timer = setTimeout(() => setHiddenFinishedAt(progress.startedAt), 1500)
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
  const showFinished = !!progress?.finished && hiddenFinishedAt !== progress.startedAt
  // 병합된 PR 의 브랜치는 main 보다 뒤처져 있는 것이 정상이다. 이 값을 일반 rebase 신호로
  // 취급하면 병합 직후에도 "Rebase onto main" 이 남는다. stackSync 계획이 있는 동안은 승인과
  // 진행 표시를 배너 한 곳이 맡고, 계획이 정리된 뒤 남는 progress 의 완료 표시는 여기서 이어받는다.
  if (git.conflicted || workspace.stackSync || (prState === 'merged' && !busy && !showFinished))
    return null

  const doneBranches = new Set(progress?.done.map((step) => step.branch) ?? []).size
  const problems = progress?.done.filter((step) =>
    ['conflict', 'failed', 'diverged'].includes(step.status)
  ).length
  const stackSize = workspace.stack?.length ?? 0
  const baseBranch = workspace.baseBranch
  const upToDate = git.behind <= 0 && !prNeedsBaseUpdate && !busy && !showFinished

  let label = stackSize > 1 ? 'Rebase stack' : 'Rebase'
  let tooltip = upToDate
    ? `Up to date with ${baseBranch}`
    : stackSize > 1
      ? `Rebase stack onto ${baseBranch}`
      : `Rebase onto ${baseBranch}`
  if (busy) {
    const branch = progress.current?.branch
    const count =
      progress.total == null
        ? ''
        : ` (${Math.min(doneBranches + 1, progress.total)}/${progress.total})`
    label = branch ? `Rebasing…${count}` : 'Preparing rebase…'
    tooltip = branch ? `Rebasing ${branch}…${count}` : 'Preparing rebase…'
  } else if (showFinished) {
    label = problems
      ? `Finished with ${problems} issue${problems > 1 ? 's' : ''}`
      : progress?.kind === 'sync'
        ? 'Stack sync complete'
        : 'Rebase complete'
    tooltip = label
  }

  const runPrimary = (): void => {
    void requireGithub('Restacking updates the branch and its pull request.', () =>
      restackWorkspace(workspace.id)
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
      <HeaderChip
        variant="joined-left"
        onClick={runPrimary}
        // rebase 가 필요 없어도 restackOnto 는 기존 리모트 브랜치를 force-push 하므로 idle 클릭은 막는다.
        // 판정은 upToDate 하나로 모은다 — behind 만 보면 PR 이 base 갱신을 요구하는 경우(#317)를
        // 놓쳐, 툴팁은 "Rebase onto main" 인데 버튼은 눌리지 않는 상태가 된다.
        disabled={busy || merging || showFinished || upToDate}
        toneClass={upToDate ? IDLE_TONE : undefined}
        className="tabular-nums"
        title={tooltip}
      >
        {busy ? (
          <Loader2 size={10} className="animate-spin text-[var(--accent-400)]" />
        ) : (
          <RefreshCw size={10} className="text-[var(--accent-400)]" />
        )}
        {label}
      </HeaderChip>
      <HeaderChip
        variant="joined-right"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={busy || merging}
        toneClass={upToDate ? IDLE_TONE : undefined}
        title="More base update options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {merging ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
      </HeaderChip>
      {menuOpen && (
        <MenuPanel className="absolute left-0 top-full z-50 mt-1 min-w-56">
          {/* rebase 는 force-push 로 히스토리를 다시 쓰므로, 기존 merge 경로도 되돌리기 쉬운 보조
              선택지로 남긴다. 헤더의 1차 액션만 rebase 로 승격한다. */}
          <button onClick={() => void mergeBase()} className={menuItemCls}>
            <GitMerge size={12} />
            {/* main 의 updateFromBase 는 기록된 ws.baseBranch 를 머지하므로, 캐스케이드 대기 중이라
                1차 액션이 newBase 를 가리키더라도 이 줄만은 실제로 머지될 브랜치를 말해야 한다. */}
            Merge {workspace.baseBranch} into this branch
          </button>
        </MenuPanel>
      )}
    </div>
  )
}
