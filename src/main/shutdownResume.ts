import type { AgentBackendId, ChatItem, Workspace } from '@shared/types'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { formatWhen } from './rateLimitResume'
import { takeUnrequestedTurn } from './resumeBudget'

export const SHUTDOWN_RESUME_GRACE_MS = 24 * 60 * 60 * 1000
export const SHUTDOWN_CONTINUATION =
  'The previous turn stopped because Wooi shut down. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'

interface Deps {
  backend: AgentBackendId
  sendContinuation: (workspaceId: string, text: string) => void
  emitItem: (workspaceId: string, item: ChatItem) => void
  broadcastState: () => void
}

export class ShutdownResumeCoordinator {
  constructor(private deps: Deps) {}

  restore(): void {
    const state = getStore().getState()
    if (!state.settings.resumeUnfinishedTurnsOnLaunch) {
      this.cancelAll()
      return
    }
    const now = Date.now()
    const mine = state.workspaces
      .filter((ws) => ws.pendingShutdownResume?.backend === this.deps.backend && !ws.archived)
      .sort((a, b) => b.pendingShutdownResume!.at - a.pendingShutdownResume!.at)

    for (const ws of mine) {
      const pending = ws.pendingShutdownResume!
      if (now - pending.at > SHUTDOWN_RESUME_GRACE_MS) {
        this.drop(
          ws.id,
          `Wooi shut down while this task was running (${formatWhen(pending.at)}), and too much time has passed to continue it automatically. Send a message to pick it up.`
        )
        continue
      }
      if (pending.reason === 'crash' && !takeUnrequestedTurn()) {
        this.drop(
          ws.id,
          'Wooi stopped unexpectedly while this task was running. It was not continued automatically because Wooi only starts one unrequested turn per launch. Send a message to pick it up.'
        )
        continue
      }
      this.continueNow(ws.id, pending)
    }
  }

  cancel(workspaceId: string): void {
    this.clearPending(workspaceId)
  }

  cancelAll(): void {
    let hadPending = false
    getStore().update((draft) => {
      for (const ws of draft.workspaces) {
        if (ws.pendingShutdownResume?.backend !== this.deps.backend) continue
        hadPending = true
        ws.pendingShutdownResume = null
      }
    })
    if (hadPending) this.deps.broadcastState()
  }

  clearPending(workspaceId: string): boolean {
    let hadPending = false
    getStore().update((draft) => {
      const ws = draft.workspaces.find((item) => item.id === workspaceId)
      hadPending = Boolean(ws?.pendingShutdownResume)
      if (ws) ws.pendingShutdownResume = null
    })
    if (hadPending) this.deps.broadcastState()
    return hadPending
  }

  private drop(workspaceId: string, text: string): void {
    if (this.clearPending(workspaceId)) this.notice(workspaceId, text)
  }

  private continueNow(
    workspaceId: string,
    pending: NonNullable<Workspace['pendingShutdownResume']>
  ): void {
    const current = getStore()
      .getState()
      .workspaces.find((ws) => ws.id === workspaceId)
    if (!current || current.sessionId !== pending.sessionId) {
      this.cancel(workspaceId)
      return
    }
    this.clearPending(workspaceId)
    this.notice(workspaceId, 'Wooi restarted. Continuing the unfinished task…')
    this.deps.sendContinuation(workspaceId, SHUTDOWN_CONTINUATION)
  }

  private notice(workspaceId: string, text: string): void {
    const item: ChatItem = {
      id: `system:shutdown-resume:${Date.now()}`,
      type: 'system',
      text,
      ts: Date.now()
    }
    getTranscripts().upsert(workspaceId, item)
    this.deps.emitItem(workspaceId, item)
  }
}

export function captureRunningTurns(
  reason: NonNullable<Workspace['pendingShutdownResume']>['reason']
): void {
  const at = Date.now()
  getStore().update((draft) => {
    for (const ws of draft.workspaces) {
      if (ws.archived || ws.status !== 'running' || !ws.sessionId) continue
      ws.pendingShutdownResume = {
        backend: ws.agentBackend,
        sessionId: ws.sessionId,
        at,
        reason
      }
      ws.status = 'idle'
    }
  })
}
