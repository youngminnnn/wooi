import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import { useWorkspaceBackend } from '../lib/backends'
import DiffView, { type DiffCommenting } from './DiffView'
import DiffCommentsBar from './diff/DiffCommentsBar'
import { isSendCommentsShortcut, type DiffComment } from '../lib/diffComments'
import type { WorkspaceDiff } from '@shared/types'

/** 참조 동일성 유지용 — 셀렉터가 매번 새 배열을 돌려주면 무한 리렌더가 난다. */
const NO_COMMENTS: DiffComment[] = []

/**
 * 우측 패널의 Changes 탭. base 브랜치 대비 변경을 표시한다.
 * 턴이 끝나 git 상태가 바뀌면(store 의 gitStatus 갱신) 자동으로 다시 불러온다.
 *
 * diff 는 읽기 전용이지만, 줄에 코멘트를 달아 모았다가 한 번에 에이전트에게 보낼 수 있다.
 * 코멘트는 초안일 뿐이라 store 의 휘발성 슬라이스에만 산다([[diffComments]]).
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
  const openFileViewer = useStore((s) => s.openFileViewer)

  const comments = useStore((s) => s.diffComments[workspaceId]) ?? NO_COMMENTS
  const addDiffComment = useStore((s) => s.addDiffComment)
  const editDiffComment = useStore((s) => s.editDiffComment)
  const removeDiffComment = useStore((s) => s.removeDiffComment)
  const clearDiffComments = useStore((s) => s.clearDiffComments)
  const sendDiffComments = useStore((s) => s.sendDiffComments)

  // 지금 보내면 바로 나가는지, 턴이 끝날 때까지 큐에 앉아 있는지 — 버튼 문구가 달라진다
  // (판단 자체는 store 의 sendDiffComments 가 하고, 여기서는 같은 조건을 보고 말만 맞춘다).
  const workspace = useStore((s) => s.app?.workspaces.find((w) => w.id === workspaceId))
  const backend = useWorkspaceBackend(workspace)
  const queue = workspace?.status === 'running' && !backend?.capabilities.steering

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

  /**
   * ⌘↵ 로 모아 둔 코멘트를 보낸다.
   *
   * 코멘트 상자 안의 ⌘↵ 는 "이 코멘트 저장"이라, 마지막 전송만 마우스로 버튼을 찾아가야 하면
   * 흐름이 거기서 끊긴다. 같은 손가락으로 끝까지 가도록 바깥에서도 받아 준다.
   * 어떤 타건이 여기 것인지는 [[diffComments]] isSendCommentsShortcut 이 정한다.
   *
   * 모달·confirm 이 떠 있으면 양보한다 — 그때의 ⌘↵ 는 뒤에 가려진 패널 것이 아니다.
   */
  const hasComments = comments.length > 0
  useEffect(() => {
    if (!hasComments) return
    const onKey = (e: KeyboardEvent): void => {
      if (!isSendCommentsShortcut(e)) return
      const st = useStore.getState()
      if (st.overlayOpen || st.confirmState) return
      e.preventDefault()
      st.sendDiffComments(workspaceId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasComments, workspaceId])

  const refresh = (): void => {
    setLoading(true)
    void window.api.git.diff(workspaceId).then((d) => {
      setDiff(d)
      setLoading(false)
    })
  }

  const commenting = useMemo<DiffCommenting>(
    () => ({
      comments,
      onAdd: (anchor, body) => addDiffComment(workspaceId, anchor, body),
      onEdit: (id, body) => editDiffComment(workspaceId, id, body),
      onRemove: (id) => removeDiffComment(workspaceId, id)
    }),
    [comments, workspaceId, addDiffComment, editDiffComment, removeDiffComment]
  )

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar
        label={`vs ${diff?.baseBranch ?? baseBranch}`}
        onRefresh={refresh}
        spinning={loading}
      />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <DiffView
          diff={diff}
          loading={loading}
          baseBranch={diff?.baseBranch ?? baseBranch}
          // 분리한 패널 창에는 큰 뷰어가 없다(FileBrowser 의 openViewer 주석 참고).
          onOpenFile={isPaneWindow ? undefined : (path) => openFileViewer(workspaceId, path)}
          commenting={commenting}
        />
      </div>
      <DiffCommentsBar
        comments={comments}
        queue={queue}
        onRemove={(id) => removeDiffComment(workspaceId, id)}
        onDiscardAll={() => clearDiffComments(workspaceId)}
        onSend={() => sendDiffComments(workspaceId)}
      />
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
