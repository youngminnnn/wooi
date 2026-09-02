import { useEffect, useRef, useState } from 'react'
import {
  FolderGit2,
  Plus,
  Settings2,
  GitBranch,
  GitBranchPlus,
  Loader2,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronRight,
  Pencil,
  Bell,
  BellOff,
  AlertTriangle,
  RefreshCw,
  LayoutDashboard,
  Layers,
  MoreVertical,
  Users,
  Search,
  GitPullRequest,
  MessagesSquare,
  Copy,
  Download,
  Square,
  GitFork,
  Pin,
  PinOff
} from 'lucide-react'
import { backgroundTaskCount, REVIEW_BUSY_LABEL, useStore } from '../store'
import { useUnarchiveWorkspace } from '../lib/unarchive'
import RowActionsMenu, { type RowAction } from './RowActionsMenu'
import { useAvailableBackends } from '../lib/backends'
import { useMultiAgent } from '../lib/multiAgent'
import { AgentBackendMark, GithubMark } from './BrandIcons'
import { noteMouseSwitch, readUiFlag, repoSettingsSeenFlag, setUiFlag } from '../lib/uiFlags'
import { OPEN_REPO_SETTINGS_EVENT, openRepoSettings } from '../lib/repoSettings'
import { openMigrate } from '../lib/migrate'
import {
  AGENT_BACKEND_LABELS,
  DEFAULT_PEER_INBOUND,
  activeRateLimitPause,
  fanoutGroupOf,
  orderVisibleWorkspaces,
  unresolvedFanoutGroups,
  wasInterrupted,
  workspaceDisplayName,
  workspaceStackRootId
} from '@shared/types'
import { conversationForkDisabledReason } from '../lib/conversationFork'
import { orderRowsWithPending } from '../lib/sidebarRows'
import { useGithubDisconnected } from '../lib/github'
import { askSummary } from '@shared/askSummary'
import { WorkspaceAgents } from './WorkspaceAgents'
import { WorkspaceApiRetry } from './WorkspaceApiRetry'
import { WorkspaceGoal } from './WorkspaceGoal'
import CacheTimer from './CacheTimer'
import { useNow } from '../lib/useNow'
import { formatCountdown, formatDuration } from '../lib/format'
import { useDragReorder, type DragReorder } from '../lib/useDragReorder'
import type {
  AgentBackendId,
  FanoutGroup,
  Repo,
  ReviewSession,
  ReviewStatus,
  Workspace
} from '@shared/types'
import { reviewTitle, STATUS_LABEL } from '../lib/review'
import { OPEN_NEW_WORKSPACE_MENU_EVENT } from '../lib/newWorkspaceMenu'
import { StatusDot } from './StatusDot'
import { resumeTitle, runningFor } from '../lib/workspaceStatus'

// 리포 드래그와 워크스페이스 드래그를 구분하는 dataTransfer 타입. 워크스페이스 행은 리포 블록
// 안에 중첩되므로, 이 타입으로 "지금 끌고 있는 게 무엇인지"를 각 드롭존이 판별한다.
const REPO_MIME = 'application/x-wooi-repo'
const WORKSPACE_MIME = 'application/x-wooi-workspace'

