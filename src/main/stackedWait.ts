import type { ChatItem, PendingStackedWait, Workspace } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'
import { stackedChildProgress, type StackedProgressReason } from './stackedProgress'

const TICK_MS = 15_000
const DEFAULT_TIMEOUT_MIN = 60
const MIN_TIMEOUT_MIN = 1
const MAX_TIMEOUT_MIN = 24 * 60
const IDLE_GRACE_MS = 90_000
const APPROVAL_GRACE_MS = 5 * 60_000

interface Deps {
  sendMessage: (workspaceId: string, text: string) => void
  postToTranscript: (workspaceId: string, item: ChatItem) => void
  broadcastState: () => void
  now?: () => number
}

export interface RegisterRequest {
  workspaceIds?: string[]
  until?: PendingStackedWait['until']
  timeoutMinutes?: number
}

interface ChildResult {
  workspaceId: string
  name: string
  branch: string
  reported: boolean
  status?: 'done' | 'blocked'
  summary?: string
}

export type RegisterResult =
  | {
      waiting: false
      satisfied: true
      until: PendingStackedWait['until']
      reports: ChildResult[]
      note: string
    }
  | {
      waiting: true
      until: PendingStackedWait['until']
      children: ChildResult[]
      wakesBy: string
      next: string
    }

type WakeReason = 'condition-met' | 'stalled' | 'timeout'

/**
 * 기한을 언제나 유효한 범위 안으로 가둔다.
 *
 * 카탈로그의 zod 스키마가 같은 범위를 광고하지만 그것만 믿을 수 없다 — 검증은 Claude 인프로세스
 * 서버에만 붙어 있고, Codex shim 은 스키마를 광고만 한 뒤 인자를 그대로 넘긴다([[agent/tools/registry]]
 * 의 runAgentTool 은 검증하지 않는다). 거르지 않으면 NaN 이 그대로 deadlineAt 이 되고,
 * `now >= NaN` 은 영원히 거짓이라 **타임아웃으로 빠져나가는 길이 통째로 사라진다.**
 */
export function timeoutMinutes(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MIN
  return Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, Math.round(requested)))
}

/**
 * 대기의 정본은 Workspace 에 두고, 틱과 스톨 유예만 메모리에 둔다. 앱 재시작 뒤에도 예약은
 * 살아나되 순간적인 idle 을 확정된 정지로 오해하지 않게 유예는 다시 재는 구조다.
 */
