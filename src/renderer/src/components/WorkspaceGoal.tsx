import { AlertTriangle, CirclePause, Target, X } from 'lucide-react'
import { useState } from 'react'
import { useStore } from '../store'
import { codexGoalTone, goalNeedsAttention } from '../lib/goal'

/** 목표는 선택한 대화만의 상태가 아니라 여러 워크스페이스를 감시할 때도 보여야 해 사이드바에 둔다. */
export function WorkspaceGoal({
  workspaceId,
  depth
}: {
  workspaceId: string
  depth: number
}): React.JSX.Element | null {
  const goal = useStore((s) => s.goals[workspaceId])
  const pushToast = useStore((s) => s.pushToast)
  const [clearing, setClearing] = useState(false)
  if (!goal) return null

  const attention = goalNeedsAttention(goal)
  const tone =
    goal.backend === 'codex'
      ? codexGoalTone(goal.status)
      : 'border-violet-500/30 bg-violet-500/10 text-violet-300'
  const title = goal.backend === 'codex' ? goal.objective : goal.condition
  const status = goal.backend === 'codex' ? goal.status : `iteration ${goal.iterations}`
  const detail =
    goal.backend === 'codex'
      ? goal.tokenBudget === null
        ? null
        : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`
      : goal.lastReason

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.chat.clearGoal(workspaceId)
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
      setClearing(false)
    }
  }

  return (
    <div
      style={{ marginLeft: 12 + depth * 14 + 16 }}
      className={`mr-2 mb-1 rounded border px-2 py-1.5 text-xs ${tone}`}
    >
      <div className="flex items-center gap-1.5">
        {attention ? (
          <AlertTriangle size={12} />
        ) : goal.backend === 'codex' && goal.status === 'paused' ? (
          <CirclePause size={12} />
        ) : (
          <Target size={12} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </span>
        <span className="shrink-0 capitalize opacity-80">{status}</span>
        {goal.backend === 'codex' && (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clear()}
            className="rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100 disabled:opacity-30"
            aria-label="Clear goal"
            title="Clear goal"
          >
            <X size={11} />
          </button>
        )}
      </div>
      {detail && (
        <div className="mt-1 truncate opacity-70" title={detail}>
          {detail}
        </div>
      )}
    </div>
  )
}
