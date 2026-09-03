import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListTree, RefreshCw, WrapText } from 'lucide-react'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import DiffView, { type DiffCommenting, type DiffDiscarding } from './DiffView'
import DiffCommentsBar from './diff/DiffCommentsBar'
import DiffFileTree, {
  DIFF_TREE_DEFAULT_WIDTH,
  DIFF_TREE_MAX_WIDTH,
  DIFF_TREE_MIN_WIDTH
} from './diff/DiffFileTree'
import CompareBasePicker from './diff/CompareBasePicker'
import { isSendCommentsShortcut, type DiffComment } from '../lib/diffComments'
import { normalizeCompareBase, offersCompareBaseChoice } from '@shared/compareBase'
import { findDiffFileSection } from '../lib/diffFileTree'
import {
  DIFF_FILE_TREE_OPEN,
  DIFF_FILE_TREE_WIDTH,
  DIFF_WORD_WRAP_OFF,
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
 * 리뷰가 이 패널 안에서 닫히도록 두 갈래를 준다. 줄에 코멘트를 달아 모았다가 한 번에
 * 에이전트에게 보내거나(코멘트는 초안일 뿐이라 store 의 휘발성 슬라이스에만 산다
 * [[diffComments]]), 마음에 안 드는 hunk 는 그냥 워킹 트리에서 버린다. 스테이징도 커밋도
 * 하지 않는다 — 커밋은 계속 에이전트의 몫이다.
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
  // 랩은 켜짐이 기본이라 "꺼 뒀는지"를 저장한다([[uiFlags]] DIFF_WORD_WRAP_OFF).
  const [wrap, setWrap] = useState(() => !readUiFlag(DIFF_WORD_WRAP_OFF))
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
  const discardDiffHunk = useStore((s) => s.discardDiffHunk)

  const workspace = useStore((s) => s.app?.workspaces.find((w) => w.id === workspaceId))
  // 턴이 도는 중에 워킹 트리를 되쓰면 에이전트가 방금 읽은 파일과 어긋난다. main 도 같은 판정을
  // 한 번 더 하지만(누른 뒤 실제로 쓰기까지 사이가 있다), 애초에 누를 수 없게 하는 게 먼저다.
  const running = workspace?.status === 'running'

  // 무엇과 견줄지. 표시 전용 값이라 PR·rebase 대상은 그대로다([[compareBase]]).
  const repoId = workspace?.repoId
  const repo = useStore((s) => s.app?.repos.find((r) => r.id === repoId))
  const compareBase = normalizeCompareBase(workspace?.compareBase)

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
  }, [workspaceId, changedFiles, compareBase])

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

  const refresh = useCallback((): void => {
    setLoading(true)
    void window.api.git.diff(workspaceId).then((d) => {
      setDiff(d)
      setLoading(false)
    })
  }, [workspaceId])

  const commenting = useMemo<DiffCommenting>(
    () => ({
      comments,
      onAdd: (anchor, body) => addDiffComment(workspaceId, anchor, body),
      onEdit: (id, body) => editDiffComment(workspaceId, id, body),
      onRemove: (id) => removeDiffComment(workspaceId, id)
    }),
    [comments, workspaceId, addDiffComment, editDiffComment, removeDiffComment]
  )

  /**
   * hunk 하나 버리기. 되돌리고 나면 diff 를 **여기서** 다시 읽는다 — gitStatus 폴링이 변경 파일
   * 수를 갱신해 주기를 기다리면 최대 15 초 동안 화면이 방금 지운 줄을 그대로 보여 준다.
   */
  const discarding = useMemo<DiffDiscarding>(
    () => ({
      blockedReason: running
        ? 'The agent is working in this workspace. Wait for the turn to finish.'
        : null,
      onDiscard: (file, patch) => {
        void discardDiffHunk(workspaceId, file.path, patch).then((ok) => {
          if (ok) refresh()
        })
      }
    }),
    [running, workspaceId, discardDiffHunk, refresh]
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

  const toggleWrap = (): void => {
    const next = !wrap
    setWrap(next)
    setUiFlag(DIFF_WORD_WRAP_OFF, !next)
  }

  const resizeTree = (next: number): void => {
    setTreeWidth(next)
    setUiNumber(DIFF_FILE_TREE_WIDTH, next)
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar
        label={`vs ${diff?.baseBranch ?? baseBranch}`}
        labelNode={
          repo && offersCompareBaseChoice(baseBranch, repo.defaultBranch) ? (
            <CompareBasePicker
              label={`vs ${diff?.baseBranch ?? baseBranch}`}
              value={compareBase}
              parentBranch={baseBranch}
              defaultBranch={repo.defaultBranch}
              onChange={(next) => void window.api.git.setCompareBase(workspaceId, next)}
            />
          ) : undefined
        }
        onRefresh={refresh}
        spinning={loading}
        actions={
          <>
            <button
              onClick={toggleWrap}
              title={
                wrap
                  ? 'Stop wrapping long lines (keeps columns aligned)'
                  : 'Wrap long lines instead of scrolling sideways'
              }
              aria-label="Wrap long diff lines"
              aria-pressed={wrap}
              className={`grid h-5 w-5 place-items-center rounded ${
                wrap
                  ? 'bg-[var(--surface-2)] text-neutral-200'
                  : 'text-neutral-600 hover:text-neutral-300'
              }`}
            >
              <WrapText size={11} />
            </button>
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
          </>
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
            discarding={discarding}
            wrap={wrap}
          />
        </div>
      </div>
      <DiffCommentsBar
        comments={comments}
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
  labelNode,
  onRefresh,
  spinning,
  actions
}: {
  label: string
  /**
   * 라벨 자리를 통째로 대신할 것. 주지 않으면 `label` 을 그대로 그린다.
   * (기본 라벨은 `truncate` 로 잘리므로, 팝오버를 여는 것은 이 자리를 직접 받아야 한다.)
   */
  labelNode?: React.ReactNode
  onRefresh: () => void
  spinning: boolean
  /** 새로고침 왼쪽에 놓을 이 패널만의 버튼들. 다른 패널은 주지 않으므로 선택 항목이다. */
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border)] text-xs text-neutral-500">
      {labelNode ?? <span className="truncate">{label}</span>}
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