export default function Sidebar({
  width,
  onNewWorkspace,
  onNewFromIssue,
  onNewFromPr,
  onFanout,
  onStackWorkspace,
  onOpenQuickSwitch
}: {
  width: number
  onNewWorkspace: (repoId: string, agentBackend?: AgentBackendId) => void
  onNewFromIssue: (repoId: string) => void
  onNewFromPr: (repoId: string) => void
  /** 같은 프롬프트를 후보 여럿에게 뿌리는 생성 모달을 연다. */
  onFanout: (repoId: string, agentBackend?: AgentBackendId) => void
  onStackWorkspace: (
    repoId: string,
    parentWorkspaceId: string,
    agentBackend?: AgentBackendId
  ) => void
  onOpenQuickSwitch: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const pending = useStore((s) => s.pending)
  const pushToast = useStore((s) => s.pushToast)
  const archiveMergedWorkspaces = useStore((s) => s.archiveMergedWorkspaces)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)
  const prStatus = useStore((s) => s.prStatus)

  const onOverview = selectedId === null

  // 사이드바에 보이는 순서 그대로의 활성 워크스페이스 목록. 번호 배지·⌘K 힌트 조건이 모두 여기서 나온다.
  const ordered = orderVisibleWorkspaces(app.repos, app.workspaces)

  // 리뷰는 워크스페이스와 같은 상태 방송(app.reviews)으로 온다 — 영속되고, 아카이브 구분도
  // 워크스페이스와 똑같이 archived 플래그 하나로 끝난다.
  const activeReviews = app.reviews.filter((r) => !r.archived)
  const archivedReviews = app.reviews.filter((r) => r.archived)
  const reviewRunningCount = activeReviews.filter(
    (r) => r.status === 'preparing' || r.status === 'running'
  ).length
  const repoNameById = new Map(app.repos.map((r) => [r.id, r.name]))

  // Overview·검색은 활성(비아카이브) 워크스페이스가 하나라도 있을 때만 의미가 있다(App.tsx 라우팅과 동일).
  const hasActiveWorkspaces = ordered.length > 0

  // 실행 중인 세션이 하나라도 있으면 1초마다 갱신해 경과 시간을 흐르게 하고("오래 실행 중" 힌트도
  // 같은 틱으로 갱신), 없으면 틱을 멈춰 불필요한 재렌더를 막는다.
  const anyRunningOrRateLimited = app.workspaces.some(
    (w) =>
      !w.archived &&
      (w.status === 'running' ||
        Boolean(w.pendingRateLimitResume) ||
        Boolean(w.pendingShutdownResume) ||
        Boolean(w.rateLimited) ||
        Boolean(w.awaitingStackedWork))
  )
  const now = useNow(1000, anyRunningOrRateLimited)

  // ⌘1–9 단축키(App.tsx)와 똑같은 순서 함수로 번호를 매긴다 — 화면에서 위에서 n번째 행이
  // 항상 ⌘n 이 되도록(레포가 여러 개여도 1,2,3… 순서가 위에서부터 이어진다).
  const shortcutById = new Map<string, number>()
  ordered.slice(0, 9).forEach((w, i) => shortcutById.set(w.id, i + 1))

  // 설정 모달을 한 번이라도 열어 본 리포들. 아직 안 열어 본 리포에만 톱니 옆에 안내 점을 띄운다.
  // 진입 경로가 여러 개(톱니·토스트 액션·⌘K·설정 모달)라 각각에서 표시하지 않고, 공통
  // 이벤트를 여기서 한 번 듣는다.
  // 마운트 시 localStorage 에서 한 번만 읽는다. app.repos 를 deps 로 걸어 매번 다시 만들면
  // (브로드캐스트마다 배열 참조가 새로 온다) 새 Set 때문에 렌더가 한 번씩 더 돈다. 이후 갱신은
  // 아래 이벤트가 맡고, 나중에 추가된 리포는 애초에 플래그가 없어 자연히 점이 붙는다.
  const [seenRepos, setSeenRepos] = useState<Set<string>>(
    () => new Set(app.repos.filter((r) => readUiFlag(repoSettingsSeenFlag(r.id))).map((r) => r.id))
  )
  const [highlightedRepoId, setHighlightedRepoId] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const repoId = (e as CustomEvent<string>).detail
      if (!repoId) return
      setUiFlag(repoSettingsSeenFlag(repoId), true)
      setSeenRepos((s) => (s.has(repoId) ? s : new Set(s).add(repoId)))
    }
    window.addEventListener(OPEN_REPO_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_REPO_SETTINGS_EVENT, onOpen)
  }, [])

  // 키보드로 새 워크스페이스 메뉴를 열면 마우스 포인터가 맥락을 알려 주지 않는다. 대상 리포가
  // 스크롤 밖에 있던 경우에도 어느 리포에서 만드는지 바로 보이도록 헤더를 잠깐 강조한다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onOpen = (e: Event): void => {
      const repoId = (e as CustomEvent<string>).detail
      if (!repoId) return
      setHighlightedRepoId(repoId)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setHighlightedRepoId(null), 1200)
    }
    window.addEventListener(OPEN_NEW_WORKSPACE_MENU_EVENT, onOpen)
    return () => {
      window.removeEventListener(OPEN_NEW_WORKSPACE_MENU_EVENT, onOpen)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // 리포가 하나도 없을 때만 훑어 본다. 들여오기를 권할 자리는 첫 화면 하나뿐이고, 스캔은
  // 리포마다 git 을 부르므로 상시로 돌릴 이유가 없다(리포가 생긴 뒤에는 + 메뉴에 항상 있다).
  const [migratable, setMigratable] = useState(false)
  const noRepos = app.repos.length === 0
  useEffect(() => {
    if (!noRepos) return
    let active = true
    void window.api.migrate
      .scan()
      .then((scan) => {
        if (active) setMigratable(scan.repos.length > 0)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [noRepos])

  const addRepo = async (): Promise<void> => {
    const res = await window.api.repo.add()
    if (res.error) {
      pushToast('error', res.error)
      return
    }
    if (!res.repo) return // 사용자가 폴더 선택을 취소했다.
    // 리포를 막 추가한 이 순간이, 리포별 설정이 존재한다는 걸 알릴 유일하게 자연스러운 시점이다.
    // 특히 carry 목록은 여기서 자동으로 채워지는데(detectCarryItems) 예전에는 아무 말도 하지
    // 않아서, 사용자가 자기 리포에 무엇이 설정됐는지 알 방법이 아예 없었다.
    const carried = res.repo.carryItems.map((i) => i.path)
    pushToast(
      'success',
      carried.length > 0
        ? `Added “${res.repo.name}”. Ignored files found in this repo (${carried.join(
            ', '
          )}) will be copied into every new workspace — new worktrees only contain git-tracked files.`
        : `Added “${res.repo.name}”. Set up its setup / dev / archive commands and which ignored files to carry into new workspaces.`,
      [{ label: 'Open repo settings', run: () => openRepoSettings(res.repo!.id) }]
    )
  }

  const repoDnd = useDragReorder({
    mime: REPO_MIME,
    onReorder: (repoId, targetId, position) =>
      void window.api.repo.reorder(repoId, targetId, position)
  })

  const workspaceDnd = useDragReorder({
    mime: WORKSPACE_MIME,
    // 어느 행을 잡아도 stack 뿌리 전체를 옮긴다. 같은 레포·아카이브·고정 영역이 아닌 곳엔 드롭
    // 표시선을 띄우지 않아, 놓아도 아무 일도 일어나지 않는 자리를 유효한 것처럼 보이지 않는다.
    canDrop: (draggedId, targetId) => {
      const a = app.workspaces.find((w) => w.id === draggedId)
      const b = app.workspaces.find((w) => w.id === targetId)
      if (!a || !b) return false
      const aRoot = workspaceStackRootId(app.workspaces, a.id)
      const bRoot = workspaceStackRootId(app.workspaces, b.id)
      if (!aRoot || !bRoot || aRoot === bRoot) return false
      const ar = app.workspaces.find((w) => w.id === aRoot)
      const br = app.workspaces.find((w) => w.id === bRoot)
      return (
        !!ar &&
        !!br &&
        ar.repoId === br.repoId &&
        ar.archived === br.archived &&
        !!ar.sidebarPinned === !!br.sidebarPinned
      )
    },
    onReorder: (workspaceId, targetId, position) =>
      void window.api.workspace.reorder(workspaceId, targetId, position)
  })

  return (
    <aside
      style={{ width }}
      className="shrink-0 min-w-0 overflow-hidden flex flex-col bg-[var(--bg-2)]"
    >
      {hasActiveWorkspaces && (
        <div className="px-2 pt-2 shrink-0 space-y-0.5">
          <button
            onClick={() => void select(null)}
            aria-current={onOverview ? 'page' : undefined}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
              onOverview
                ? 'bg-[var(--surface-2)] text-neutral-100'
                : 'text-neutral-400 hover:bg-[var(--surface)] hover:text-neutral-200'
            }`}
            title="Overview — all active sessions at a glance"
          >
            <LayoutDashboard size={15} className="shrink-0" />
            <span className="min-w-0 truncate font-medium">Overview</span>
          </button>
          {/* 퀵 스위처의 상시 진입점. 별도 안내문 없이도 ⌘K 의 존재와 용도를 알려 주고,
              키보드 단축키를 모르거나 마우스로 쓰는 경우에도 팔레트에 닿을 수 있게 한다
              (단축키 전용 기능은 정의상 발견 불가능하다). 익히면 자연히 눈에 안 들어오고,
              잊으면 다시 보이므로 닫기 상태를 관리할 필요가 없다. */}
          <button
            onClick={onOpenQuickSwitch}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-neutral-400 hover:bg-[var(--surface)] hover:text-neutral-200 transition-colors"
            title="Search workspaces by name, branch, or repo"
          >
            <Search size={15} className="shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left font-medium">Search workspaces</span>
            <kbd className="shrink-0 text-xs leading-none font-medium text-neutral-600">⌘K</kbd>
          </button>
        </div>
      )}

      <div data-tour="workspaces" className="flex-1 overflow-y-auto px-2 pb-4">
        {/* PR 리뷰는 리포의 자식이 아니라 리포지토리와 동급인 작업 개념이므로 별도 구역으로 둔다.
            또한 ⌘1–9 번호는 orderVisibleWorkspaces(워크스페이스 전용)로 매겨진다 — 리뷰를 리포
            블록 사이에 끼워 넣으면 "위에서 n번째 = ⌘n" 불변식이 깨지므로 워크스페이스 순서에는
            포함하지 않는다. */}
        {app.reviews.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-1 h-10">
              <span className="min-w-0 truncate text-xs uppercase tracking-wider text-neutral-500 font-semibold">
                Reviews
              </span>
              {reviewRunningCount > 0 && (
                <span
                  className="flex items-center gap-1 text-xs text-[var(--info-400)]/80 shrink-0"
                  title={`${reviewRunningCount} running`}
                >
                  <Loader2 size={10} className="animate-spin" />
                  {reviewRunningCount}
                </span>
              )}
            </div>
            <div className="mt-0.5 space-y-0.5">
              {activeReviews.map((session) => (
                <ReviewRow
                  key={session.id}
                  session={session}
                  repoName={repoNameById.get(session.repoId) ?? ''}
                />
              ))}
            </div>
            {archivedReviews.length > 0 && <ArchivedReviewsSection reviews={archivedReviews} />}
          </div>
        )}

        <div
          data-tour="repos"
          className="sticky top-0 z-10 flex items-center justify-between px-1 h-10 bg-[var(--bg-2)]"
        >
          <span className="min-w-0 truncate text-xs uppercase tracking-wider text-neutral-500 font-semibold">
            Repositories
          </span>
          <button
            onClick={addRepo}
            className="h-6 w-6 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            title="Add repository"
          >
            <Plus size={15} />
          </button>
        </div>

        {app.repos.length === 0 && (
          <div className="px-3 py-8 text-xs text-neutral-500 text-center leading-relaxed">
            No repositories yet.
            <br />
            Use the + button above to add a git repo.
            {/* Conductor·Orca 를 쓰던 사람에게는 이 화면이 첫 화면이다. 여기서 알려주지 않으면
                이미 등록해 둔 리포와 worktree 를 손으로 다시 만들게 된다. */}
            {migratable && (
              <button
                onClick={() => openMigrate()}
                className="mt-3 block w-full rounded-lg border border-[var(--border-2)] px-3 py-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
              >
                Import existing worktrees
              </button>
            )}
          </div>
        )}

        {app.repos.map((repo) => {
          const all = app.workspaces.filter((w) => w.repoId === repo.id)
          const active = all.filter((w) => !w.archived)
          const archived = all.filter((w) => w.archived)
          const repoPending = pending.filter((p) => p.repoId === repo.id)
          const runningCount = active.filter((w) => w.status === 'running').length
          const mergedCount = active.filter((w) => prStatus[w.id]?.state === 'merged').length
          return (
            <div
              key={repo.id}
              // 드롭은 블록 전체가 받아 리포 사이 어디에 놓아도 반응하게 하고, 드래그 시작은
              // 헤더만 맡는다. 블록 전체를 draggable 로 만들면 안쪽 이름 편집 입력에서
              // 텍스트를 끌어 선택할 수 없게 된다.
              {...repoDnd.zoneProps(repo.id)}
              style={repoDnd.visualStyle(repo.id)}
              className="mb-3 rounded-md"
            >
              <div
                {...repoDnd.handleProps(repo.id)}
                data-repo-header
                className={`group scroll-mt-10 flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-grab active:cursor-grabbing transition-colors ${
                  highlightedRepoId === repo.id
                    ? 'bg-[var(--surface-2)] ring-1 ring-inset ring-[var(--info-500)]/60'
                    : ''
                }`}
              >
                <RepoIcon repo={repo} />
                <span
                  className="flex-1 truncate text-sm font-medium text-neutral-300"
                  title={`${repo.path}\n(drag to reorder)`}
                >
                  {repo.name}
                </span>
                {runningCount > 0 && (
                  <span
                    className="flex items-center gap-1 text-xs text-[var(--info-400)]/80 shrink-0"
                    title={`${runningCount} running`}
                  >
                    <Loader2 size={10} className="animate-spin" />
                    {runningCount}
                  </span>
                )}
                {mergedCount > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void archiveMergedWorkspaces(repo.id)
                    }}
                    className="h-5 w-5 grid place-items-center rounded text-[var(--merged-400)] hover:bg-[var(--merged-500)]/15 hover:text-[var(--merged-200)]"
                    title={`Archive ${mergedCount} workspace${mergedCount === 1 ? '' : 's'} with merged pull requests`}
                    aria-label={`Archive ${mergedCount} merged workspaces`}
                  >
                    <Archive size={13} />
                  </button>
                )}
                {/* 예전엔 13px·neutral-500 이라 바로 옆 + 버튼(14px·neutral-400)보다도 흐려서,
                    유일한 진입점인데도 눈에 걸리지 않았다. 크기·대비를 + 와 맞춘다.
                    아직 한 번도 열어 보지 않았고 스크립트도 하나도 없는 리포에는 점을 하나
                    띄워 "여기 볼 게 있다"만 알린다 — 일부러 비워 둔 리포를 계속 채근하지
                    않도록, 한 번 열어 보면 조건과 무관하게 사라진다. */}
                <button
                  data-tour="repo-settings"
                  onClick={() => openRepoSettings(repo.id)}
                  className="relative h-5 w-5 grid place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
                  title={`Repository settings — setup / dev / archive commands, and which ignored files (.env, CLAUDE.local.md …) to carry into new workspaces`}
                >
                  <Settings2 size={14} />
                  {!seenRepos.has(repo.id) &&
                    !repo.setupScript.trim() &&
                    repo.runScripts.length === 0 &&
                    !repo.archiveScript.trim() && (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--info-500)]"
                        aria-label="Not configured yet"
                      />
                    )}
                </button>
                <NewWorkspaceButton
                  repoId={repo.id}
                  repoName={repo.name}
                  onNewWorkspace={onNewWorkspace}
                  onNewFromIssue={onNewFromIssue}
                  onNewFromPr={onNewFromPr}
                  onFanout={onFanout}
                />
              </div>

              {/* fan-out 그룹은 워크스페이스 행 위에 따로 놓는다. 행 사이에 끼워 넣으면 ⌘1–9
                  번호가 매겨지는 순서(orderVisibleWorkspaces)와 화면 순서가 어긋난다 — 리뷰
                  구역을 따로 뺀 것과 같은 이유다. 채택이 끝난 그룹은 여기 나오지 않는다. */}
              {unresolvedFanoutGroups(app.fanoutGroups, repo.id).map((group) => (
                <FanoutGroupRow key={group.id} group={group} />
              ))}

              <div className="mt-0.5 space-y-0.5">
                {active.length === 0 && repoPending.length === 0 && (
                  <p className="px-3 py-1 text-xs text-neutral-600">No workspaces</p>
                )}
                {/* 워크스페이스 행의 순서는 orderVisibleWorkspaces 의 정의(레포 순 → 레포 안
                    orderByStack)와 일치해야 한다 — ⌘1–9 번호가 "위에서 n번째" 와 어긋나지 않게
                    하는 불변식이다. 여기 정렬 방식을 바꾸면 shared/types.ts 의
                    orderVisibleWorkspaces 도 같이 고칠 것. (생성 중 자리표시 행은 번호를 받지
                    않고 몇 초 만에 실제 행으로 바뀌므로, 그 사이 한 칸 밀리는 건 감수한다.) */}
                {orderRowsWithPending(active, repoPending).map((row) =>
                  row.kind === 'workspace' ? (
                    <WorkspaceRow
                      key={row.workspace.id}
                      workspace={row.workspace}
                      depth={row.depth}
                      onStackWorkspace={onStackWorkspace}
                      shortcut={shortcutById.get(row.workspace.id)}
                      now={now}
                      dnd={workspaceDnd}
                    />
                  ) : (
                    <PendingRow key={row.pending.id} name={row.pending.name} depth={row.depth} />
                  )
                )}
              </div>

              {archived.length > 0 && <ArchivedSection repoId={repo.id} workspaces={archived} />}
            </div>
          )
        })}

        {/* 목록이 9개를 넘었을 때의 ⌘K 안내, 마우스로만 전환하는 사용자에게 뜨는 ⌘↑/⌘↓ 안내는
            더는 여기서 그리지 않는다 — `lib/hints.ts` 레지스트리로 옮겨 `components/Hint.tsx`
            (App.tsx 에 하나만 마운트되는 호스트)가 대신 그린다. 이 파일은 여전히 마우스 전환
            횟수를 세는 신호(noteMouseSwitch, 아래 WorkspaceRow)만 낸다. */}
      </div>
    </aside>
  )
}

/**
 * 리포 이름 옆 아이콘. GitHub 소유자 아바타(avatarDataUrl)가 있으면 그 이미지를,
 * 없거나 로드에 실패하면 기본 리포 아이콘(FolderGit2)으로 폴백한다.
 */
function RepoIcon({ repo }: { repo: Repo }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (repo.avatarDataUrl && !failed) {
    return (
      <img
        src={repo.avatarDataUrl}
        alt=""
        className="h-4 w-4 rounded-full shrink-0 object-cover"
        onError={() => setFailed(true)}
      />
    )
  }
  return <FolderGit2 size={14} className="text-neutral-500 shrink-0" />
}

function WorkspaceRow({
  workspace,
  depth,
  onStackWorkspace,
  shortcut,
  now,
  dnd
}: {
  workspace: Workspace
  /** stack 트리에서의 들여쓰기 깊이(뿌리=0). */
  depth: number
  onStackWorkspace: (
    repoId: string,
    parentWorkspaceId: string,
    agentBackend?: AgentBackendId
  ) => void
  shortcut?: number
  now: number
  /** 사이드바가 소유한 워크스페이스 재정렬 DnD 배선(stack 단위 자리 교환). */
  dnd: DragReorder
}): React.JSX.Element {
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)
  const git = useStore((s) => s.gitStatus[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  const unread = useStore((s) => s.unread[workspace.id])
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const archiving = useStore((s) => s.archivingWorkspaces[workspace.id] ?? false)
  const archiveWorkspace = useStore((s) => s.archiveWorkspace)
  const runningSince = useStore((s) => s.runningSince[workspace.id])
  const restack = useStore((s) => s.restackWorkspace)
  const restackBusy = useStore(
    (s) => !!s.stackProgress[workspace.id] && !s.stackProgress[workspace.id]!.finished
  )
  const confirm = useStore((s) => s.confirm)
  const reportArchiveScriptFailure = useStore((s) => s.reportArchiveScriptFailure)
  const requestDelete = useStore((s) => s.requestDeleteWorkspace)
  const requireGithub = useStore((s) => s.requireGithub)
  const openStackView = useStore((s) => s.openStackView)
  // 이 행 위에 층이 더 쌓여 있는가. 모델 A 는 살아 있는 자식 워크스페이스, 모델 B 는 워크트리
  // 안의 브랜치 스택이 그 조건이다. 불리언만 돌려주므로 셀렉터가 매 렌더 새 값을 만들지 않는다.
  const isStackParent = useStore(
    (s) =>
      (workspace.stack?.length ?? 0) > 1 ||
      (s.app?.workspaces.some((w) => w.parentWorkspaceId === workspace.id && !w.archived) ?? false)
  )
  const githubDisconnected = useGithubDisconnected()
  // 대기 중인 요청을 **객체째** 집는다 — 예전에는 있는지 없는지(boolean)만 봤지만, 무엇을
  // 묻는지 한 줄로 보여 주려면 요청 자체가 필요하다. 배열 원소를 그대로 돌려주므로 참조가
  // 유지되어 셀렉터가 매 렌더 새 값을 만들지 않는다.
  const pendingRequest = useStore((s) => s.permissions.find((p) => p.workspaceId === workspace.id))
  const awaitingPermission = !!pendingRequest
  const ask = pendingRequest ? askSummary(pendingRequest) : ''
  const interrupted = wasInterrupted(workspace)
  const backgroundTasks = useStore((s) => backgroundTaskCount(s.runningAgents[workspace.id]))
  // null 이 아니면 표시 이름 인라인 편집 중. 초깃값은 현재 표시 이름으로 채운다.
  const [editingName, setEditingName] = useState<string | null>(null)
  // null 이 아니면 오버플로 액션 메뉴가 열려 있고, 값은 메뉴를 띄울 화면 좌표.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  // 'right' = ⋯ 버튼 기준(우측 정렬), 'left' = 우클릭 커서 기준.
  const [menuAlign, setMenuAlign] = useState<'left' | 'right'>('right')

  const active = workspace.id === selectedId
  const stackRootId = useStore((s) => workspaceStackRootId(s.app?.workspaces ?? [], workspace.id))
  const stackPinned = useStore(
    (s) => s.app?.workspaces.find((w) => w.id === stackRootId)?.sidebarPinned ?? false
  )
  // running 인 채로 오래 머무르면(상태 변화 없이) "멈춤일 수 있음" 으로 본다.
  // 계산은 runningFor 한 곳에 있다 — 소비자마다 복제하면 화면끼리 갈라진다.
  const { runningMs, stale } = runningFor(workspace, runningSince, now)
  // 사용량 제한으로 멈춘 상태. 자동 이어가기 예약(pendingRateLimitResume)이 있으면 그쪽이 더 많은
  // 것을 말해 주므로 그 표시를 쓰고, 없을 때(설정 off·예약 종료) 이 표시가 이유를 대신 알린다.
  const rateLimited = activeRateLimitPause(workspace.rateLimited, now)
  // 표시 이름: 사용자 override → PR 제목 → worktree 이름. override 가 없으면 PR 제목이 자동 반영된다.
  const displayName = workspaceDisplayName(workspace, pr?.title)
  const behind = git?.behind ?? 0
  // 뒤처짐은 신호(메타 줄 ↓N)와 1차 액션(오버레이 restack 버튼·⋯ 메뉴에서의 제외)을 함께
  // 좌우한다. 셋이 갈리면 신호는 뜨는데 누를 것이 없거나 같은 액션이 두 곳에 생기므로 한 곳에서 판단한다.
  const isBehind = behind > 0
  // 에이전트 배지와 stack 생성 override 는 같은 사용 가능 목록을 쓴다.
  const availableBackends = useAvailableBackends()
  const showAgent = availableBackends.length > 1
  const forkWorkspace = useStore((s) => s.forkWorkspace)
  const forkDisabledReason = conversationForkDisabledReason(workspace)
  const forkOrigin = useStore((s) =>
    workspace.forkedFromWorkspaceId
      ? s.app?.workspaces.find((w) => w.id === workspace.forkedFromWorkspaceId)
      : undefined
  )
  const forkOriginPr = useStore((s) => (forkOrigin ? s.prStatus[forkOrigin.id] : undefined))

  const commitName = (): void => {
    const name = (editingName ?? '').trim()
    // 비우면 override 가 지워져 기본 규칙(PR 제목 → worktree 이름)으로 돌아간다.
    if (name !== displayName) void window.api.workspace.rename(workspace.id, name)
    setEditingName(null)
  }

  const archive = async (): Promise<void> => {
    const ok = await confirm({
      title: `Archive "${displayName}"?`,
      body: 'Its worktree directory will be removed (branch & history kept). You can unarchive it later.',
      confirmLabel: 'Archive',
      danger: true,
      skipKey: 'archiveWorkspace'
    })
    if (!ok) return
    const { archiveScriptFailure } = await archiveWorkspace(workspace.id)
    reportArchiveScriptFailure(archiveScriptFailure)
  }

  // 팀 여부 — 행 마크와 그 툴팁이 쓴다.
  const multiAgent = useMultiAgent(workspace)

  const fanoutGroup = useStore((s) => fanoutGroupOf(s.app?.fanoutGroups, workspace.id))
  const openFanoutCompare = useStore((s) => s.openFanoutCompare)

  // 행당 액션이 5개까지 늘어나 아이콘을 나열하면 제목 폭을 계속 잠식한다. 그래서 1차 액션
  // (base 보다 뒤처진 워크스페이스의 restack)만 인라인으로 승격하고 나머지는 이 메뉴로 모은다.
  const stack = (agentBackend?: AgentBackendId): void =>
    void requireGithub('Stacked workspaces track their pull requests on GitHub.', () =>
      onStackWorkspace(workspace.repoId, workspace.id, agentBackend)
    )
  const alternateStackBackends = availableBackends.filter((b) => b.id !== workspace.agentBackend)

  const actions: RowAction[] = [
    {
      key: 'pin',
      label: stackPinned ? 'Unpin stack from top' : 'Pin stack to top',
      icon: stackPinned ? <PinOff size={13} /> : <Pin size={13} />,
      onSelect: () => void window.api.workspace.setPinned(workspace.id, !stackPinned)
    },
    {
      key: 'rename',
      label: 'Rename…',
      icon: <Pencil size={13} />,
      onSelect: () => setEditingName(displayName)
    },
    // 이 워크스페이스가 fan-out 후보라면 형제들과 견주는 화면으로 가는 길을 여기에도 둔다 —
    // 그룹 행이 사이드바 위쪽에 따로 있지만, 후보의 대화를 읽다가 "다른 쪽은 어떻게 했지" 가
    // 되는 순간은 바로 이 행 위에서 온다.
    ...(fanoutGroup
      ? [
          {
            key: 'fanout',
            label: `Compare fan-out · ${fanoutGroup.name}`,
            icon: <Copy size={13} />,
            onSelect: () => openFanoutCompare(fanoutGroup.id)
          }
        ]
      : []),
    // 스택은 stacked PR 을 전제로 한 기능이라 gh 가 필요하다 — 미연결이면 라벨을 "Connect GitHub"
    // 로 바꿔 노출하고(숨기지 않는다), 눌렀을 때 연결 모달을 띄운 뒤 이어서 실행한다.
    {
      key: 'stack',
      label: githubDisconnected
        ? 'Stack a new workspace — Connect GitHub'
        : 'Stack a new workspace',
      icon: githubDisconnected ? <GithubMark size={12} /> : <GitBranchPlus size={13} />,
      // agent 를 생략하면 main 의 단일 생성 규칙이 부모 agent 를 상속한다.
      onSelect: () => stack()
    },
    ...alternateStackBackends.map((backend, index): RowAction => ({
      key: `stack-${backend.id}`,
      label: githubDisconnected
        ? `Stack with ${backend.label} — Connect GitHub`
        : `Stack with ${backend.label}`,
      icon: githubDisconnected ? (
        <GithubMark size={12} />
      ) : (
        <AgentBackendMark backend={backend.id} size={13} />
      ),
      onSelect: () => stack(backend.id),
      separatorBefore: index === 0
    })),
    ...(!isBehind
      ? [
          {
            key: 'restack',
            label: restackBusy
              ? 'Rebasing…'
              : githubDisconnected
                ? `Rebase onto ${workspace.baseBranch} — Connect GitHub`
                : `Rebase onto ${workspace.baseBranch}`,
            icon: githubDisconnected ? (
              <GithubMark size={12} />
            ) : (
              <RefreshCw size={13} className={restackBusy ? 'animate-spin' : ''} />
            ),
            onSelect: () => {
              if (restackBusy) return
              void requireGithub('Restacking updates the branch and its pull request.', () =>
                restack(workspace.id)
              )
            }
          }
        ]
      : []),
    {
      key: 'mute',
      label: workspace.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: workspace.muted ? <BellOff size={13} /> : <Bell size={13} />,
      onSelect: () => void window.api.workspace.setMuted(workspace.id, !workspace.muted),
      separatorBefore: true
    },
    // 다른 워크스페이스가 보내는 메시지를 받는 방식. 기본은 협업을 멈추지 않는 자동 전달이고,
    // 여기서 비용·집중이 더 중요한 워크스페이스만 승인 대기나 완전 차단으로 좁힌다.
    {
      key: 'peer-inbound',
      label:
        (workspace.peerInbound ?? DEFAULT_PEER_INBOUND) === 'accept'
          ? 'Require approval for messages'
          : 'Deliver messages automatically',
      icon: <MessagesSquare size={13} />,
      onSelect: () =>
        void window.api.workspace.setPeerInbound(
          workspace.id,
          (workspace.peerInbound ?? DEFAULT_PEER_INBOUND) === 'accept' ? 'hold' : 'accept'
        )
    },
    ...((workspace.peerInbound ?? DEFAULT_PEER_INBOUND) === 'refuse'
      ? [
          {
            key: 'peer-unblock',
            label: 'Allow messages with approval',
            icon: <MessagesSquare size={13} />,
            onSelect: () => void window.api.workspace.setPeerInbound(workspace.id, 'hold')
          }
        ]
      : [
          {
            key: 'peer-refuse',
            label: 'Block workspace messages',
            icon: <BellOff size={13} />,
            onSelect: () => void window.api.workspace.setPeerInbound(workspace.id, 'refuse')
          }
        ]),
    {
      key: 'fork',
      label: 'Fork conversation',
      icon: <GitFork size={13} />,
      onSelect: () => void forkWorkspace(workspace.id),
      disabledReason: forkDisabledReason ?? undefined
    },
    {
      key: 'archive',
      label: 'Archive workspace',
      icon: <Archive size={13} />,
      onSelect: () => void archive(),
      danger: true,
      separatorBefore: true,
      shortcut: '⇧⌘⌫'
    },
    // 아카이브 바로 아래 둔다 — "이 워크스페이스를 치운다" 는 같은 갈래의 선택지이고,
    // 되돌릴 수 없는 쪽을 찾으려고 다른 곳을 뒤지게 만들 이유가 없다.
    {
      key: 'delete',
      label: 'Delete workspace…',
      icon: <Trash2 size={13} />,
      onSelect: () => void requestDelete(workspace.id),
      danger: true,
      shortcut: '⌥⌘⌫'
    }
  ]

  const toggleMenuFromButton = (e: React.MouseEvent): void => {
    if (menuAt) {
      setMenuAt(null)
      return
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuAlign('right')
    setMenuAt({ x: r.right, y: r.bottom + 4 })
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        {...dnd.handleProps(workspace.id)}
        {...dnd.zoneProps(workspace.id)}
        // 이름 편집 중엔 드래그를 끈다 — draggable 조상 안에서는 입력 텍스트를 끌어 선택할 수 없다.
        draggable={editingName === null}
        onClick={() => {
          void select(workspace.id)
          // 마우스로만 전환하는 사용자에게만 ⌘↑/⌘↓ 힌트를 띄우기 위한 신호.
          noteMouseSwitch()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void select(workspace.id)
          }
        }}
        // 우클릭은 ⋯ 버튼을 찾지 않아도 같은 메뉴에 닿는 파워 유저 경로다(폭 비용 0).
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAlign('left')
          setMenuAt({ x: e.clientX, y: e.clientY })
        }}
        // stacked 워크스페이스는 깊이만큼 들여써 부모-자식 계층을 시각화한다(뿌리=기본 들여쓰기).
        style={{ paddingLeft: 12 + depth * 14, ...dnd.visualStyle(workspace.id) }}
        className={
          'group/ws relative w-full flex items-center gap-2 pr-1.5 py-1.5 rounded-md text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)] ' +
          // 선택 행은 좌측에 파란 액센트 바를 띄워 현재 위치를 또렷하게 표시한다.
          (active
            ? 'bg-[var(--surface-3)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--info-500)]'
            : // 키보드로 액션에 포커스가 들어오거나 메뉴가 열려 있으면, 오버레이 배경색과 어긋나지
              // 않게 행도 같이 밝힌다(메뉴를 띄운 뒤 커서가 행을 벗어나도 대상이 유지돼 보인다).
              'hover:bg-[var(--surface)] focus-within:bg-[var(--surface)] ' +
              (menuAt ? 'bg-[var(--surface)]' : ''))
        }
      >
        {archiving ? (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-neutral-400"
            aria-label="Archiving workspace"
          />
        ) : (
          <StatusDot
            status={workspace.status}
            awaitingPermission={awaitingPermission}
            ask={ask}
            interrupted={interrupted}
            compacting={compacting}
            stale={stale}
            runningMs={runningMs}
            pendingRateLimitResume={workspace.pendingRateLimitResume}
            pendingShutdownResume={workspace.pendingShutdownResume}
            awaitingStackedWork={workspace.awaitingStackedWork}
            rateLimited={rateLimited}
            backgroundTasks={backgroundTasks}
            pr={pr}
          />
        )}
        {stackPinned && depth === 0 && (
          <Pin size={11} className="shrink-0 text-neutral-500" aria-label="Pinned to top" />
        )}
        <div className="relative flex-1 min-w-0">
          {editingName !== null ? (
            <input
              autoFocus
              value={editingName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                // 행의 Enter/Space=선택 핸들러로 전파되지 않게 막는다.
                e.stopPropagation()
                if (e.key === 'Enter') commitName()
                else if (e.key === 'Escape') setEditingName(null)
              }}
              className="w-full text-sm text-neutral-100 bg-[var(--surface)] border border-[var(--border-strong)] rounded px-1 py-0 outline-none"
            />
          ) : (
            // 예전엔 옆에 호버용 연필 버튼이 있었지만, 그것도 opacity-0 로 폭(≈15px)을 상시
            // 점유했다. 이름 변경은 더블클릭 · ⋯ 메뉴 · 우클릭 세 경로로 닿을 수 있어 제거했다.
            <div
              className={
                'truncate text-sm cursor-text ' + (active ? 'text-neutral-100' : 'text-neutral-300')
              }
              title={`${displayName}\n(double-click to rename · clear to reset)`}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditingName(displayName)
              }}
            >
              {displayName}
            </div>
          )}
          <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
            {archiving && (
              <span className="shrink-0 text-neutral-400" title="Running archive cleanup">
                Archiving…
              </span>
            )}
            {/* 어떤 에이전트가 이 워크스페이스를 돌리는지. 생성 시 고정되고 바꿀 수 없으므로,
                여러 개를 병렬로 돌릴 때 어느 쪽인지 한눈에 보여야 한다. 에이전트가 하나뿐인
                사용자에게는 정보가 아니라 잡음이라 감춘다.
                멀티 에이전트면 마크 옆에 사람 아이콘을 붙여 "이 마크는 메인일 뿐이고 다른 종류도
                돈다"를 알린다 — 마크만 보고 단일 에이전트로 오해하지 않게 한다. */}
            {!archiving && showAgent && (
              <span
                className="shrink-0 flex items-center gap-0.5 text-neutral-500"
                title={
                  multiAgent.active
                    ? `Multi-agent — ${AGENT_BACKEND_LABELS[workspace.agentBackend]} is the main agent and can run subagents on ${multiAgent.others
                        .map((b) => AGENT_BACKEND_LABELS[b])
                        .join(', ')}`
                    : `Running on ${AGENT_BACKEND_LABELS[workspace.agentBackend]}`
                }
              >
                <AgentBackendMark backend={workspace.agentBackend} size={10} />
                {/* 멀티 에이전트 표시. 마크를 종류마다 하나씩 늘어놓지 않는 이유는 확장성이다 —
                    에이전트가 셋 이상이면 10px 안에서 뭉갠다. 이 글리프 하나가 개수와 무관하게
                    "메인 말고도 더 있다" 를 말하고, 무엇이 있는지는 툴팁이 답한다.
                    색 처리는 index.css 참고(왜 배경이 아니라 색인지, 왜 파랑이 아닌지 적혀 있다). */}
                {multiAgent.active && <Users size={10} className="multi-agent-mark" />}
              </span>
            )}
            {!archiving && forkOrigin && (
              <span
                className="shrink-0 truncate"
                title={`Forked from ${workspaceDisplayName(forkOrigin, forkOriginPr?.title)}`}
              >
                ⑂ from {workspaceDisplayName(forkOrigin, forkOriginPr?.title)} ·
              </span>
            )}
            {!archiving && <GitBranch size={10} className="shrink-0" />}
            {!archiving && <span className="truncate">{workspace.branch}</span>}
            {/* behind 신호를 맡겼던 restack 버튼은 호버 전용이라 평상시에는 뒤처짐을 알 수 없어
                ↓N 을 되살렸다. ahead 는 행 폭을 잠식하는 데 비해 여기서 행동으로 이어지지 않아
                의도적으로 되살리지 않는다. */}
            {isBehind && (
              <span
                className="text-[var(--warning-400)]/90 shrink-0 tabular-nums"
                title={`${behind} commit(s) behind ${workspace.baseBranch}`}
              >
                · ↓{behind}
              </span>
            )}
            {git && git.conflicted && (
              <span className="text-[var(--danger-fg)] shrink-0" title="Merge conflicts">
                ⚠
              </span>
            )}
            {workspace.status === 'running' && runningSince && (
              <span
                className="text-[var(--info-400)]/80 shrink-0 tabular-nums"
                title="Running time of the current turn"
              >
                · {formatDuration(now - runningSince)}
              </span>
            )}
            <CacheTimer workspace={workspace} dot />
            {workspace.pendingShutdownResume ? (
              <span
                className="text-[var(--warning-400)]/90 shrink-0"
                title="Interrupted by shutdown"
              >
                · interrupted by shutdown — send a message to continue
              </span>
            ) : workspace.pendingRateLimitResume ? (
              <span
                className="text-[var(--warning-400)]/90 shrink-0 tabular-nums"
                title={resumeTitle(workspace.pendingRateLimitResume)}
              >
                {/* 네트워크가 없어 기다리는 중에는 카운트다운이 거짓말이 된다 — 연결이 언제
                    돌아올지는 우리가 모른다. 그때는 무엇을 기다리는지만 말한다. */}
                {workspace.pendingRateLimitResume.blocked === 'offline' ? (
                  <>
                    ·{' '}
                    {workspace.pendingRateLimitResume.cause === 'connection'
                      ? 'no connection'
                      : 'rate limit'}{' '}
                    · waiting for network
                  </>
                ) : (
                  <>
                    ·{' '}
                    {workspace.pendingRateLimitResume.cause === 'connection'
                      ? 'no connection'
                      : 'rate limit'}{' '}
                    · resumes in {formatCountdown(workspace.pendingRateLimitResume.retryAt - now)}
                  </>
                )}
              </span>
            ) : // 자동 이어가기가 꺼져 있어도 제한에 걸린 사실은 보여 준다 — 그러지 않으면 그냥
            // idle 로 보여서, 사용자는 왜 멈췄는지 워크스페이스에 들어가 봐야만 알 수 있다.
            rateLimited ? (
              <span
                className="text-[var(--warning-400)]/90 shrink-0 tabular-nums"
                title={
                  rateLimited.resetsAt
                    ? `Stopped by the usage limit — resets at ${new Date(rateLimited.resetsAt).toLocaleString()}`
                    : 'Stopped by the usage limit'
                }
              >
                · rate limit
                {rateLimited.resetsAt
                  ? ` · resets in ${formatCountdown(rateLimited.resetsAt - now)}`
                  : ''}
              </span>
            ) : workspace.awaitingStackedWork ? (
              <span
                className="text-neutral-400 shrink-0 tabular-nums"
                title={`Waiting for ${workspace.awaitingStackedWork.targets.length} stacked workspaces until ${new Date(workspace.awaitingStackedWork.deadlineAt).toLocaleString()}`}
              >
                · waiting on {workspace.awaitingStackedWork.targets.length} ·{' '}
                {formatCountdown(workspace.awaitingStackedWork.deadlineAt - now)} left
              </span>
            ) : null}
          </div>
          {/* 무엇을 묻고 있는지 한 줄. 방패 아이콘만으로는 "yes 만 치면 되는 것" 과 "앉아서 봐야
              하는 설계 결정" 이 구분되지 않아, 여럿이 동시에 물으면 전부 열어 봐야 우선순위를
              정할 수 있었다. 메타 줄에 끼워 넣지 않고 줄을 따로 쓰는 이유는 그 줄이 이미
              브랜치·뒤처짐·시간으로 빽빽해서, 여기 붙이면 둘 다 못 읽게 되기 때문이다. */}
          {ask && (
            <div className="mt-0.5 truncate text-xs text-[var(--warning-400)]/90" title={ask}>
              {ask}
            </div>
          )}
          {/* 액션 클러스터는 absolute 오버레이로 띄운다. 호버 전용 컨트롤이 평상시 레이아웃 폭을
            점유하지 않게 해서 제목/메타가 사이드바 폭을 온전히 쓰도록 하는 것이 핵심이다.
            display 대신 opacity 로만 감추므로 Tab 포커스 경로도 그대로 유지된다.
            좌측 그라데이션으로 밑에 깔린 텍스트를 자연스럽게 페이드아웃시킨다. */}
          <div
            className={
              'absolute right-0 top-0 bottom-0 flex items-center gap-0.5 pl-8 ' +
              // 메뉴가 열려 있는 동안은 커서가 행을 벗어나도 계속 보이게 고정한다.
              (menuAt
                ? 'opacity-100'
                : 'opacity-0 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100')
            }
            // 페이드는 pl-8(32px) 리드인 구간에서만 일어나고 그 뒤는 완전 불투명해야 한다.
            // Tailwind 의 via-* 는 정지점이 50% 라서 아이콘 뒤가 반투명해지고 제목이 비쳐 겹친다.
            style={{
              background: `linear-gradient(to right, transparent 0, ${
                active ? 'var(--surface-3)' : 'var(--surface)'
              } 32px)`
            }}
          >
            {/* base 보다 뒤처졌으면 root/stacked 구분 없이 restack 을 1차 액션으로 승격한다.
              (뒤처지지 않았으면 급하지 않으므로 ⋯ 메뉴 안에만 둔다.) */}
            {isBehind && (
              <button
                disabled={restackBusy}
                onClick={(e) => {
                  e.stopPropagation()
                  void requireGithub('Restacking updates the branch and its pull request.', () =>
                    restack(workspace.id)
                  )
                }}
                className="h-6 w-6 grid place-items-center rounded shrink-0 hover:bg-[var(--surface-2)] text-[var(--warning-400)] hover:text-[var(--warning-300)] disabled:opacity-60"
                aria-label={`Rebase onto ${workspace.baseBranch}`}
                title={
                  githubDisconnected
                    ? `Connect GitHub to restack onto ${workspace.baseBranch} (${behind} behind)`
                    : `Restack onto ${workspace.baseBranch} (${behind} behind) — rebase & force-push`
                }
              >
                <RefreshCw size={12} className={restackBusy ? 'animate-spin' : ''} />
              </button>
            )}
            {/* 스택의 부모 행에서만 지도를 연다 — 아래 층이 없으면 펼칠 스택이 없다.
              들여쓰기는 "무엇이 무엇 위에 있는가" 만 말해 주므로, 어긋남·behind·트레인까지
              한 화면에서 보려면 여기서 들어간다. */}
            {isStackParent && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  openStackView(workspace.id)
                }}
                className="h-6 w-6 grid place-items-center rounded shrink-0 text-[var(--accent-400)] hover:bg-[var(--surface-2)] hover:text-[var(--accent-300)]"
                aria-label="Show this stack"
                title="Show this stack (⇧⌘L) — every layer, its PR, drift and merge train"
              >
                <Layers size={12} />
              </button>
            )}
            <button
              data-row-actions-trigger
              onClick={(e) => {
                e.stopPropagation()
                toggleMenuFromButton(e)
              }}
              aria-haspopup="menu"
              aria-expanded={menuAt !== null}
              className="h-6 w-6 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0"
              title="More actions (or right-click the row)"
            >
              <MoreVertical size={14} />
            </button>
          </div>
        </div>
        {/* 상태 인디케이터는 "정보"이므로 고정 슬롯을 갖고, 액션 오버레이에 가려지지 않는다.
          (예전에는 호버 시 group-hover:hidden 으로 사라져서, 음소거 여부를 확인하면서
          음소거 버튼을 누를 수 없었다.) 아이콘 간 간격은 좁혀 하나의 묶음으로 읽히게 한다. */}
        {(shortcut !== undefined ||
          (unread && !active) ||
          workspace.muted ||
          (workspace.peerInbox?.length ?? 0) > 0) && (
          <div className="shrink-0 flex items-center gap-1.5">
            {shortcut !== undefined && (
              <kbd
                className="text-xs leading-none font-medium text-neutral-600 tabular-nums"
                title={`Switch with ⌘${shortcut}`}
              >
                ⌘{shortcut}
              </kbd>
            )}
            {/* 미확인 완료는 권한 대기·실행 중과 별개의 상태이므로, 좌측 상태 점과 함께 같이 보여 준다
              (좌측 StatusDot 이 권한 대기/실행/압축을 표시하고, 우측 파란 점이 미확인 응답을 표시). */}
            {unread && !active && (
              <span
                className="h-2 w-2 rounded-full bg-[var(--info-500)]"
                title="Completed response — unread"
              />
            )}
            {/* 다른 워크스페이스가 보낸 메시지가 승인을 기다린다. 배너는 이 워크스페이스를 열어야
                보이므로, 열지 않은 채로도 알아챌 수 있는 자리가 여기뿐이다. */}
            {(workspace.peerInbox?.length ?? 0) > 0 && (
              <MessagesSquare
                size={12}
                className="text-[var(--info-400)]"
                aria-label="Message waiting from another workspace"
              />
            )}
            {workspace.muted && (
              <BellOff size={12} className="text-neutral-600" aria-label="Notifications muted" />
            )}
          </div>
        )}
        {menuAt && (
          <RowActionsMenu
            at={menuAt}
            align={menuAlign}
            actions={actions}
            onClose={() => setMenuAt(null)}
          />
        )}
      </div>
      {/* 행 안이 아니라 형제로 둔다 — 행은 role="button" 인 클릭·드래그 영역이라, 그 안에 접기
          버튼을 중첩하면 클릭이 워크스페이스 선택으로 새고 드래그 정렬과도 충돌한다. */}
      <WorkspaceApiRetry workspaceId={workspace.id} depth={depth} />
      <WorkspaceAgents
        workspaceId={workspace.id}
        depth={depth}
        backend={workspace.agentBackend}
        now={now}
      />
      <WorkspaceGoal workspaceId={workspace.id} depth={depth} />
    </>
  )
}

/** worktree 생성이 끝날 때까지 보여주는 비활성 자리표시 행. 완료되면 실제 WorkspaceRow 로 교체된다. */
/**
 * PR 리뷰 세션 1건. 워크스페이스 행과 같은 선택·호버 문법을 쓰되, 좌측 아이콘과 `#번호` 로
 * "이건 리뷰다" 를 구분한다. 드래그 정렬에는 참여하지 않는다(세션은 순서가 의미 없다).
 */
function ReviewRow({
  session,
  repoName
}: {
  session: ReviewSession
  repoName: string
}): React.JSX.Element {
  const active = useStore((s) => s.activeReviewId === session.id)
  const openReview = useStore((s) => s.openReview)
  const requestCloseReview = useStore((s) => s.requestCloseReview)
  const requestArchiveReview = useStore((s) => s.requestArchiveReview)
  // 아카이브·삭제는 워크트리와 ref 를 지우느라 초 단위로 걸린다. 그동안 레코드는 그대로 방송되어
  // 행이 멀쩡히 남아 있으므로, 표시가 없으면 눌리지 않은 줄 알고 다시 누른다(워크스페이스와 같은 처방).
  const busy = useStore((s) => s.busyReviews[session.id])
  // 워크스페이스 행과 같은 규칙 — 에이전트가 하나뿐이면 정보가 아니라 잡음이다.
  const showAgent = useAvailableBackends().length > 1

  const { id } = session
  // 스택 리뷰는 맨 위 PR 로 이름을 삼는다(가장 늦게 병합돼 오래 남는다).
  const { number: prNumber, title: prTitle } = reviewTitle(session)
  const layerCount = session.layers.length

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openReview(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openReview(id)
        }
      }}
      style={{ paddingLeft: 12 }}
      className={
        'group/rev relative w-full flex items-center gap-2 pr-1.5 py-1.5 rounded-md text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)] ' +
        (active
          ? 'bg-[var(--surface-3)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--info-500)]'
          : 'hover:bg-[var(--surface)] focus-within:bg-[var(--surface)]')
      }
    >
      {busy ? (
        <Loader2
          size={12}
          className="shrink-0 animate-spin text-neutral-400"
          aria-label={REVIEW_BUSY_LABEL[busy]}
        />
      ) : (
        <ReviewStatusDot status={session.status} />
      )}
      <div className="flex-1 min-w-0">
        <div
          className={'truncate text-sm ' + (active ? 'text-neutral-100' : 'text-neutral-300')}
          title={prTitle}
        >
          {prTitle}
        </div>
        <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
          {busy && <span className="shrink-0 text-neutral-400">{REVIEW_BUSY_LABEL[busy]}</span>}
          {!busy && showAgent && (
            <span className="shrink-0 text-neutral-500">
              <AgentBackendMark backend={session.agentBackend} size={10} />
            </span>
          )}
          <span className="shrink-0 tabular-nums">#{prNumber}</span>
          {/* 스택 리뷰인 것은 목록에서 바로 보여야 한다 — 열어 보고 나서야 아는 것과
              "이건 4개짜리 스택" 을 알고 여는 것은 다르다. */}
          {layerCount > 1 && (
            <span
              className="shrink-0 flex items-center gap-0.5 text-[var(--accent-300)]"
              title={`Stack of ${layerCount}: ${session.layers.map((l) => `#${l.prNumber}`).join(' → ')}`}
            >
              <Layers size={9} />
              {layerCount}
            </span>
          )}
          {repoName && <span className="truncate">{repoName}</span>}
        </div>
      </div>

      {/* 워크스페이스 행과 같은 방식 — 호버 액션은 절대 배치라 평소 폭을 차지하지 않는다. */}
      <div
        className="absolute right-0 top-0 bottom-0 flex items-center gap-0.5 pl-8 opacity-0 group-hover/rev:opacity-100 group-focus-within/rev:opacity-100"
        style={{
          background: `linear-gradient(to right, transparent 0, ${
            active ? 'var(--surface-3)' : 'var(--surface)'
          } 32px)`
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation()
            void requestArchiveReview(id)
          }}
          disabled={!!busy}
          className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          title={
            busy ? REVIEW_BUSY_LABEL[busy] : 'Archive (keeps the findings, removes the worktree)'
          }
        >
          <Archive size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            void requestCloseReview(id)
          }}
          disabled={!!busy}
          className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)] shrink-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          title={busy ? REVIEW_BUSY_LABEL[busy] : 'Delete review permanently'}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* 확인하지 않은 새 활동(답글·커밋). 워크스페이스의 미확인 점과 같은 어휘. */}
      {session.unread && !active && (
        <span
          className="h-2 w-2 rounded-full bg-[var(--info-500)] shrink-0"
          title="New replies or commits since you last looked"
        />
      )}
    </div>
  )
}

