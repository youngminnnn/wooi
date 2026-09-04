import { RotateCw } from 'lucide-react'
import { useStore } from '../store'

/** 트랜스크립트가 아니라 현재 대기만 설명하는 사이드바 행. 다음 스트림 이벤트에서 사라진다. */
export function WorkspaceApiRetry({
  workspaceId,
  depth
}: {
  workspaceId: string
  depth: number
}): React.JSX.Element | null {
  const retry = useStore((s) => s.apiRetries[workspaceId])
  if (!retry) return null

  const delay = retry.retryDelayMs / 1000
  const status = retry.errorStatus === null ? '' : ` after a ${retry.errorStatus}`
  const text = `Retrying${status} · ${retry.attempt}/${retry.maxRetries} · ${delay.toLocaleString(undefined, { maximumFractionDigits: 1 })}s`

  return (
    <div
      style={{ paddingLeft: 12 + depth * 14 + 16 }}
      className="flex items-center gap-1.5 pr-2 py-0.5 text-xs text-[var(--warning-400)]"
      title={text}
      role="status"
    >
      <RotateCw size={10} className="shrink-0 animate-spin" />
      <span className="truncate">{text}</span>
    </div>
  )
}
