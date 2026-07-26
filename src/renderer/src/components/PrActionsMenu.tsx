import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestArrow,
  CircleCheck,
  ExternalLink,
  Loader2
} from 'lucide-react'
import { useStore } from '../store'
import { cascadeAffectedBranches } from '@shared/types'
import type { PrMergeMethod, PrStatus } from '@shared/types'

/**
 * PR 라이프사이클 액션 메뉴(merge / close / reopen / ready-for-review).
 * 헤더의 PR 배지 옆 캐럿으로 열리며, 현재 PR 상태에 따라 가능한 동작만 노출한다.
 * 모든 동작은 gh CLI 를 거쳐 실행되고, 끝나면 PR 상태를 새로고침한다.
 */
export default function PrActionsMenu({
  workspaceId,
  pr
}: {
  workspaceId: string
  pr: PrStatus
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const refreshPr = useStore((s) => s.refreshPr)
  const refreshGit = useStore((s) => s.refreshGit)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)
  const workspaces = useStore((s) => s.app?.workspaces)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // gh 액션 1개를 실행하고 결과를 토스트로 알린 뒤 상태를 새로고침한다.
  const run = async (
    label: string,
    fn: () => Promise<{ error?: string }>,
    successMsg: string
  ): Promise<void> => {
    setBusy(true)
    const res = await fn().catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
    setBusy(false)
    setOpen(false)
    if (res.error) pushToast('error', `${label} failed: ${res.error}`)
    else pushToast('success', successMsg)
    await Promise.all([refreshPr(workspaceId), refreshGit(workspaceId)])
  }

  const merge = async (method: PrMergeMethod): Promise<void> => {
    const how =
      method === 'squash'
        ? 'Squashes all commits into one and merges into the base branch.'
        : method === 'rebase'
          ? 'Rebases the commits onto the base branch and merges.'
          : 'Creates a merge commit on the base branch.'

    // 스택이 걸려 있으면 병합 뒤 할 일이 남는다는 것만 알린다. 실제 리타겟·rebase·force-push 는
    // 병합에 딸려 나가지 않고, 병합 후 뜨는 배너에서 따로 승인받는다(GitHub 웹에서 병합했을 때와 동일).
    const ws = workspaces?.find((w) => w.id === workspaceId)
    const affected = ws && workspaces ? cascadeAffectedBranches(ws, workspaces) : []
    const note = affected.length
      ? `\n\n${affected.length} stacked branch(es) sit on top of this one. ` +
        `After merging, wooi will offer to retarget and rebase them.`
      : ''

    const ok = await confirm({
      title: `Merge pull request #${pr.number}?`,
      body: how + note,
      confirmLabel: 'Merge'
    })
    if (!ok) return
    await run('Merge', () => window.api.pr.merge(workspaceId, method), `Merged #${pr.number}.`)
  }

  const closePr = async (): Promise<void> => {
    const ok = await confirm({
      title: `Close pull request #${pr.number}?`,
      body: 'Closes the PR without merging. You can reopen it later.',
      confirmLabel: 'Close PR',
      danger: true
    })
    if (!ok) return
    await run('Close', () => window.api.pr.close(workspaceId), `Closed #${pr.number}.`)
  }

  const isMerged = pr.state === 'merged'
  const isClosed = pr.state === 'closed'
  const isDraft = pr.state === 'draft'
  const isConflict = pr.state === 'conflict'
  // 종결(merged) 상태에서는 배지 링크만 의미가 있으므로 액션 메뉴를 숨긴다.
  if (isMerged) return <></>

  // Draft 는 GitHub 이 병합을 거부하고, conflict 는 병합할 수 없다 — 두 경우 merge 를 막고 이유를 알린다.
  const mergeDisabled = isConflict || isDraft
  const mergeTitle = isDraft
    ? 'Mark the PR ready for review before merging'
    : isConflict
      ? 'Resolve merge conflicts before merging'
      : undefined

  const itemCls =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Pull request #${pr.number} actions`}
        className="ml-0.5 grid h-6 w-6 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-neutral-300 hover:border-[var(--border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--accent-500)]"
        title="Pull request actions"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-xl"
        >
          {isClosed ? (
            <button
              role="menuitem"
              className={itemCls}
              onClick={() =>
                void run(
                  'Reopen',
                  () => window.api.pr.reopen(workspaceId),
                  `Reopened #${pr.number}.`
                )
              }
            >
              <GitPullRequestArrow size={13} className="text-[var(--accent-400)]" />
              Reopen pull request
            </button>
          ) : (
            <>
              {isDraft && (
                <button
                  role="menuitem"
                  className={itemCls}
                  onClick={() =>
                    void run(
                      'Mark ready',
                      () => window.api.pr.ready(workspaceId),
                      `#${pr.number} marked ready for review.`
                    )
                  }
                >
                  <CircleCheck size={13} className="text-[var(--success-400)]" />
                  Mark ready for review
                </button>
              )}
              <button
                role="menuitem"
                className={itemCls}
                disabled={mergeDisabled}
                title={mergeTitle}
                onClick={() => void merge('squash')}
              >
                <GitMerge size={13} className="text-purple-400" />
                Squash &amp; merge
              </button>
              <button
                role="menuitem"
                className={itemCls}
                disabled={mergeDisabled}
                title={mergeTitle}
                onClick={() => void merge('merge')}
              >
                <GitMerge size={13} className="text-purple-400" />
                Create a merge commit
              </button>
              <button
                role="menuitem"
                className={itemCls}
                disabled={mergeDisabled}
                title={mergeTitle}
                onClick={() => void merge('rebase')}
              >
                <GitMerge size={13} className="text-purple-400" />
                Rebase &amp; merge
              </button>
              <div className="my-1 border-t border-[var(--border)]" />
              <button role="menuitem" className={itemCls} onClick={() => void closePr()}>
                <GitPullRequestClosed size={13} className="text-neutral-400" />
                Close pull request
              </button>
            </>
          )}
          <div className="my-1 border-t border-[var(--border)]" />
          <button
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setOpen(false)
              void window.api.openExternal(pr.url)
            }}
          >
            <ExternalLink size={13} className="text-neutral-400" />
            Open in browser
          </button>
        </div>
      )}
    </div>
  )
}