/**
 * 아카이브된 리뷰. 워크스페이스의 ArchivedSection 과 같은 모양·같은 규칙이다
 * (접힌 채로 시작, 호버로 되살리기/삭제 노출).
 */
function ArchivedReviewsSection({ reviews }: { reviews: ReviewSession[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)

  const removeAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete all ${reviews.length} archived reviews?`,
      body: 'This permanently removes their findings, conversations, and review refs, and cannot be undone.',
      confirmLabel: 'Delete all',
      danger: true
    })
    if (!ok) return
    const { count } = await window.api.review.removeArchived()
    if (count > 0) pushToast('info', `Deleted ${count} archived reviews.`)
  }

  return (
    <div className="mt-1">
      <div className="group/arcrevsec flex items-center">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-1 px-2 py-1 text-xs text-neutral-600 hover:text-neutral-400"
        >
          <ChevronRight size={11} className={open ? 'rotate-90 transition' : 'transition'} />
          Archived ({reviews.length})
        </button>
        <button
          onClick={removeAll}
          className="opacity-0 group-hover/arcrevsec:opacity-100 focus-visible:opacity-100 mr-1.5 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
          title="Delete all archived reviews"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {open && (
        <div className="space-y-0.5">
          {reviews.map((r) => (
            <ArchivedReviewRow key={r.id} session={r} />
          ))}
        </div>
      )}
    </div>
  )
}

function ArchivedReviewRow({ session }: { session: ReviewSession }): React.JSX.Element {
  const unarchiveReview = useStore((s) => s.unarchiveReview)
  const requestCloseReview = useStore((s) => s.requestCloseReview)
  // 되살리기는 워크트리를 다시 만들고 필요하면 원격에서 커밋까지 받아 온다 — 리뷰 정리 동작 중
  // 가장 오래 걸리는 쪽이라, 여기야말로 도는 티가 나야 한다.
  const busy = useStore((s) => s.busyReviews[session.id])

  return (
    <div className="group/arcrev flex items-center gap-2 pl-6 pr-1.5 py-1 rounded-md hover:bg-[var(--surface)]">
      {busy && <Loader2 size={11} className="shrink-0 animate-spin text-neutral-400" />}
      <span className="flex-1 truncate text-xs text-neutral-500" title={reviewTitle(session).title}>
        #{reviewTitle(session).number} {reviewTitle(session).title}
      </span>
      {busy && <span className="shrink-0 text-xs text-neutral-400">{REVIEW_BUSY_LABEL[busy]}</span>}
      <button
        onClick={() => void unarchiveReview(session.id)}
        disabled={!!busy}
        className="opacity-0 group-hover/arcrev:opacity-100 focus-visible:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        title={busy ? REVIEW_BUSY_LABEL[busy] : 'Unarchive (recreate the review worktree)'}
      >
        <ArchiveRestore size={12} />
      </button>
      <button
        onClick={() => void requestCloseReview(session.id)}
        disabled={!!busy}
        className="opacity-0 group-hover/arcrev:opacity-100 focus-visible:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)] disabled:cursor-not-allowed disabled:opacity-40"
        title={busy ? REVIEW_BUSY_LABEL[busy] : 'Delete permanently'}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

/** 리뷰 상태를 StatusDot 과 같은 어휘로 표현한다(실행=스피너, 오류=경고, 그 외=아이콘/점). */
function ReviewStatusDot({ status }: { status: ReviewStatus }): React.JSX.Element {
  const title = STATUS_LABEL[status]
  if (status === 'preparing' || status === 'running') {
    return (
      <span title={title} className="shrink-0 grid place-items-center">
        <Loader2 size={13} className="text-[var(--info-400)] animate-spin" />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span title={title} className="shrink-0 grid place-items-center">
        <AlertTriangle size={12} className="text-[var(--danger-400)]" />
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span title={title} className="shrink-0 grid place-items-center">
        <Square size={11} fill="currentColor" className="text-neutral-600" />
      </span>
    )
  }
  return (
    <span title={title} className="shrink-0 grid place-items-center">
      <GitPullRequest size={13} className="text-[var(--success-400)]" />
    </span>
  )
}

function PendingRow({ name, depth }: { name: string; depth: number }): React.JSX.Element {
  return (
    // 들여쓰기는 WorkspaceRow 와 같은 식(12 + depth * 14)이라야 부모 밑에 줄이 맞는다.
    <div
      style={{ paddingLeft: 12 + depth * 14 }}
      className="w-full flex items-center gap-2 pr-1.5 py-1.5 rounded-md text-left opacity-70 select-none"
    >
      <Loader2 size={13} className="text-[var(--info-400)] animate-spin shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm text-neutral-300">{name || 'Creating…'}</div>
        <div className="text-xs text-neutral-500 truncate">Setting up worktree…</div>
      </div>
    </div>
  )
}

function ArchivedSection({
  repoId,
  workspaces
}: {
  repoId: string
  workspaces: Workspace[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)

  // 일괄 삭제: 이 레포의 아카이브된 워크스페이스를 모두 영구 제거한다.
  const removeAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete all ${workspaces.length} archived workspaces?`,
      body: 'This permanently removes their history and branches, and cannot be undone.',
      confirmLabel: 'Delete all',
      danger: true
    })
    if (!ok) return
    const { count } = await window.api.workspace.removeArchived(repoId)
    if (count > 0) pushToast('info', `Deleted ${count} archived workspaces.`)
  }

  return (
    <div className="mt-1">
      <div className="group/arcsec flex items-center">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-1 px-2 py-1 text-xs text-neutral-600 hover:text-neutral-400"
        >
          <ChevronRight size={11} className={open ? 'rotate-90 transition' : 'transition'} />
          Archived ({workspaces.length})
        </button>
        <button
          onClick={removeAll}
          className="opacity-0 group-hover/arcsec:opacity-100 focus-visible:opacity-100 mr-1.5 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
          title="Delete all archived workspaces"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {open && (
        <div className="space-y-0.5">
          {workspaces.map((ws) => (
            <ArchivedRow key={ws.id} workspace={ws} />
          ))}
        </div>
      )}
    </div>
  )
}