export class StackedWaitCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null
  private stalledSince = new Map<string, { reason: StackedProgressReason; at: number }>()
  private unproductive = new Map<string, number>()

  constructor(private deps: Deps) {}

  restore(): void {
    this.ensureTimer()
    this.evaluateAll()
  }

  register(parentId: string, req: RegisterRequest): RegisterResult {
    if ((this.unproductive.get(parentId) ?? 0) >= 2) {
      throw new Error(
        'Waiting here has produced nothing twice in a row — the stacked workspaces did not report. ' +
          'Do not wait again. Tell the user what is stuck and what you need from them.'
      )
    }

    const state = getStore().getState()
    const parent = state.workspaces.find((w) => w.id === parentId)
    const direct = state.workspaces.filter((w) => w.parentWorkspaceId === parentId && !w.archived)
    if (!direct.length) {
      throw new Error('Nothing is stacked on this workspace yet, so there is nothing to wait for.')
    }
    const requested = req.workspaceIds
      ? req.workspaceIds.map((id) => direct.find((w) => w.id === id))
      : direct
    const invalid = req.workspaceIds?.filter((_id, i) => !requested[i]) ?? []
    if (invalid.length) {
      throw new Error(
        `${invalid.join(', ')} ${invalid.length === 1 ? 'is not a direct child' : 'are not direct children'} ` +
          'of this workspace. Call `check_stacked_work` for the current list.'
      )
    }
    const children = requested as Workspace[]
    const until = req.until ?? 'all-reported'
    const now = this.now()
    const results = children.map((child) => this.childResult(child, Boolean(child.handoff)))
    if (this.conditionMet(until, results)) {
      return {
        waiting: false,
        satisfied: true,
        until,
        reports: results,
        note:
          'These reports were already here before you called — nothing new arrived. Act on them now. ' +
          'Do not call this tool again for the same children; if you need a fresh report from one, ' +
          'use `notify_child` and wait on the children that have not reported yet.'
      }
    }
    const deadlineAt = now + timeoutMinutes(req.timeoutMinutes) * 60_000
    const record: PendingStackedWait = {
      targets: children.map((child) => ({
        workspaceId: child.id,
        seenReportAt: child.handoff?.at ?? null
      })),
      until,
      startedAt: now,
      deadlineAt,
      sessionId: parent?.sessionId ?? null
    }
    getStore().update((draft) => {
      const target = draft.workspaces.find((w) => w.id === parentId)
      if (target) target.awaitingStackedWork = record
    })
    this.deps.broadcastState()
    this.notice(
      parentId,
      `Waiting for ${children.length} stacked ${children.length === 1 ? 'workspace' : 'workspaces'} to report. ` +
        `Wooi will continue here when they do, or by ${this.time(deadlineAt)}.`
    )
    this.ensureTimer()
    return {
      waiting: true,
      until,
      children: results,
      wakesBy: new Date(deadlineAt).toISOString(),
      next:
        "Wooi will start a new turn here the moment the condition is met, with the children's reports " +
        'included — you do not need to check again, and polling `check_stacked_work` in a loop is exactly ' +
        'what this tool replaces. So end this turn now in a line or two: say what you handed out and ' +
        'what you are waiting for. Do not ask the user to reply — the next turn starts by itself.'
    }
  }

  poke(parentId: string): void {
    this.evaluate(parentId)
  }

  cancel(parentId: string, announce = false): void {
    const had = this.clear(parentId)
    this.clearStallState(parentId)
    if (announce && had) this.notice(parentId, 'Stopped waiting for stacked work.')
  }

  cancelAll(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stalledSince.clear()
    this.unproductive.clear()
    getStore().update((draft) => {
      for (const ws of draft.workspaces) ws.awaitingStackedWork = null
    })
    this.deps.broadcastState()
  }

  resetUnproductive(parentId: string): void {
    this.unproductive.delete(parentId)
  }

  private evaluateAll(): void {
    for (const ws of getStore().getState().workspaces) {
      if (ws.awaitingStackedWork) this.evaluate(ws.id)
    }
    this.ensureTimer()
  }

  private evaluate(parentId: string): void {
    const state = getStore().getState()
    const parent = state.workspaces.find((w) => w.id === parentId)
    const record = parent?.awaitingStackedWork
    if (!record) return
    if (!parent || parent.archived) return void this.cancel(parentId)

    const children = record.targets
      .map((target) => state.workspaces.find((w) => w.id === target.workspaceId))
      .filter((child): child is Workspace => Boolean(child))
    const results = record.targets.map((target) => {
      const child = children.find((item) => item.id === target.workspaceId)
      return child
        ? this.childResult(
            child,
            target.seenReportAt !== null || Boolean(child.handoff && child.handoff.at > 0)
          )
        : {
            workspaceId: target.workspaceId,
            name: target.workspaceId,
            branch: 'missing',
            reported: false
          }
    })
    const now = this.now()
    let reason: WakeReason | null = null
    if (this.conditionMet(record.until, results)) reason = 'condition-met'
    else if (now >= record.deadlineAt) reason = 'timeout'
    else if (this.allRemainingStalled(parentId, children, results, now)) reason = 'stalled'
    if (!reason || parent.status === 'running') return
    if (parent.sessionId !== record.sessionId) return void this.cancel(parentId)

    // 전송보다 예약 삭제가 먼저다. sendMessage 가 재진입하거나 던져도 깨움은 최대 한 번이어야 한다.
    this.clear(parentId)
    this.clearStallState(parentId)
    this.unproductive.set(
      parentId,
      reason === 'condition-met' ? 0 : (this.unproductive.get(parentId) ?? 0) + 1
    )
    const count = results.filter((r) => r.reported).length
    this.notice(
      parentId,
      reason === 'condition-met'
        ? `${count} stacked ${count === 1 ? 'workspace reported' : 'workspaces reported'}. Continuing…`
        : reason === 'timeout'
          ? 'The stacked-work wait timed out. Continuing…'
          : 'The remaining stacked workspaces cannot make progress. Continuing…'
    )
    try {
      this.deps.sendMessage(parentId, this.wakeText(reason, record, children, results))
    } catch (err) {
      log.error('stacked wait: failed to wake workspace', parentId, err)
    }
  }

  private allRemainingStalled(
    parentId: string,
    children: Workspace[],
    results: ChildResult[],
    now: number
  ): boolean {
    const remaining = children.filter(
      (child) => !results.find((result) => result.workspaceId === child.id)?.reported
    )
    if (!remaining.length) return false
    // every 로 바로 순회하면 첫 false 에서 멈춰 뒤 자식의 유예 시계가 늦게 시작한다. 전부 판정한
    // 뒤 합쳐야 "모두 같은 90초를 멈춰 있었다" 는 실제 상태와 깨움 시각이 맞는다.
    const stalled = remaining.map((child) => {
      const progress = stackedChildProgress(child, now)
      const key = `${parentId}:${child.id}`
      if (progress.canProgress) {
        this.stalledSince.delete(key)
        return false
      }
      const previous = this.stalledSince.get(key)
      if (!previous || previous.reason !== progress.reason) {
        this.stalledSince.set(key, { reason: progress.reason, at: now })
        return progress.reason === 'archived'
      }
      const grace =
        progress.reason === 'archived'
          ? 0
          : progress.reason === 'waiting-for-user-permission'
            ? APPROVAL_GRACE_MS
            : IDLE_GRACE_MS
      return now - previous.at >= grace
    })
    return stalled.every(Boolean)
  }

  private wakeText(
    reason: WakeReason,
    record: PendingStackedWait,
    children: Workspace[],
    results: ChildResult[]
  ): string {
    const heading =
      reason === 'condition-met'
        ? 'Wooi woke this workspace: the stacked work you were waiting for is done.'
        : reason === 'timeout'
          ? 'Wooi woke this workspace: the stacked-work wait timed out.'
          : 'Wooi woke this workspace: the remaining stacked work cannot make progress.'
    const minutes = Math.max(1, Math.round((record.deadlineAt - record.startedAt) / 60_000))
    const detail =
      reason === 'condition-met'
        ? `Waiting for: ${record.until === 'all-reported' ? 'all' : 'any'} of ${results.length} stacked workspaces to report.`
        : reason === 'timeout'
          ? `Timed out after ${minutes}m — not everything reported.`
          : 'None of the remaining workspaces can make progress right now.'
    const shown = results.slice(0, results.length > 5 ? 4 : 5).map((result) => {
      const child = children.find((item) => item.id === result.workspaceId)
      if (result.reported)
        return `- ${result.name} (${result.branch}): ${result.status} — ${(result.summary ?? '').slice(0, 600)}`
      if (!child) return `- ${result.name}: missing, no report`
      const progress = stackedChildProgress(child, this.now())
      const label: Record<StackedProgressReason, string> = {
        running: 'still running',
        resuming: 'waiting to resume',
        archived: 'archived',
        'waiting-for-user-permission': 'waiting for your approval',
        'rate-limited': 'rate limited, no report',
        'ended-with-error': 'error, no report',
        'background-tasks-running': 'idle, background shells still running',
        idle: 'idle, no report'
      }
      return `- ${result.name} (${result.branch}): ${label[progress.reason]}`
    })
    if (results.length > shown.length)
      shown.push(`- ${results.length - shown.length} more workspaces omitted.`)
    const ending =
      reason === 'condition-met'
        ? 'Wooi started this turn, not the user. Continue what was waiting on these results.'
        : 'Wooi started this turn, not the user. Tell the user what is stuck and ask how to proceed.'
    return [heading, '', detail, ...shown, '', ending].join('\n').slice(0, 4000)
  }

  private childResult(child: Workspace, reported: boolean): ChildResult {
    return {
      workspaceId: child.id,
      name: workspaceDisplayName(child),
      branch: child.branch,
      reported,
      ...(reported && child.handoff
        ? { status: child.handoff.status, summary: child.handoff.summary }
        : {})
    }
  }

  private conditionMet(until: PendingStackedWait['until'], results: ChildResult[]): boolean {
    return until === 'all-reported'
      ? results.every((result) => result.reported)
      : results.some((result) => result.reported)
  }

  private clear(parentId: string): boolean {
    let had = false
    getStore().update((draft) => {
      const ws = draft.workspaces.find((w) => w.id === parentId)
      had = Boolean(ws?.awaitingStackedWork)
      if (ws) ws.awaitingStackedWork = null
    })
    if (had) this.deps.broadcastState()
    this.ensureTimer()
    return had
  }

  private clearStallState(parentId: string): void {
    for (const key of this.stalledSince.keys()) {
      if (key.startsWith(`${parentId}:`)) this.stalledSince.delete(key)
    }
  }

  private ensureTimer(): void {
    const any = getStore()
      .getState()
      .workspaces.some((w) => Boolean(w.awaitingStackedWork))
    if (any && !this.timer) this.timer = setInterval(() => this.evaluateAll(), TICK_MS)
    if (!any && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private notice(workspaceId: string, text: string): void {
    const now = this.now()
    this.deps.postToTranscript(workspaceId, {
      id: `system:stacked-wait:${now}`,
      type: 'system',
      text,
      ts: now
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private time(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
}

let current: StackedWaitCoordinator | null = null

export function initStackedWaits(deps: Deps): StackedWaitCoordinator {
  current = new StackedWaitCoordinator(deps)
  return current
}

export const stackedWaits = {
  poke(parentId: string): void {
    current?.poke(parentId)
  },
  register(parentId: string, req: RegisterRequest): RegisterResult {
    if (!current) throw new Error('Stacked-work waiting is not initialized.')
    return current.register(parentId, req)
  },
  cancel(parentId: string, announce?: boolean): void {
    current?.cancel(parentId, announce)
  },
  cancelAll(): void {
    current?.cancelAll()
  },
  resetUnproductive(parentId: string): void {
    current?.resetUnproductive(parentId)
  }
}
