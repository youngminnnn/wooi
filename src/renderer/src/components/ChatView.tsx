import { useEffect, useState } from 'react'
import {
  GitBranch,
  FolderOpen,
  Code2,
  FileSearch,
  Terminal,
  Archive,
  RefreshCw,
  GitPullRequest,
  GitPullRequestCreate,
  GitPullRequestDraft,
  GitPullRequestClosed,
  GitMerge,
  GitMergeConflict,
  Loader2,
  CircleCheck,
  MessageSquareWarning,
  Clock,
  ExternalLink,
  BellDot,
  ShieldQuestion,
  PanelRight,
  Pencil,
  AlertTriangle,
  RotateCw,
  Users,
  X,
  GitFork,
  type LucideIcon
} from 'lucide-react'
import { useStore } from '../store'
import MessageList from './MessageList'
import Composer from './Composer'
import ScriptPanel from './ScriptPanel'
import PermissionPrompt from './PermissionPrompt'
import QuestionPrompt from './QuestionPrompt'
import PlanPrompt from './PlanPrompt'
import DiffModal from './DiffModal'
import PrActionsMenu from './PrActionsMenu'
import StackPopover from './StackPopover'
import StackSyncBanner from './StackSyncBanner'
import StackBaseBanner from './StackBaseBanner'
import ArchiveSuggestBanner from './ArchiveSuggestBanner'
import PeerInboxBanner from './PeerInboxBanner'
import StackedWaitBanner from './StackedWaitBanner'
import ExportMenu from './ExportMenu'
import HeaderButton from './HeaderButton'
import HeaderChip from './HeaderChip'
import BaseSyncControl from './BaseSyncControl'
import ConflictResolveAction from './ConflictResolveAction'
import { AgentBackendMark, GithubMark } from './BrandIcons'
import { useGithubDisconnected } from '../lib/github'
import { useMultiAgent } from '../lib/multiAgent'
import { openFileQuickOpen } from '../lib/fileViewer'
import { workspaceDisplayName } from '@shared/types'
import { conversationForkDisabledReason } from '../lib/conversationFork'
import type { PrState, Workspace } from '@shared/types'

/**
 * PR 상태별 아이콘 + 색. Tailwind v4 는 동적으로 조합한 클래스명을 스캔하지 못하므로
 * 상태마다 전체 클래스 문자열을 그대로 둔다(보간 금지).
 */
const PR_STYLE: Record<PrState, { Icon: LucideIcon; iconClass: string; badgeClass: string }> = {
  draft: {
    Icon: GitPullRequestDraft,
    iconClass: 'text-neutral-400',
    badgeClass:
      'border-[var(--border-2)] bg-[var(--surface)] text-neutral-300 hover:border-neutral-500'
  },
  review_required: {
    Icon: Clock,
    iconClass: 'text-[var(--warning-400)]',
    badgeClass:
      'border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10 text-[var(--warning-200)] hover:border-[var(--warning-500)]/60'
  },
  changes_requested: {
    Icon: MessageSquareWarning,
    iconClass: 'text-[var(--attention-400)]',
    badgeClass:
      'border-[var(--attention-500)]/30 bg-[var(--attention-500)]/10 text-[var(--attention-200)] hover:border-[var(--attention-500)]/60'
  },
  ci_pending: {
    Icon: Clock,
    iconClass: 'text-[var(--warning-400)]',
    badgeClass:
      'border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10 text-[var(--warning-200)] hover:border-[var(--warning-500)]/60'
  },
  ci_failed: {
    Icon: MessageSquareWarning,
    iconClass: 'text-[var(--danger-400)]',
    badgeClass:
      'border-[var(--danger-500)]/30 bg-[var(--danger-500)]/10 text-[var(--danger-200)] hover:border-[var(--danger-500)]/60'
  },
  approved: {
    Icon: CircleCheck,
    iconClass: 'text-[var(--success-400)]',
    badgeClass:
      'border-[var(--success-500)]/30 bg-[var(--success-500)]/10 text-[var(--success-200)] hover:border-[var(--success-500)]/60'
  },
  conflict: {
    Icon: GitMergeConflict,
    iconClass: 'text-[var(--danger-400)]',
    badgeClass:
      'border-[var(--danger-500)]/30 bg-[var(--danger-500)]/10 text-[var(--danger-200)] hover:border-[var(--danger-500)]/60'
  },
  open: {
    Icon: GitPullRequest,
    iconClass: 'text-[var(--open-400)]',
    badgeClass:
      'border-[var(--open-500)]/30 bg-[var(--open-500)]/10 text-[var(--open-200)] hover:border-[var(--open-500)]/60'
  },
  merged: {
    Icon: GitMerge,
    iconClass: 'text-[var(--merged-400)]',
    badgeClass:
      'border-[var(--merged-500)]/30 bg-[var(--merged-500)]/10 text-[var(--merged-200)] hover:border-[var(--merged-500)]/60'
  },
  closed: {
    Icon: GitPullRequestClosed,
    iconClass: 'text-neutral-500',
    badgeClass:
      'border-[var(--border-2)] bg-[var(--surface)] text-neutral-400 hover:border-neutral-500'
  }
}

