import type { CodexGoalStatus, WorkspaceGoal } from '@shared/types'

export function codexGoalTone(status: CodexGoalStatus): string {
  if (status === 'blocked')
    return 'border-[var(--danger-500)]/40 bg-[var(--danger-500)]/10 text-[var(--danger-300)]'
  if (status === 'usageLimited' || status === 'budgetLimited') {
    return 'border-[var(--warning-500)]/40 bg-[var(--warning-500)]/10 text-[var(--warning-300)]'
  }
  if (status === 'active') {
    return 'border-[var(--info-500)]/40 bg-[var(--info-500)]/10 text-[var(--info-300)]'
  }
  if (status === 'complete')
    return 'border-[var(--success-500)]/40 bg-[var(--success-500)]/10 text-[var(--success-300)]'
  return 'border-neutral-600 bg-neutral-800/50 text-neutral-400'
}

export function goalNeedsAttention(goal: WorkspaceGoal): boolean {
  return (
    goal.backend === 'codex' &&
    (goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited')
  )
}
