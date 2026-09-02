/**
 * 부모 에이전트가 보는 워크스페이스 활동 상태.
 *
 * WorkspaceStatus 는 앱 전체가 쓰는 큰 계약이라 늘리지 않고, 협업 도구에 필요한 풍부한 상태만
 * 여기서 파생한다. 우선순위는 사이드바 StatusDot 과 같아야 한다 — 사용자가 보는 상태와 부모
 * 에이전트가 보는 상태가 갈리면 같은 자식을 두고 서로 다른 판단을 하게 된다.
 */
import { activeRateLimitPause } from '@shared/types'
import type { Workspace } from '@shared/types'
import { backgroundShellCount } from '../../runningAgentsCache'
import { pendingPermissions } from '../../remote/permissions'

export type StackedChildState =
  | 'running'
  | 'waiting-for-user-permission'
  | 'rate-limited'
  | 'ended-with-error'
  | 'background-tasks-running'
  | 'idle'

export interface WorkspaceActivity {
  state: StackedChildState
  note?: string
  lastActiveAt: number
}

// Sidebar 의 RUNNING_STALE_MS 와 같은 임계다. main 에는 렌더러 전용 상수를 import 하지 않는다.
const RUNNING_STALE_MS = 5 * 60 * 1000

/**
 * PendingPermissionRegistry 는 조회 시점에 30분 넘은 요청을 방어적으로 버린다. 사람이 한 시간
 * 넘게 자리를 비우면 승인 대기가 idle 로 보일 수 있지만, 보수적인 방향의 오차라 그대로 둔다.
 */
export function describeWorkspaceActivity(ws: Workspace, now = Date.now()): WorkspaceActivity {
  const base = { lastActiveAt: ws.lastActiveAt }
  const permissionRequests = pendingPermissions
    .list()
    .filter((request) => request.workspaceId === ws.id)
  if (permissionRequests.length > 0) {
    const toolNames = [...new Set(permissionRequests.map((request) => request.toolName))]
    const count = permissionRequests.length
    return {
      ...base,
      state: 'waiting-for-user-permission',
      note:
        `Waiting for user permission for ${toolNames.join(', ')}` +
        `${count > 1 ? ` (${count} requests)` : ''}; this workspace cannot do anything or report ` +
        'back until approval.'
    }
  }

  if (ws.status === 'running') {
    const runningMs = Math.max(0, now - ws.lastActiveAt)
    return {
      ...base,
      state: 'running',
      ...(runningMs >= RUNNING_STALE_MS
        ? {
            note: `Running for ${Math.round(runningMs / 60_000)} minutes without finishing — it may be stuck.`
          }
        : {})
    }
  }

  if (ws.pendingShutdownResume) {
    return {
      ...base,
      state: 'idle',
      note: 'The previous turn was interrupted by shutdown and is waiting for a message to continue.'
    }
  }

  const rateLimit = activeRateLimitPause(ws.rateLimited, now)
  if (ws.pendingRateLimitResume || rateLimit) {
    // 자동 재개 예약이 있으면 그쪽이 더 많은 것을 말해 준다 — 사이드바도 같은 순서로 고른다.
    const resume = ws.pendingRateLimitResume
    const resetsAt = rateLimit?.resetsAt
    return {
      ...base,
      state: 'rate-limited',
      note: resume
        ? resume.cause === 'connection'
          ? `Paused because Wooi could not reach the API; it will retry at ${new Date(resume.retryAt).toISOString()}.`
          : `Paused by the usage limit and scheduled to resume at ${new Date(resume.retryAt).toISOString()}.`
        : resetsAt != null
          ? `Stopped by the usage limit until ${new Date(resetsAt).toISOString()}.`
          : 'Stopped by the usage limit; the reset time is unknown.'
    }
  }

  if (ws.status === 'error') return { ...base, state: 'ended-with-error' }

  const backgroundTasks = backgroundShellCount(ws.id)
  if (backgroundTasks > 0) {
    return {
      ...base,
      state: 'background-tasks-running',
      note: `The agent itself is idle, but ${backgroundTasks} background shell${backgroundTasks === 1 ? '' : 's'} ${backgroundTasks === 1 ? 'is' : 'are'} still running.`
    }
  }

  return { ...base, state: 'idle' }
}
