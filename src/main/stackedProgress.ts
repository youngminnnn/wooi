import { activeRateLimitPause, type Workspace } from '@shared/types'

export type StackedProgressReason =
  'running' | 'resuming' | 'archived' | 'awaiting-approval' | 'rate-limited' | 'error' | 'idle'

export interface StackedProgress {
  canProgress: boolean
  reason: StackedProgressReason
}

/** electron 을 끌어들이지 않아 도구와 UI 양쪽에서 같은 판정을 재사용할 수 있게 한다. */
export function stackedChildProgress(
  child: Workspace,
  awaitingApproval: boolean,
  now = Date.now()
): StackedProgress {
  if (child.archived) return { canProgress: false, reason: 'archived' }
  if (child.status === 'running') return { canProgress: true, reason: 'running' }
  if (child.pendingRateLimitResume) return { canProgress: true, reason: 'resuming' }
  if (activeRateLimitPause(child.rateLimited, now))
    return { canProgress: false, reason: 'rate-limited' }
  if (awaitingApproval) return { canProgress: false, reason: 'awaiting-approval' }
  if (child.status === 'error') return { canProgress: false, reason: 'error' }
  return { canProgress: false, reason: 'idle' }
}
