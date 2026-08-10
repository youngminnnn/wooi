import type { AgentBackendId, ChatItem, RateLimitSnapshot, Workspace } from '@shared/types'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { log } from './logger'

const FALLBACK_WAIT_MS = 5 * 60_000
const RESET_GRACE_MS = 15_000
const MAX_TIMEOUT_MS = 2_147_000_000
const MAX_ATTEMPTS = 5

export const RATE_LIMIT_CONTINUATION =
  'The previous turn stopped because the provider usage limit was reached. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'

interface Deps {
  backend: AgentBackendId
  refreshLimits: () => Promise<void>
  sendContinuation: (workspaceId: string) => void
  emitItem: (workspaceId: string, item: ChatItem) => void
}

/**
 * 백엔드 하나의 사용량 제한 예약을 관리한다. 예약의 정본은 Workspace라 앱 재시작 뒤에도 복원되고,
 * Timer는 프로세스가 살아 있는 동안 그 시각을 깨우는 파생 상태일 뿐이다.
 */
export class RateLimitResumeCoordinator {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private deps: Deps) {}

  restore(): void {
    for (const ws of getStore().getState().workspaces) {
      if (ws.pendingRateLimitResume?.backend === this.deps.backend && !ws.archived) {
        this.arm(ws.id, ws.pendingRateLimitResume.retryAt)
      }
    }
  }

  async schedule(workspaceId: string): Promise<void> {
    const state = getStore().getState()
    const ws = state.workspaces.find((item) => item.id === workspaceId)
    if (!ws || ws.archived || ws.agentBackend !== this.deps.backend || !ws.sessionId) return
    if (!state.settings.autoResumeAfterRateLimit) return

    await this.deps
      .refreshLimits()
      .catch((err) => log.info(`rate-limit resume: usage refresh failed (${String(err)})`))
    const latest = getStore().getState()
    const previous = latest.workspaces.find(
      (item) => item.id === workspaceId
    )?.pendingRateLimitResume
    const retryAt = retryTime(latest.rateLimitsByAgent?.[this.deps.backend], Date.now())
    const attempt = previous?.attempt ?? 0
    getStore().update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)
      if (!target || !target.sessionId) return
      target.status = 'idle'
      target.pendingRateLimitResume = {
        backend: this.deps.backend,
        sessionId: target.sessionId,
        detectedAt: previous?.detectedAt ?? Date.now(),
        retryAt,
        attempt
      }
    })
    this.notice(
      workspaceId,
      `Usage limit reached. Wooi will continue this task ${formatWhen(retryAt)}.`
    )
    this.arm(workspaceId, retryAt)
  }

  cancel(workspaceId: string, announce = false): void {
    const timer = this.timers.get(workspaceId)
    if (timer) clearTimeout(timer)
    this.timers.delete(workspaceId)
    let hadPending = false
    getStore().update((draft) => {
      const ws = draft.workspaces.find((item) => item.id === workspaceId)
      hadPending = Boolean(ws?.pendingRateLimitResume)
      if (ws) ws.pendingRateLimitResume = null
    })
    if (announce && hadPending) this.notice(workspaceId, 'Automatic continuation was cancelled.')
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    getStore().update((draft) => {
      for (const ws of draft.workspaces) {
        if (ws.pendingRateLimitResume?.backend === this.deps.backend)
          ws.pendingRateLimitResume = null
      }
    })
  }

  private arm(workspaceId: string, retryAt: number): void {
    const old = this.timers.get(workspaceId)
    if (old) clearTimeout(old)
    const delay = Math.max(0, Math.min(retryAt - Date.now(), MAX_TIMEOUT_MS))
    this.timers.set(
      workspaceId,
      setTimeout(() => {
        this.timers.delete(workspaceId)
        void this.resume(workspaceId)
      }, delay)
    )
  }

  private async resume(workspaceId: string): Promise<void> {
    const before = this.pendingWorkspace(workspaceId)
    if (!before) return this.cancel(workspaceId)
    if (!getStore().getState().settings.autoResumeAfterRateLimit) return this.cancel(workspaceId)
    if (before.pendingRateLimitResume!.retryAt - Date.now() > 1_000) {
      this.arm(workspaceId, before.pendingRateLimitResume!.retryAt)
      return
    }

    const previousFetchedAt =
      getStore().getState().rateLimitsByAgent?.[this.deps.backend]?.fetchedAt
    await this.deps.refreshLimits().catch(() => {})
    const current = this.pendingWorkspace(workspaceId)
    if (!current) return
    const pending = current.pendingRateLimitResume!
    const snapshot = getStore().getState().rateLimitsByAgent?.[this.deps.backend]
    // 제한 해제 시각에는 반드시 새 usage 응답을 확인한다. 네트워크 실패로 오래된 스냅샷만 남은
    // 상태에서 작업을 보내면 즉시 또 실패하므로, 확인 자체가 안 됐으면 짧게 재예약한다.
    if (!snapshot || snapshot.fetchedAt === previousFetchedAt) {
      const next = Date.now() + FALLBACK_WAIT_MS + RESET_GRACE_MS
      if (pending.attempt + 1 >= MAX_ATTEMPTS) {
        this.cancel(workspaceId)
        this.notice(
          workspaceId,
          'Wooi could not confirm that the usage limit reset, so automatic continuation stopped.'
        )
        return
      }
      getStore().update((draft) => {
        const ws = draft.workspaces.find((item) => item.id === workspaceId)
        if (ws?.pendingRateLimitResume) {
          ws.pendingRateLimitResume.retryAt = next
          ws.pendingRateLimitResume.attempt += 1
        }
      })
      this.arm(workspaceId, next)
      return
    }
    const next = retryTime(snapshot, Date.now())
    const stillLimited = exhaustedResetTimes(snapshot, Date.now()).length > 0
    if (stillLimited) {
      if (pending.attempt + 1 >= MAX_ATTEMPTS) {
        this.cancel(workspaceId)
        this.notice(
          workspaceId,
          'The usage limit is still active, so automatic continuation stopped.'
        )
        return
      }
      getStore().update((draft) => {
        const ws = draft.workspaces.find((item) => item.id === workspaceId)
        if (ws?.pendingRateLimitResume) {
          ws.pendingRateLimitResume.retryAt = next
          ws.pendingRateLimitResume.attempt += 1
        }
      })
      this.notice(
        workspaceId,
        `The usage limit is still active. Wooi will check again ${formatWhen(next)}.`
      )
      this.arm(workspaceId, next)
      return
    }

    // 예약 당시의 세션이 그대로일 때만 이어 간다. /clear·계정 전환 등으로 바뀌었다면 과거 작업을
    // 새 맥락에 주입하지 않는다.
    if (current.sessionId !== pending.sessionId) return this.cancel(workspaceId)
    this.cancel(workspaceId)
    this.notice(workspaceId, 'Usage limit reset. Continuing the unfinished task…')
    this.deps.sendContinuation(workspaceId)
  }

  private pendingWorkspace(workspaceId: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find(
        (ws) =>
          ws.id === workspaceId &&
          !ws.archived &&
          ws.agentBackend === this.deps.backend &&
          ws.pendingRateLimitResume?.backend === this.deps.backend
      )
  }

  private notice(workspaceId: string, text: string): void {
    const item: ChatItem = {
      id: `system:rate-limit-resume:${Date.now()}`,
      type: 'system',
      text,
      ts: Date.now()
    }
    getTranscripts().upsert(workspaceId, item)
    this.deps.emitItem(workspaceId, item)
  }
}

export function exhaustedResetTimes(
  snapshot: RateLimitSnapshot | undefined,
  now: number
): number[] {
  if (!snapshot?.available) return []
  return snapshot.windows
    .filter((window) => (window.utilization ?? 0) >= 100)
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((at) => Number.isFinite(at) && at > now)
}

export function retryTime(snapshot: RateLimitSnapshot | undefined, now: number): number {
  const resets = exhaustedResetTimes(snapshot, now)
  return (resets.length ? Math.max(...resets) : now + FALLBACK_WAIT_MS) + RESET_GRACE_MS
}

function formatWhen(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}