export default function ChatView({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const showScripts = useStore((s) => s.scriptPanelOpen[workspace.id] ?? false)
  const setShowScripts = useStore((s) => s.setScriptPanelOpen)
  // 스크립트 패널을 별도 창으로 떼어 뒀으면 여기서는 그리지 않고, 버튼은 그 창을 앞으로 가져온다.
  const scriptsDetached = useStore((s) => s.detachedPanes.scripts)
  // dev 스크립트 실행 여부 — 스크립트 버튼에 실행 중 점을 띄워 패널을 닫아도 알 수 있게 한다.
  const devRunning = useStore((s) =>
    (s.scriptStatus[workspace.id] ?? []).some((x) => x.state === 'running')
  )
  const rightPanelOpen = useStore(
    (s) => s.rightPanelOpen[workspace.id] ?? s.app?.settings.defaultRightPanelOpen ?? true
  )
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const workPaneDetached = useStore((s) => s.detachedPanes.work)
  const [showDiff, setShowDiff] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Composer 의 /diff 명령이 이 workspace 를 대상으로 보내는 신호를 받아 diff 모달을 연다
  // (Composer 는 ChatView 의 로컬 showDiff 상태에 직접 접근할 수 없어 window 이벤트로 전달한다).
  useEffect(() => {
    const onOpenDiff = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspace.id) setShowDiff(true)
    }
    window.addEventListener('wooi:open-diff', onOpenDiff)
    return () => window.removeEventListener('wooi:open-diff', onOpenDiff)
  }, [workspace.id])
  const [editingName, setEditingName] = useState<string | null>(null)
  // 세션이 에러로 멈췄을 때 노출하는 복구 배너의 로컬 dismiss. 다시 에러 상태로 진입하면 리셋된다.
  const [errorDismissed, setErrorDismissed] = useState(false)
  useEffect(() => {
    if (workspace.status !== 'error') setErrorDismissed(false)
  }, [workspace.status])
  const git = useStore((s) => s.gitStatus[workspace.id])
  const stackProgress = useStore((s) => s.stackProgress[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  // 브랜치 전환·새로고침 중 PR 상태 조회가 진행 중이면 헤더 배지에 로딩을 표시한다.
  const prRefreshing = useStore((s) => s.prRefreshing[workspace.id] ?? false)
  // setup 실패는 메인이 Workspace.setupState 로 영속하므로 workspace prop 에서 바로 읽는다(재시작에도 유지).
  const setupFailed = workspace.setupState === 'failed'
  const retrySetup = useStore((s) => s.retrySetup)
  const refreshGit = useStore((s) => s.refreshGit)
  const refreshPr = useStore((s) => s.refreshPr)
  const permissions = useStore((s) => s.permissions)
  const pending = permissions.find((p) => p.workspaceId === workspace.id) ?? null
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)
  const requireGithub = useStore((s) => s.requireGithub)
  // gh 미연결이 확인된 상태면 "Create PR" 대신 "Connect GitHub" 를 노출한다(숨기지 않는다).
  const githubDisconnected = useGithubDisconnected()

  const unread = useStore((s) => s.unread)
  const nextUnreadId = useStore((s) => s.nextUnreadId)
  const nextPendingPermissionId = useStore((s) => s.nextPendingPermissionId)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const reportArchiveScriptFailure = useStore((s) => s.reportArchiveScriptFailure)
  const runArchiveWorkspace = useStore((s) => s.archiveWorkspace)
  const approveAllPermissions = useStore((s) => s.approveAllPermissions)
  const unreadCount = Object.entries(unread).filter(([id, on]) => on && id !== workspace.id).length
  const pendingElsewhere = permissions.filter((p) => p.workspaceId !== workspace.id)
  const pendingElsewhereCount = new Set(pendingElsewhere.map((p) => p.workspaceId)).size
  // 일괄 승인 가능한(=AskUserQuestion 이 아닌) 대기 권한 수(모든 workspace 합산).
  const approvableCount = permissions.filter((p) => p.toolName !== 'AskUserQuestion').length

  const approveAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Approve ${approvableCount} pending permission${approvableCount > 1 ? 's' : ''}?`,
      body: 'Allows every waiting tool request across all workspaces at once. Questions that need an answer are left untouched.',
      confirmLabel: 'Approve all'
    })
    if (ok) approveAllPermissions()
  }

  const running = workspace.status === 'running'
  const forkWorkspace = useStore((s) => s.forkWorkspace)
  const forkDisabledReason = conversationForkDisabledReason(workspace)

  // 표시 이름: 사용자 override → PR 제목 → worktree 이름 순으로 결정한다.
  const displayName = workspaceDisplayName(workspace, pr?.title)

  // Composer 는 ChatView 가 가진 인라인 편집 상태에 직접 닿을 수 없어, /rename 의 대상만 window 이벤트로 전달한다.
  useEffect(() => {
    const onRenameWorkspace = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspace.id) setEditingName(displayName)
    }
    window.addEventListener('wooi:rename-workspace', onRenameWorkspace)
    return () => window.removeEventListener('wooi:rename-workspace', onRenameWorkspace)
  }, [workspace.id, displayName])

  // 에이전트 배지는 고를 수 있는 에이전트가 둘 이상일 때만 의미가 있다.
  const backends = useStore((s) => s.backends)
  const showAgentBadge = backends.filter((b) => b.available).length > 1
  const agentLabel =
    backends.find((b) => b.id === workspace.agentBackend)?.label ?? workspace.agentBackend
  // 사이드바 배지와 같은 판단을 쓴다 — 두 화면이 갈라지면 어느 쪽이 맞는지 알 수 없다.
  const multiAgent = useMultiAgent(workspace)

  const turnOffAgentTeam = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Switch to Solo mode?',
      body: 'This workspace will no longer be able to delegate work to subagents. The change applies from the next message.',
      confirmLabel: 'Switch to Solo',
      danger: true
    })
    if (!ok) return
    await window.api.workspace.setMultiAgent(workspace.id, false)
  }

  const archiveWorkspace = async (): Promise<void> => {
    const ok = await confirm({
      title: `Archive "${displayName}"?`,
      body: 'Its worktree directory will be removed (branch & history kept). You can unarchive it later.',
      confirmLabel: 'Archive',
      danger: true
    })
    if (!ok) return
    const { archiveScriptFailure } = await runArchiveWorkspace(workspace.id)
    reportArchiveScriptFailure(archiveScriptFailure)
  }

  // 우상단 '아카이브(⇧⌘⌫)' 단축키는 확인 다이얼로그와 displayName 이 필요하므로
  // 전역 핸들러(App.tsx)에서 직접 처리하지 않고 이 이벤트로 신호를 받아 처리한다.
  useEffect(() => {
    const onArchive = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspace.id) void archiveWorkspace()
    }
    window.addEventListener('wooi:archive-workspace', onArchive)
    return () => window.removeEventListener('wooi:archive-workspace', onArchive)
    // archiveWorkspace 는 매 렌더 재생성되므로 최신 displayName 반영 위해 deps 에 포함한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, displayName])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await Promise.all([refreshGit(workspace.id), refreshPr(workspace.id)])
    setRefreshing(false)
  }

  // PR 생성은 gh 를 쓴다 — 미연결이면 여기서 연결 모달을 띄우고, 연결이 끝나면 그대로 이어서 연다.
  const createPr = (): void => {
    void requireGithub('Opening a pull request needs GitHub.', async () => {
      const res = await window.api.pr.create(workspace.id)
      if (res.error) pushToast('error', `Couldn't open PR page: ${res.error}`)
      else {
        pushToast('info', 'Opening the PR creation page in your browser…')
        setTimeout(() => void refreshPr(workspace.id), 4000)
      }
    })
  }

  const abortMerge = async (): Promise<void> => {
    await window.api.git.abortMerge(workspace.id)
    pushToast('info', 'Merge aborted.')
    await refresh()
  }

  const lastConflict = [...(stackProgress?.done ?? [])]
    .reverse()
    .find((step) => step.status === 'conflict')
  const conflictedFileCount = lastConflict?.conflictedFiles?.length

  // 세션이 에러(네트워크 끊김·에이전트 크래시 등)로 멈췄을 때 마지막 사용자 메시지를 다시 보내
  // 대화를 이어 간다. 재전송이 세션을 running 으로 되돌려 error 상태를 해제한다.
  const retryLastMessage = (): void => {
    // ChatView 는 트랜스크립트를 구독하지 않으므로(재렌더 회피) 클릭 시점에 상태를 임시로 읽는다.
    const transcript = useStore.getState().transcripts[workspace.id] ?? []
    const lastUser = [...transcript].reverse().find((i) => i.type === 'user') as
      { text: string; attachments?: unknown[] } | undefined
    if (lastUser?.text?.trim()) {
      void window.api.chat.send(workspace.id, lastUser.text)
      // 트랜스크립트에는 첨부 원본(base64)이 남지 않아 이미지는 다시 보낼 수 없다 — 조용히 빠뜨리지 말고 알린다.
      if (lastUser.attachments?.length)
        pushToast('info', 'Retried with text only — re-attach any images if needed.')
    } else pushToast('info', 'No previous message to retry — type a message to continue.')
  }

  const commitName = (): void => {
    const name = (editingName ?? '').trim()
    // 비우면 override 가 지워져 기본 규칙(worktree 이름 → PR 제목)으로 돌아간다.
    if (name !== displayName) void window.api.workspace.rename(workspace.id, name)
    setEditingName(null)
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* 헤더 */}
      <div className="workspace-header h-12 shrink-0 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <div className="workspace-header-identity min-w-0">
          {editingName !== null ? (
            <input
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                else if (e.key === 'Escape') setEditingName(null)
              }}
              className="w-full min-w-0 text-base font-semibold text-neutral-100 bg-[var(--surface)] border border-[var(--border-strong)] rounded px-1.5 py-0.5 outline-none"
            />
          ) : (
            <div className="group/name flex items-center gap-1 min-w-0">
              {/* 어떤 에이전트가 이 워크스페이스를 돌리는지 — 입력창 상태줄이나 /agent 로 바꿀 수
                  있다([[canSwitchAgentBackend]]).
                  에이전트가 하나뿐인 사용자에게는 정보가 아니라 잡음이라 감춘다. */}
              {showAgentBadge && (
                <span
                  className="shrink-0 grid place-items-center text-neutral-500"
                  title={`Running on ${agentLabel}`}
                >
                  <AgentBackendMark backend={workspace.agentBackend} size={13} />
                </span>
              )}
              <div
                className="text-base font-semibold text-neutral-100 truncate cursor-text"
                title={`${displayName}\n(double-click to rename · clear to reset)`}
                onDoubleClick={() => setEditingName(displayName)}
              >
                {displayName}
              </div>
              {/* 편집 가능 힌트: 호버 시 연필 아이콘을 띄워 이름을 바꿀 수 있음을 알린다. */}
              <button
                onClick={() => setEditingName(displayName)}
                className="opacity-0 group-hover/name:opacity-100 shrink-0 grid place-items-center text-neutral-500 hover:text-neutral-200"
                title="Rename workspace"
              >
                <Pencil size={12} />
              </button>
            </div>
          )}
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-neutral-500">
            {/* 팀은 이름 옆 브랜드 마크만으로는 드러나지 않는다 — 그 마크는 메인 에이전트일
                뿐이라, 이 워크스페이스에서 **다른 제품의 에이전트가 파일을 고칠 수 있다**는
                사실은 따로 말해 줘야 한다.

                Solo 일 때는 아무것도 그리지 않는다. Solo 는 사용자가 고른 적 없는 기본값이고
                (생성에서도 설정에서도 묻지 않는다), 고르지 않은 상태에 이름표를 달면 뭔가
                설정했다는 인상만 남는다. `Solo | Agent team` 토글은 이번에 없앤 "두 종류 중
                하나" 프레이밍을 그대로 되살리기도 한다 — 팀은 종류가 아니라 켜진 능력이다.
                사이드바 행 마크도 같은 규칙을 쓴다.

                그래서 이 배지는 **끄는 자리**다. 켜는 것은 대화가 맡는다("Codex 한테 리뷰
                시켜줘" → switch_to_agent_team 승인 카드) — 켜기가 사용자가 방금 말로 요청한
                일인 반면, 끄기는 아무도 요청하지 않았는데 능력을 줄이는 일이라 사람만 한다
                ([[agent/tools/agentTeam]] 가 켜는 쪽만 도구로 연 것과 같은 비대칭). */}
            {multiAgent.active && (
              <button
                onClick={() => void turnOffAgentTeam()}
                className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 bg-[var(--surface-2)] text-neutral-400 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
                title={`Agent team led by ${agentLabel}. Click to turn delegation off; applies from the next message.`}
              >
                <Users size={10} className="multi-agent-mark" />
                Agent team
              </button>
            )}
            <GitBranch size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{workspace.branch}</span>
            {git && (
              <button
                onClick={() => setShowDiff(true)}
                disabled={git.changedFiles === 0}
                className="shrink-0 whitespace-nowrap text-neutral-500 hover:text-neutral-200 disabled:hover:text-neutral-500 disabled:cursor-default"
                title={git.changedFiles > 0 ? 'View changes' : 'No changes'}
              >
                · {git.changedFiles} changed{git.ahead > 0 ? ` · ↑${git.ahead}` : ''}
                {git.behind > 0 ? ` · ↓${git.behind}` : ''}
              </button>
            )}
            <button
              onClick={refresh}
              className="shrink-0 text-neutral-600 hover:text-neutral-300"
              title="Refresh git & PR status"
            >
              <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {/* 충돌은 액션 묶음과 떨어져 있어도 현재 작업 트리 상태를 설명하므로 메타데이터에 남긴다. */}
            {git?.conflicted && (
              <span className="flex items-center gap-1.5">
                <span
                  className="flex items-center gap-1 text-[var(--danger-400)]"
                  title="Unresolved merge conflicts in the working tree"
                >
                  <GitMergeConflict size={11} />
                  conflicts
                </span>
                <button
                  onClick={abortMerge}
                  className="text-neutral-500 hover:text-neutral-200 underline decoration-dotted"
                  title="Abort the in-progress merge and return to the pre-merge state"
                >
                  abort
                </button>
                {/* rebase 충돌에만 붙인다 — updateFromBase 의 머지 충돌도 conflicted 를 켜지만,
                    그쪽은 main 이 거절하므로 버튼을 띄우면 누를 때마다 실패하는 버튼이 된다. */}
                {git.rebasing && (
                  <ConflictResolveAction
                    workspace={workspace}
                    conflictedFileCount={conflictedFileCount}
                  />
                )}
              </span>
            )}
            {setupFailed && (
              <button
                onClick={() => retrySetup(workspace.id)}
                className="flex items-center gap-1 text-[var(--danger-400)] hover:text-[var(--danger-300)] underline decoration-dotted"
                title="The setup script failed. Click to re-run it and open the Scripts panel."
              >
                <AlertTriangle size={11} />
                setup failed · retry
              </button>
            )}
          </div>
        </div>

        <div className="workspace-header-actions flex shrink-0 items-center gap-3">
          <div className="workspace-header-action-secondary contents">
            <HeaderButton
              title={
                scriptsDetached
                  ? 'Scripts — open in a separate window'
                  : devRunning
                    ? 'Scripts — dev running'
                    : 'Run project scripts'
              }
              shortcut="⇧⌘S"
              onClick={() =>
                scriptsDetached
                  ? void window.api.pane.focus('scripts')
                  : setShowScripts(workspace.id, !showScripts)
              }
              active={showScripts || scriptsDetached}
              indicator={devRunning}
            >
              <Terminal size={15} />
            </HeaderButton>
            <HeaderButton
              title="Open a file in the big viewer"
              shortcut="⇧⌘O"
              onClick={openFileQuickOpen}
            >
              <FileSearch size={15} />
            </HeaderButton>
            <HeaderButton
              title="Open in editor"
              shortcut="⇧⌘E"
              onClick={() => void window.api.workspace.openInEditor(workspace.id)}
            >
              <Code2 size={15} />
            </HeaderButton>
            <HeaderButton
              title="Reveal in Finder"
              shortcut="⇧⌘F"
              onClick={() => void window.api.workspace.revealInFinder(workspace.id)}
            >
              <FolderOpen size={15} />
            </HeaderButton>
            <ExportMenu workspaceId={workspace.id} title={displayName} />
            <HeaderButton
              title={forkDisabledReason ?? 'Fork conversation'}
              onClick={() => void forkWorkspace(workspace.id)}
              disabled={forkDisabledReason !== null}
            >
              <GitFork size={15} />
            </HeaderButton>
            <HeaderButton
              title="Archive workspace"
              shortcut="⇧⌘⌫"
              onClick={archiveWorkspace}
              danger
            >
              <Archive size={15} />
            </HeaderButton>
          </div>
          <HeaderButton
            title={
              workPaneDetached
                ? 'Work panel — open in a separate window'
                : rightPanelOpen
                  ? 'Hide work panel'
                  : 'Show work panel'
            }
            shortcut="⌘J"
            onClick={toggleRightPanel}
            active={rightPanelOpen || workPaneDetached}
          >
            <PanelRight size={15} />
          </HeaderButton>

          <div className="workspace-header-basesync flex items-center gap-1.5 pl-2 ml-0.5 border-l border-[var(--border)] empty:hidden empty:border-l-0 empty:pl-0">
            {git && (
              <BaseSyncControl
                workspace={workspace}
                git={git}
                prState={pr?.state}
                prNeedsBaseUpdate={pr?.needsBaseUpdate}
                refresh={refresh}
              />
            )}
          </div>

          {/* Stack 조망·전환: 에이전트나 모델 A 로 만들어진 스택을 관리한다(우측 패널과 무관). */}
          <div className="workspace-header-stack flex items-center gap-1.5 pl-2 ml-0.5 border-l border-[var(--border)] empty:hidden empty:border-l-0 empty:pl-0">
            <StackPopover workspace={workspace} />
          </div>

          {/* PR 상태 + 링크: 헤더 우측 끝. 상태별 색·아이콘으로 한눈에 구분. 조회 중이면 스피너를 곁들인다. */}
          {(pr || (git && git.ahead > 0) || prRefreshing) && (
            <div className="workspace-header-pr flex items-center gap-1.5 pl-2 ml-0.5 border-l border-[var(--border)]">
              {prRefreshing && (
                <span title="Refreshing pull request…" className="shrink-0 grid place-items-center">
                  <Loader2 size={12} className="animate-spin text-neutral-500" />
                </span>
              )}
              {pr
                ? (() => {
                    const { Icon, iconClass, badgeClass } = PR_STYLE[pr.state]
                    return (
                      <HeaderChip
                        onClick={() => void window.api.openExternal(pr.url)}
                        toneClass={badgeClass}
                        className={prRefreshing ? 'opacity-60' : ''}
                        title={`${pr.label} — open pull request #${pr.number} in browser`}
                      >
                        <Icon size={12} className={iconClass} />
                        <span className="opacity-75">#{pr.number}</span>
                        <span className="font-medium">{pr.label}</span>
                        <ExternalLink size={10} className="opacity-70" />
                      </HeaderChip>
                    )
                  })()
                : null}
              {pr ? (
                <PrActionsMenu workspaceId={workspace.id} pr={pr} />
              ) : (
                // 조회 중에는 "Create PR" 을 감춰 깜빡임을 막고 스피너만 보여 준다(끝나면 실제 상태로 결정).
                // gh 미연결이면 버튼을 숨기지 않고 "Connect GitHub" 로 바꿔 기능의 존재를 알린다.
                !prRefreshing && (
                  <HeaderChip
                    onClick={createPr}
                    title={
                      githubDisconnected
                        ? 'Connect GitHub to open a pull request for this branch'
                        : 'Open a pull request for this branch'
                    }
                  >
                    {githubDisconnected ? (
                      <>
                        <GithubMark size={12} />
                        Connect GitHub
                      </>
                    ) : (
                      <>
                        <GitPullRequestCreate size={12} className="text-[var(--accent-400)]" />
                        Create PR
                      </>
                    )}
                  </HeaderChip>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* 외부 병합으로 스택이 stale 해졌을 때의 승인 배너(force-push 는 승인 후에만). */}
      <StackSyncBanner workspace={workspace} />

      {/* PR 이 부모가 아닌 브랜치를 향할 때(에이전트가 --base 없이 연 PR) 되돌릴지 묻는 배너. */}
      <StackBaseBanner workspace={workspace} />

      {/* PR 이 병합돼 할 일이 남지 않았을 때 정리를 제안하는 배너(worktree 제거는 승인 후에만). */}
      <ArchiveSuggestBanner workspace={workspace} />

      {/* 다른 워크스페이스가 보낸 메시지의 승인 배너(전달하면 여기서 턴이 시작된다). */}
      <PeerInboxBanner workspace={workspace} />
      <StackedWaitBanner workspace={workspace} />

      {/* 대화 */}
      <MessageList workspaceId={workspace.id} running={running} />

      {/* 권한 프롬프트 — 답을 받아야 하는 질문(AskUserQuestion)과 계획 승인은 전용 UI 로 분기 */}
      {pending &&
        (pending.toolName === 'AskUserQuestion' ? (
          <QuestionPrompt key={pending.requestId} request={pending} />
        ) : pending.kind === 'plan' ? (
          <PlanPrompt key={pending.requestId} request={pending} />
        ) : (
          <PermissionPrompt request={pending} />
        ))}

      {/* 입력창 바로 위: 일괄 승인 + 다른 세션으로 점프(권한 대기 우선, 그다음 미확인 응답) */}
      {(pendingElsewhereCount > 0 || unreadCount > 0 || approvableCount >= 2) && (
        <div className="px-4">
          <div className="max-w-3xl mx-auto flex justify-end gap-2">
            {approvableCount >= 2 && (
              <button
                onClick={approveAll}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[var(--success-600)]/90 text-white text-xs font-medium hover:bg-[var(--success-500)] shadow-lg"
                title="Approve every pending permission across all workspaces (⇧⌘A)"
              >
                <CircleCheck size={13} />
                Approve all ({approvableCount})
                <kbd className="ml-0.5 rounded bg-white/20 px-1 py-0.5 text-[10px] leading-none font-medium tabular-nums">
                  ⇧⌘A
                </kbd>
              </button>
            )}
            {pendingElsewhereCount > 0 && (
              <button
                onClick={() => {
                  const id = nextPendingPermissionId()
                  if (id) void selectWorkspace(id)
                }}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[var(--warning-500)]/90 text-black text-xs font-medium hover:bg-[var(--warning-400)] shadow-lg"
                title="Jump to a session waiting for permission — ⌘I"
              >
                <ShieldQuestion size={13} />
                Needs input ({pendingElsewhereCount})
                <kbd className="ml-0.5 rounded bg-black/20 px-1 py-0.5 text-[10px] leading-none font-medium tabular-nums">
                  ⌘I
                </kbd>
              </button>
            )}
            {unreadCount > 0 && (
              <button
                onClick={() => {
                  const id = nextUnreadId()
                  if (id) void selectWorkspace(id)
                }}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[var(--info-600)]/90 text-white text-xs font-medium hover:bg-[var(--info-500)] shadow-lg"
                title="Jump to the next session with a completed response — ⌘U"
              >
                <BellDot size={13} />
                Next unread ({unreadCount})
                <kbd className="ml-0.5 rounded bg-white/20 px-1 py-0.5 text-[10px] leading-none font-medium tabular-nums">
                  ⌘U
                </kbd>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 세션 에러 복구 배너 — 네트워크 끊김·에이전트 크래시로 멈췄을 때 재시도/닫기 제공 */}
      {workspace.status === 'error' && !errorDismissed && (
        <div className="px-4 pb-2">
          <div className="max-w-3xl mx-auto flex items-center gap-2.5 rounded-lg border border-[var(--danger-500)]/30 bg-[var(--danger-500)]/10 px-3.5 py-2">
            <AlertTriangle size={15} className="shrink-0 text-[var(--danger-400)]" />
            <span className="flex-1 text-sm text-[var(--danger-200)]">
              The session hit an error and stopped. Retry your last message to reconnect.
            </span>
            <button
              onClick={retryLastMessage}
              className="flex items-center gap-1.5 rounded-md bg-[var(--danger-500)]/90 px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--danger-500)]"
            >
              <RotateCw size={12} />
              Retry last message
            </button>
            <button
              onClick={() => setErrorDismissed(true)}
              aria-label="Dismiss"
              className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-400 hover:text-neutral-100"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* 입력 */}
      <Composer workspace={workspace} />

      {/* 스크립트 패널 — 별도 창으로 떼어 뒀으면 그쪽에서 그린다. */}
      {showScripts && !scriptsDetached && (
        <ScriptPanel
          workspaceId={workspace.id}
          onClose={() => setShowScripts(workspace.id, false)}
        />
      )}

      {showDiff && (
        <DiffModal
          workspaceId={workspace.id}
          baseBranch={workspace.baseBranch}
          onClose={() => setShowDiff(false)}
        />
      )}
    </div>
  )
}
