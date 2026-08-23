import React, { useState } from 'react'
import { Clock, Loader2 } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import { useStore } from '../store'
import { useNow } from '../lib/useNow'
import { formatCountdown } from '../lib/format'

export default function StackedWaitBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const workspaces = useStore((state) => state.app?.workspaces ?? [])
  const now = useNow(1000, Boolean(workspace.awaitingStackedWork))
  const pending = workspace.awaitingStackedWork
  if (!pending) return null

  const names = pending.targets.map((target) => {
    const child = workspaces.find((item) => item.id === target.workspaceId)
    return child ? workspaceDisplayName(child) : target.workspaceId
  })

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.workspace.cancelStackedWait(workspace.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-center gap-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5">
        <Clock size={14} className="shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-300">
          Waiting for {pending.until === 'all-reported' ? 'all' : 'any'} of{' '}
          <span className="text-neutral-200">{names.join(', ')}</span>
          <span className="text-neutral-500">
            {' '}
            · {formatCountdown(pending.deadlineAt - now)} left
          </span>
        </div>
        <button
          disabled={busy}
          onClick={() => void stop()}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-xs font-medium text-neutral-200 hover:border-neutral-500 disabled:opacity-60"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          Stop waiting
        </button>
      </div>
    </div>
  )
}