function ArchivedRow({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const select = useStore((s) => s.selectWorkspace)
  const selected = useStore((s) => s.selectedWorkspaceId === workspace.id)
  const confirm = useStore((s) => s.confirm)
  const deleteWorkspaceNow = useStore((s) => s.deleteWorkspaceNow)
  const unarchiveWorkspace = useUnarchiveWorkspace()

  const unarchive = (): void => void unarchiveWorkspace(workspace)

  // 아카이브 시 표시 이름(PR 제목 등)을 displayName 에 보존하므로, PR 정보 없이도 같은 이름을 보여 준다.
  const displayName = workspaceDisplayName(workspace)

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Permanently delete "${displayName}"?`,
      body: 'This removes its history and branch, and cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await deleteWorkspaceNow(workspace.id)
  }

  return (
    <div
      className={`group/arc flex items-center gap-2 pl-6 pr-1.5 py-1 rounded-md ${
        selected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface)]'
      }`}
    >
      {/* 행을 눌러 대화를 읽기 전용으로 연다 — 되살릴지 판단하려면 안을 봐야 한다. */}
      <button
        onClick={() => void select(workspace.id)}
        title={`${displayName} — ${workspace.branch}`}
        className={`flex-1 min-w-0 text-left truncate text-xs ${
          selected ? 'text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'
        }`}
      >
        {displayName}
      </button>
      <button
        onClick={unarchive}
        className="opacity-0 group-hover/arc:opacity-100 focus-visible:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        title="Unarchive (recreate worktree)"
      >
        <ArchiveRestore size={12} />
      </button>
      <button
        onClick={remove}
        className="opacity-0 group-hover/arc:opacity-100 focus-visible:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
        title="Delete permanently"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

/**
 * fan-out 그룹 한 줄 — 후보들을 형제로 묶어 보여 주고, 누르면 비교 화면을 연다.
 *
 * 후보들은 워크스페이스 목록에도 각자 자기 행으로 그대로 나온다. 여기가 더하는 것은 **묶여
 * 있다는 사실과 서로의 진행 상황**이다: 어느 후보가 아직 돌고 있고 어느 쪽이 얼마나 고쳤는지를
 * 한 자리에서 견줄 수 없으면, 비교 화면을 열어 볼 시점 자체를 알 수 없다.
 */
function FanoutGroupRow({ group }: { group: FanoutGroup }): React.JSX.Element | null {
  const workspaces = useStore((s) => s.app?.workspaces)
  const open = useStore((s) => s.openFanoutCompare)
  const active = useStore((s) => s.activeFanoutGroupId === group.id)

  const candidates = group.workspaceIds
    .map((id) => workspaces?.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w)
  if (candidates.length === 0) return null

  const running = candidates.filter((w) => !w.archived && w.status === 'running').length

  return (
    <div className="mt-0.5 mb-1 rounded-md border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => open(group.id)}
        aria-current={active ? 'page' : undefined}
        title={`Compare the ${candidates.length} candidates of “${group.name}”`}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm transition-colors ${
          active
            ? 'bg-[var(--surface-2)] text-neutral-100'
            : 'text-neutral-300 hover:bg-[var(--surface)]'
        }`}
      >
        <Copy size={13} className="shrink-0 text-neutral-500" />
        <span className="flex-1 min-w-0 truncate text-left font-medium">{group.name}</span>
        {running > 0 ? (
          <span className="flex items-center gap-1 shrink-0 text-xs text-[var(--info-400)]/80">
            <Loader2 size={10} className="animate-spin" />
            {running}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-neutral-600">{candidates.length}</span>
        )}
      </button>
      <div className="border-t border-[var(--border)]">
        {candidates.map((w, i) => (
          <FanoutCandidateLine key={w.id} workspace={w} index={i} />
        ))}
      </div>
    </div>
  )
}

