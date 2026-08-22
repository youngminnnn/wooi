import { useCallback, useEffect, useRef, useState } from 'react'
import { GitCommitVertical } from 'lucide-react'
import type { CommitEntry } from '@shared/types'
import { agoLabel } from '../lib/rateLimit'
import { useNow } from '../lib/useNow'
import { useStore } from '../store'
import { PanelToolbar } from './ChangesPanel'
import CommitMoveModal from './CommitMoveModal'

export default function CommitsPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CommitEntry | null>(null)
  const mounted = useRef(true)
  const now = useNow(60_000)
  const ahead = useStore((s) => s.gitStatus[workspaceId]?.ahead ?? 0)
  const workspace = useStore((s) => s.app?.workspaces.find((w) => w.id === workspaceId))
  const parent = useStore((s) =>
    s.app?.workspaces.find(
      (w) => w.id === workspace?.parentWorkspaceId && !w.archived && w.repoId === workspace?.repoId
    )
  )
  const modelB = !!workspace?.stack && workspace.stack.length > 1

  const load = useCallback(
    async (alive: () => boolean) => {
      setLoading(true)
      setError(null)
      try {
        const next = await window.api.stack.commitsList(workspaceId)
        if (alive()) setCommits(next)
      } catch (err) {
        if (alive()) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive()) setLoading(false)
      }
    },
    [workspaceId]
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void load(() => alive)
    return () => {
      alive = false
    }
  }, [load, ahead])

  const refresh = (): void => {
    void load(() => mounted.current)
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar label="Commits in this layer" onRefresh={refresh} spinning={loading} />
      {modelB && (
        <div className="mx-3 mt-3 rounded-lg border border-[var(--warning-400)]/40 bg-[var(--warning-400)]/10 px-3 py-2 text-xs text-[var(--warning-300)]">
          Moving commits is not supported yet for stacks that keep several branches in one
          workspace.
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          <div className="text-sm text-[var(--danger-400)]">{error}</div>
        ) : !loading && commits.length === 0 ? (
          <div className="h-full grid place-items-center text-sm text-neutral-500">
            No commits in this layer.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {commits.map((commit) => (
              <div key={commit.sha} className="group flex items-start gap-3 py-3">
                <GitCommitVertical size={14} className="mt-0.5 shrink-0 text-neutral-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-[var(--info-400)]">
                      {commit.shortSha}
                    </span>
                    <span className="truncate text-sm text-neutral-200">{commit.subject}</span>
                  </div>
                  <div className="mt-1 flex gap-2 text-xs text-neutral-500">
                    <span className="truncate">{commit.authorName}</span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0" title={new Date(commit.authoredAt).toLocaleString()}>
                      {agoLabel(now - commit.authoredAt)}
                    </span>
                  </div>
                </div>
                {!modelB && (
                  <button
                    disabled={!parent}
                    onClick={() => setSelected(commit)}
                    title={parent ? `Move into ${parent.branch}` : 'There is no layer below'}
                    className="shrink-0 rounded-md border border-[var(--border-2)] px-2 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
                  >
                    Move down
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <CommitMoveModal
          workspaceId={workspaceId}
          commit={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
