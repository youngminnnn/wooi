import type { CodexGoalStatus, WorkspaceGoal } from '@shared/types'

export function codexGoalTone(status: CodexGoalStatus): string {
  if (status === 'blocked') return 'border-red-500/40 bg-red-500/10 text-red-300'
  if (status === 'usageLimited' || status === 'budgetLimited') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  }
  if (status === 'active') {
    return 'border-[var(--info-500)]/40 bg-[var(--info-500)]/10 text-[var(--info-300)]'
  }
  if (status === 'complete') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
  return 'border-neutral-600 bg-neutral-800/50 text-neutral-400'
}

export function goalNeedsAttention(goal: WorkspaceGoal): boolean {
  return (
    goal.backend === 'codex' &&
    (goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited')
  )
}