/** 그룹 안의 후보 한 줄 — 실행 상태와 base 대비 요약(N changed · ↑ahead)을 나란히 놓는다. */
function FanoutCandidateLine({
  workspace,
  index
}: {
  workspace: Workspace
  index: number
}): React.JSX.Element {
  const git = useStore((s) => s.gitStatus[workspace.id])
  const select = useStore((s) => s.selectWorkspace)
  const selected = useStore((s) => s.selectedWorkspaceId === workspace.id)

  return (
    <button
      onClick={() => void select(workspace.id)}
      title={`Open ${workspaceDisplayName(workspace)}`}
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
        selected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface)]'
      }`}
    >
      <span className="shrink-0 w-3 text-right text-neutral-600">{index + 1}</span>
      {workspace.archived ? (
        <Archive size={10} className="shrink-0 text-neutral-600" />
      ) : workspace.status === 'running' ? (
        <Loader2 size={10} className="shrink-0 animate-spin text-[var(--info-400)]" />
      ) : workspace.status === 'error' ? (
        <AlertTriangle size={10} className="shrink-0 text-[var(--danger-400)]" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-600" />
      )}
      <span
        className={`flex-1 min-w-0 truncate text-left ${
          workspace.archived ? 'text-neutral-600 line-through' : 'text-neutral-400'
        }`}
      >
        {workspaceDisplayName(workspace)}
      </span>
      {!workspace.archived && (
        <span className="shrink-0 text-neutral-600">
          {git?.changedFiles ? `${git.changedFiles} changed` : ''}
          {git?.changedFiles && git?.ahead ? ' · ' : ''}
          {git?.ahead ? `↑${git.ahead}` : ''}
        </span>
      )}
    </button>
  )
}

/**
 * 새 워크스페이스 "+" 버튼.
 *
 * 쓸 수 있는 에이전트가 하나뿐이면 예전처럼 즉시 만든다 — 선택지를 보여 줄 이유가 없다.
 * 둘 이상이면 어떤 에이전트로 만들지 고르게 한다. 워크스페이스의 에이전트는 생성 시 고정되고
 * 나중에 바꿀 수 없으므로, **만들기 직전**이 유일하게 고를 수 있는 시점이다.
 * (⌘N 은 묻지 않고 기본 에이전트로 만든다 — 단축키는 빨라야 한다.)
 */
function NewWorkspaceButton({
  repoId,
  repoName,
  onNewWorkspace,
  onNewFromIssue,
  onNewFromPr,
  onFanout
}: {
  repoId: string
  repoName: string
  onNewWorkspace: (repoId: string, agentBackend?: AgentBackendId) => void
  onNewFromIssue: (repoId: string) => void
  onNewFromPr: (repoId: string) => void
  onFanout: (repoId: string, agentBackend?: AgentBackendId) => void
}): React.JSX.Element {
  const backends = useAvailableBackends()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const openMenu = (): void => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setMenuAt({ x: r.right, y: r.bottom + 4 })
  }

  useEffect(() => {
    let frame: number | undefined
    const onOpen = (e: Event): void => {
      if ((e as CustomEvent<string>).detail !== repoId) return
      // 먼저 앵커를 화면 안으로 가져온 뒤 다음 프레임에서 좌표를 읽는다. 메뉴를 먼저 열면
      // RowActionsMenu 의 scroll-close 규칙 때문에 스크롤 순간 닫히고, 예전 좌표를 읽으면 메뉴가
      // 화면 가장자리에 대상과 떨어져 나타난다.
      buttonRef.current?.closest('[data-repo-header]')?.scrollIntoView({ block: 'nearest' })
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(openMenu)
    }
    window.addEventListener(OPEN_NEW_WORKSPACE_MENU_EVENT, onOpen)
    return () => {
      window.removeEventListener(OPEN_NEW_WORKSPACE_MENU_EVENT, onOpen)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [repoId])

  const multi = backends.length > 1
  const actions: RowAction[] = backends.length
    ? backends.map((b) => ({
        key: b.id,
        label: multi ? `New workspace · ${b.label}` : 'New workspace',
        icon: <AgentBackendMark backend={b.id} size={13} />,
        onSelect: () => onNewWorkspace(repoId, b.id)
      }))
    : [
        {
          key: 'workspace',
          label: 'New workspace',
          icon: <Plus size={13} />,
          onSelect: () => onNewWorkspace(repoId)
        }
      ]
  actions.push({
    key: 'issue',
    label: 'New from issue…',
    icon: <GithubMark size={12} />,
    onSelect: () => onNewFromIssue(repoId),
    separatorBefore: true
  })
  actions.push({
    key: 'pr',
    label: 'New from PR…',
    icon: <GithubMark size={12} />,
    onSelect: () => onNewFromPr(repoId)
  })
  // fan-out 은 "워크스페이스 하나 더" 가 아니라 "같은 질문을 여럿에게" 다. 그래도 만드는
  // 동작이므로 다른 진입점을 새로 만들지 않고 이 메뉴 안에 둔다 — 어떻게 시작하든 새
  // 워크스페이스를 만드는 곳은 여기 하나여야 찾을 수 있다.
  actions.push({
    key: 'fanout',
    label: 'Fan out one prompt…',
    icon: <Copy size={13} />,
    onSelect: () => onFanout(repoId)
  })
  // 이미 있는 worktree 를 워크스페이스로 앉히는 것도 "여기 무언가를 더한다" 다. 손으로 만든
  // worktree 든 다른 도구가 만든 것이든, 이 리포에서 시작하는 유일한 메뉴 안에 함께 둔다.
  actions.push({
    key: 'import',
    label: 'Import existing worktrees…',
    icon: <Download size={13} />,
    onSelect: () => openMigrate(repoId),
    separatorBefore: true
  })

  return (
    <>
      <button
        ref={buttonRef}
        data-row-actions-trigger
        onClick={openMenu}
        className="h-5 w-5 grid place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
        title="New workspace or start from an issue"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
      >
        <Plus size={14} />
      </button>
      {menuAt && (
        <RowActionsMenu
          at={menuAt}
          align="right"
          heading={`New workspace in ${repoName}`}
          actions={actions}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  )
}
