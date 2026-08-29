import { useEffect, useMemo, useRef, useState } from 'react'
import { ListTree, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import { useWorkspaceBackend } from '../lib/backends'
import DiffView, { type DiffCommenting } from './DiffView'
import DiffCommentsBar from './diff/DiffCommentsBar'
import DiffFileTree, {
  DIFF_TREE_DEFAULT_WIDTH,
  DIFF_TREE_MAX_WIDTH,
  DIFF_TREE_MIN_WIDTH
} from './diff/DiffFileTree'
import { isSendCommentsShortcut, type DiffComment } from '../lib/diffComments'
import { findDiffFileSection } from '../lib/diffFileTree'
import {
  DIFF_FILE_TREE_OPEN,
  DIFF_FILE_TREE_WIDTH,
  readUiFlag,
  readUiNumber,
  setUiFlag,
  setUiNumber
} from '../lib/uiFlags'
import type { FileDiff, WorkspaceDiff } from '@shared/types'

/** 참조 동일성 유지용 — 셀렉터가 매번 새 배열을 돌려주면 무한 리렌더가 난다. */
const NO_COMMENTS: DiffComment[] = []

/** diff 가 아직 없을 때 트리에 넘길 빈 목록. 매번 새 배열을 만들면 트리가 헛돈다. */
const NO_FILES: FileDiff[] = []

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
  // 파일 트리는 이 패널만의 화면 상태다 — 전역 설정이 아니라 localStorage 로 기억한다([[uiFlags]]).
  const [treeOpen, setTreeOpen] = useState(() => readUiFlag(DIFF_FILE_TREE_OPEN))
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = readUiNumber(DIFF_FILE_TREE_WIDTH)
    if (!stored) return DIFF_TREE_DEFAULT_WIDTH
    return Math.min(DIFF_TREE_MAX_WIDTH, Math.max(DIFF_TREE_MIN_WIDTH, stored))
  })
  const [activePath, setActivePath] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
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

  /** 트리에서 고른 파일의 블록으로 스크롤한다. 접혀 있으면 머리글까지만 — 펴는 건 사용자 몫이다. */
  const jumpTo = (path: string): void => {
    setActivePath(path)
    findDiffFileSection(scrollRef.current, path)?.scrollIntoView({ block: 'start' })
  }

  const toggleTree = (): void => {
    const next = !treeOpen
    setTreeOpen(next)
    setUiFlag(DIFF_FILE_TREE_OPEN, next)
  }

  const resizeTree = (next: number): void => {
    setTreeWidth(next)
    setUiNumber(DIFF_FILE_TREE_WIDTH, next)
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar
        label={`vs ${diff?.baseBranch ?? baseBranch}`}
        onRefresh={refresh}
        spinning={loading}
        actions={
          <button
            onClick={toggleTree}
            title={treeOpen ? 'Hide the file tree' : 'Show the file tree'}
            aria-label={treeOpen ? 'Hide the file tree' : 'Show the file tree'}
            aria-pressed={treeOpen}
            className={`grid h-5 w-5 place-items-center rounded ${
              treeOpen
                ? 'bg-[var(--surface-2)] text-neutral-200'
                : 'text-neutral-600 hover:text-neutral-300'
            }`}
          >
            <ListTree size={11} />
          </button>
        }
      />
      <div className="flex-1 min-h-0 flex">
        {treeOpen && (
          <DiffFileTree
            files={diff?.files ?? NO_FILES}
            activePath={activePath}
            width={treeWidth}
            onWidthChange={resizeTree}
            onSelect={jumpTo}
            onClose={toggleTree}
          />
        )}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto px-3 py-3">
          <DiffView
            diff={diff}
            loading={loading}
            baseBranch={diff?.baseBranch ?? baseBranch}
            // 분리한 패널 창에는 큰 뷰어가 없다(FileBrowser 의 openViewer 주석 참고).
            onOpenFile={isPaneWindow ? undefined : (path) => openFileViewer(workspaceId, path)}
            commenting={commenting}
          />
        </div>
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
  spinning,
  actions
}: {
  label: string
  onRefresh: () => void
  spinning: boolean
  /** 새로고침 왼쪽에 놓을 이 패널만의 버튼들. 다른 패널은 주지 않으므로 선택 항목이다. */
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border)] text-xs text-neutral-500">
      <span className="truncate">{label}</span>
      <div className="flex-1" />
      {actions}
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
