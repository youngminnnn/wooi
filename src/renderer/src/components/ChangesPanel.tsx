import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import DiffView from './DiffView'
import type { WorkspaceDiff } from '@shared/types'

/**
 * 우측 패널의 Changes 탭. base 브랜치 대비 변경을 표시한다.
 * 턴이 끝나 git 상태가 바뀌면(store 의 gitStatus 갱신) 자동으로 다시 불러온다.
 */
export default function ChangesPanel({
  workspaceId,
  baseBranch
}: {
  workspaceId: string
  baseBranch: string
}): React.JSX.Element {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(true)
  // git 상태의 변경 파일 수가 바뀌면 diff 를 다시 가져오는 트리거로 쓴다.
  const changedFiles = useStore((s) => s.gitStatus[workspaceId]?.changedFiles ?? 0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.api.git.diff(workspaceId).then((d) => {
      if (alive) {
        setDiff(d)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [workspaceId, changedFiles])

  const refresh = (): void => {
    setLoading(true)
    void window.api.git.diff(workspaceId).then((d) => {
      setDiff(d)
      setLoading(false)
    })
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar label={`vs ${baseBranch}`} onRefresh={refresh} spinning={loading} />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <DiffView diff={diff} loading={loading} baseBranch={baseBranch} />
      </div>
    </div>
  )
}

/** 패널 상단 공통 도구줄(라벨 + 새로고침). */
export function PanelToolbar({
  label,
  onRefresh,
  spinning
}: {
  label: string
  onRefresh: () => void
  spinning: boolean
}): React.JSX.Element {
  return (
    <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border)] text-xs text-neutral-500">
      <span className="truncate">{label}</span>
      <div className="flex-1" />
      <button
        onClick={onRefresh}
        className="text-neutral-600 hover:text-neutral-300"
        title="Refresh"
      >
        <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}
