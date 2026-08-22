import { useState } from 'react'
import type { Workspace } from '@shared/types'
import { effortLabel, modelLabel } from '@shared/agentLabels'
import { useAgentSettings, useModels, useWorkspaceBackend } from '../lib/backends'
import { useStore } from '../store'

export default function ConflictResolveAction({
  workspace,
  conflictedFileCount
}: {
  workspace: Workspace
  conflictedFileCount?: number
}): React.JSX.Element {
  const [starting, setStarting] = useState(false)
  const pushToast = useStore((s) => s.pushToast)
  const models = useModels(workspace.agentBackend)
  const backend = useWorkspaceBackend(workspace)
  const defaults = useAgentSettings(workspace.agentBackend)
  const model = modelLabel(models, workspace.model ?? workspace.lastModel ?? defaults.model)
  const effort = effortLabel(backend, workspace.effort ?? defaults.effort)
  const fileCost =
    conflictedFileCount == null
      ? ''
      : `, ${conflictedFileCount} conflicted file${conflictedFileCount === 1 ? '' : 's'}`

  const resolve = async (): Promise<void> => {
    setStarting(true)
    try {
      const result = await window.api.stack.resolveConflict(workspace.id)
      if (result.error) pushToast('error', result.error)
      else pushToast('info', 'Asked the agent to resolve the rebase conflict.')
    } catch (error) {
      pushToast(
        'error',
        error instanceof Error ? error.message : 'Could not start conflict resolution.'
      )
    } finally {
      setStarting(false)
    }
  }

  return (
    <button
      onClick={() => void resolve()}
      disabled={starting}
      className="text-neutral-500 hover:text-neutral-200 underline decoration-dotted disabled:cursor-wait disabled:opacity-60"
      title={`Starts one agent turn using ${model} · ${effort}${fileCost}`}
    >
      {starting ? 'starting…' : 'resolve with agent'}
    </button>
  )
}
