import { useEffect, useState } from 'react'
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
  ShieldQuestion,
  Pencil,
  Bell,
  BellOff,
  AlertTriangle,
  RefreshCw,
  LayoutDashboard,
  MoreVertical,
  Users,
  Search,
  ArrowUpDown,
  GitPullRequest,
  Square,
  X
} from 'lucide-react'
import { useStore } from '../store'
import RowActionsMenu, { type RowAction } from './RowActionsMenu'
import { useAvailableBackends } from '../lib/backends'
import { useMultiAgent, type MultiAgentState } from '../lib/multiAgent'
import { AgentBackendMark, GithubMark } from './BrandIcons'
import {
  QUICK_SWITCH_HINT_DISMISSED,
  SWITCH_HINT_DONE,
  SWITCH_HINT_THRESHOLD,
  finishSwitchHint,
  noteMouseSwitch,
  onSwitchHintChange,
  readUiFlag,
  repoSettingsSeenFlag,
  setUiFlag,
  switchClickCount
} from '../lib/uiFlags'
import { OPEN_REPO_SETTINGS_EVENT, openRepoSettings } from '../lib/repoSettings'
import { AGENT_BACKEND_LABELS, orderVisibleWorkspaces, workspaceDisplayName } from '@shared/types'
import { orderRowsWithPending } from '../lib/sidebarRows'
import { useGithubDisconnected } from '../lib/github'
import { WorkspaceAgents } from './WorkspaceAgents'
import { useNow } from '../lib/useNow'
import { formatDuration } from '../lib/format'
import { useDragReorder, type DragReorder } from '../lib/useDragReorder'
import type {
  AgentBackendId,
  PrState,
  PrStatus,
  Repo,
  ReviewSession,
  ReviewStatus,
  Workspace
} from '@shared/types'
import { STATUS_LABEL } from '../lib/review'

/** running 상태가 이 시간을 넘기면 사이드바에 "오래 실행 중" 힌트(멈춤일 수 있음)를 표시한다. */
const RUNNING_STALE_MS = 5 * 60 * 1000

// 리포 드래그와 워크스페이스 드래그를 구분하는 dataTransfer 타입. 워크스페이스 행은 리포 블록
// 안에 중첩되므로, 이 타입으로 "지금 끌고 있는 게 무엇인지"를 각 드롭존이 판별한다.
const REPO_MIME = 'application/x-wooi-repo'
const WORKSPACE_MIME = 'application/x-wooi-workspace'

export default function Sidebar({
  onNewWorkspace,
  onNewFromIssue,
  onStackWorkspace,
  onOpenQuickSwitch
}: {
  onNewWorkspace: (repoId: string, agentBackend?: AgentBackendId) => void
  onNewFromIssue: (repoId: string) => void
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
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)

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
  const anyRunning = app.workspaces.some((w) => !w.archived && w.status === 'running')
  const now = useNow(1000, anyRunning)

  // ⌘1–9 단축키(App.tsx)와 똑같은 순서 함수로 번호를 매긴다 — 화면에서 위에서 n번째 행이
  // 항상 ⌘n 이 되도록(레포가 여러 개여도 1,2,3… 순서가 위에서부터 이어진다).
  const shortcutById = new Map<string, number>()
  ordered.slice(0, 9).forEach((w, i) => shortcutById.set(w.id, i + 1))

  // ⌘K 힌트는 '실제로 번호가 모자라진 순간'에만, 한 번만 띄운다. 9개 이하로 쓰는 사용자는
  // 평생 보지 않고, 한 번 닫으면 실행 간에 기억된다(순수 화면 상태라 localStorage 로 충분).
  const [hintDismissed, setHintDismissed] = useState(() => readUiFlag(QUICK_SWITCH_HINT_DISMISSED))
  const showQuickSwitchHint = ordered.length > 9 && !hintDismissed
  const dismissHint = (): void => {
    setUiFlag(QUICK_SWITCH_HINT_DISMISSED, true)
    setHintDismissed(true)
  }

  // 설정 모달을 한 번이라도 열어 본 리포들. 아직 안 열어 본 리포에만 톱니 옆에 안내 점을 띄운다.
  // 진입 경로가 여러 개(톱니·토스트 액션·⌘K·설정 모달)라 각각에서 표시하지 않고, 공통
  // 이벤트를 여기서 한 번 듣는다.
  // 마운트 시 localStorage 에서 한 번만 읽는다. app.repos 를 deps 로 걸어 매번 다시 만들면
  // (브로드캐스트마다 배열 참조가 새로 온다) 새 Set 때문에 렌더가 한 번씩 더 돈다. 이후 갱신은
  // 아래 이벤트가 맡고, 나중에 추가된 리포는 애초에 플래그가 없어 자연히 점이 붙는다.
  const [seenRepos, setSeenRepos] = useState<Set<string>>(
    () => new Set(app.repos.filter((r) => readUiFlag(repoSettingsSeenFlag(r.id))).map((r) => r.id))
  )
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

  // ⌘↑/⌘↓ 힌트. "행을 여러 번 마우스로 눌러 전환했는데 아직 단축키는 안 써 본" 사용자에게만,
  // 즉 실제로 손해를 보고 있는 게 증명된 순간에만 뜬다. 온보딩에서 미리 가르치지 않는 이유가
  // 이것 — 그때는 워크스페이스가 하나뿐이라 전환할 대상 자체가 없고, 배워도 쓸 데가 없어 잊힌다.
  // 단축키를 한 번이라도 쓰면(App.tsx) 그 즉시 영구히 사라진다.
  const [switchHint, setSwitchHint] = useState(() => ({
    done: readUiFlag(SWITCH_HINT_DONE),
    clicks: switchClickCount()
  }))
  useEffect(
    () =>
      onSwitchHintChange(() =>
        setSwitchHint({ done: readUiFlag(SWITCH_HINT_DONE), clicks: switchClickCount() })
      ),
    []
  )
  // 전환할 곳이 둘 이상일 때만 의미가 있다. ⌘K 힌트와 동시에 뜨면 잔소리가 되므로 양보한다.
  const showSwitchHint =
    !switchHint.done &&
    switchHint.clicks >= SWITCH_HINT_THRESHOLD &&
    ordered.length > 1 &&
    !showQuickSwitchHint

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
    // 사이드바는 워크스페이스를 stack 트리(orderByStack)로 그리므로, 배열 순서가 실제 화면 순서를
    // 좌우하는 건 형제 사이뿐이다. 형제가 아닌 곳엔 드롭 표시선을 아예 띄우지 않아, 놓아도
    // 아무 일도 일어나지 않는 자리를 유효한 것처럼 보이게 하지 않는다.
    canDrop: (draggedId, targetId) => {
      const a = app.workspaces.find((w) => w.id === draggedId)
      const b = app.workspaces.find((w) => w.id === targetId)
      if (!a || !b) return false
      return (
        a.repoId === b.repoId &&
        (a.parentWorkspaceId ?? null) === (b.parentWorkspaceId ?? null) &&
        a.archived === b.archived
      )
    },
    onReorder: (workspaceId, targetId, position) =>
      void window.api.workspace.reorder(workspaceId, targetId, position)
  })

  return (
    <aside className="w-72 shrink-0 flex flex-col bg-[var(--bg-2)]">
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
            <LayoutDashboard size={15} />
            <span className="font-medium">Overview</span>
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
            <Search size={15} />
            <span className="flex-1 text-left font-medium">Search workspaces</span>
            <kbd className="text-xs leading-none font-medium text-neutral-600">⌘K</kbd>
          </button>
        </div>
      )}

      <div data-tour="repos" className="flex items-center justify-between px-3 h-10 shrink-0">
        <span className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
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

      <div data-tour="workspaces" className="flex-1 overflow-y-auto px-2 pb-4">
        {/* PR 리뷰 세션. 워크스페이스와 나란히 두지 않고 별도 구역으로 뺀 이유는 ⌘1–9 번호가
            orderVisibleWorkspaces(워크스페이스 전용)로 매겨지기 때문이다 — 리포 블록 사이에
            끼워 넣으면 "위에서 n번째 = ⌘n" 불변식이 깨진다. 구역을 나누면 그 규칙을 건드리지
            않으면서 리뷰가 어떤 종류의 작업인지도 더 분명해진다. */}
        {app.reviews.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <GitPullRequest size={14} className="text-neutral-500 shrink-0" />
              <span className="flex-1 truncate text-sm font-medium text-neutral-300">Reviews</span>
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

        {app.repos.length === 0 && (
          <p className="px-3 py-8 text-xs text-neutral-500 text-center leading-relaxed">
            No repositories yet.
            <br />
            Use the + button above to add a git repo.
          </p>
        )}

        {app.repos.map((repo) => {
          const all = app.workspaces.filter((w) => w.repoId === repo.id)
          const active = all.filter((w) => !w.archived)
          const archived = all.filter((w) => w.archived)
          const repoPending = pending.filter((p) => p.repoId === repo.id)
          const runningCount = active.filter((w) => w.status === 'running').length
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
                className="group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-grab active:cursor-grabbing"
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
                  onNewWorkspace={onNewWorkspace}
                  onNewFromIssue={onNewFromIssue}
                />
              </div>

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

        {/* 목록이 9개를 넘어 ⌘번호가 없는 행이 생긴 순간에만, 그 행들 바로 아래에서 이유와
            대안을 한 줄로 알려 준다. 앱을 처음 켤 때가 아니라 실제로 한계에 부딪힌 시점에
            띄우는 것이 핵심 — 9개 이하로 쓰는 사용자에게는 아예 존재하지 않는 UI 다. */}
        {showQuickSwitchHint && (
          <div className="mx-1 mb-2 flex items-start gap-2 rounded-md bg-[var(--surface)] px-2 py-1.5 text-xs text-neutral-500">
            <Search size={12} className="mt-0.5 shrink-0" />
            <p className="flex-1 leading-relaxed">
              Only the top 9 rows get a ⌘number. Press{' '}
              <kbd className="font-medium text-neutral-300">⌘K</kbd> to search the rest.
            </p>
            <button
              onClick={dismissHint}
              aria-label="Dismiss hint"
              title="Got it"
              className="shrink-0 -mr-0.5 h-4 w-4 grid place-items-center rounded text-neutral-600 hover:bg-[var(--surface-2)] hover:text-neutral-300"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {/* ⌘↑/⌘↓ 안내. ⌘K 힌트와 같은 자리·같은 톤(작고 흐린 한 줄)이라 새로운 UI 종류를
            늘리지 않는다. 모달·토스트·코치마크처럼 시선을 뺏는 수단을 일부러 피했다 —
            이건 몰라도 앱을 쓰는 데 지장이 없는 정보라서, 그만큼의 방해가 정당화되지 않는다. */}
        {showSwitchHint && (
          <div className="mx-1 mb-2 flex items-start gap-2 rounded-md bg-[var(--surface)] px-2 py-1.5 text-xs text-neutral-500">
            <ArrowUpDown size={12} className="mt-0.5 shrink-0" />
            <p className="flex-1 leading-relaxed">
              Switch workspaces without leaving the keyboard —{' '}
              <kbd className="font-medium text-neutral-300">⌘↑</kbd>{' '}
              <kbd className="font-medium text-neutral-300">⌘↓</kbd>
            </p>
            <button
              onClick={finishSwitchHint}
              aria-label="Dismiss hint"
              title="Got it"
              className="shrink-0 -mr-0.5 h-4 w-4 grid place-items-center rounded text-neutral-600 hover:bg-[var(--surface-2)] hover:text-neutral-300"
            >
              <X size={11} />
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * 리포 이름 옆 아이콘. GitHub 소유자 아바타(avatarDataUrl)가 있으면 그 이미지를,
 * 없거나 로드에 실패하면 기본 리포 아이콘(FolderGit2)으로 폴백한다.
 */
/**
 * 멀티 에이전트 모드를 켜고 끄는 액션(실험 기능).
 *
 * 워크스페이스는 기본 설정에서 모달 없이 자동 생성되므로, 만든 **뒤에** 켜는 이 경로가 사실상
 * 주된 진입점이다. 생성 모달의 모드 선택은 "만들 때부터 정해 두고 싶은" 경우를 위한 것이다.
 *
 * 스위치가 **하나뿐인 것**이 요점이다. 어떤 종류의 에이전트를 쓸지는 여기서 고르는 것이 아니라
 * 대화에서 정해진다 — 미리 고르게 하면 "Codex 한테 시켜줘" 라고 말했는데 메뉴에서 체크를 안 했다는
 * 이유로 안 되는, 설명하기 어려운 실패가 생긴다.
 */
function multiAgentAction(workspace: Workspace, state: MultiAgentState): RowAction[] {
  if (!state.canUse) return []
  return [
    {
      key: 'multiAgent',
      label: state.active ? 'Turn off multi-agent mode' : 'Turn on multi-agent mode',
      icon: <Users size={13} />,
      onSelect: () => void window.api.workspace.setMultiAgent(workspace.id, !state.active),
      separatorBefore: true
    }
  ]
}

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
  /** 사이드바가 소유한 워크스페이스 재정렬 DnD 배선(형제끼리만 자리 교환). */
  dnd: DragReorder
}): React.JSX.Element {
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)
  const git = useStore((s) => s.gitStatus[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  const unread = useStore((s) => s.unread[workspace.id])
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const runningSince = useStore((s) => s.runningSince[workspace.id])
  const restack = useStore((s) => s.restackWorkspace)
  const confirm = useStore((s) => s.confirm)
  const requestDelete = useStore((s) => s.requestDeleteWorkspace)
  const requireGithub = useStore((s) => s.requireGithub)
  const githubDisconnected = useGithubDisconnected()
  const awaitingPermission = useStore((s) =>
    s.permissions.some((p) => p.workspaceId === workspace.id)
  )
  // null 이 아니면 표시 이름 인라인 편집 중. 초깃값은 현재 표시 이름으로 채운다.
  const [editingName, setEditingName] = useState<string | null>(null)
  // null 이 아니면 오버플로 액션 메뉴가 열려 있고, 값은 메뉴를 띄울 화면 좌표.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  // 'right' = ⋯ 버튼 기준(우측 정렬), 'left' = 우클릭 커서 기준.
  const [menuAlign, setMenuAlign] = useState<'left' | 'right'>('right')

  const active = workspace.id === selectedId
  // running 인 채로 오래 머무르면(상태 변화 없이) "멈춤일 수 있음" 으로 본다. 정확한 진입 시각은
  // runningSince(있으면)를, 없으면 lastActiveAt 을 근사치로 쓴다.
  const runningStart = runningSince ?? workspace.lastActiveAt
  const runningMs = workspace.status === 'running' ? Math.max(0, now - runningStart) : 0
  const stale = runningMs >= RUNNING_STALE_MS
  // 표시 이름: 사용자 override → PR 제목 → worktree 이름. override 가 없으면 PR 제목이 자동 반영된다.
  const displayName = workspaceDisplayName(workspace, pr?.title)
  // 에이전트 배지와 stack 생성 override 는 같은 사용 가능 목록을 쓴다.
  const availableBackends = useAvailableBackends()
  const showAgent = availableBackends.length > 1

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
      danger: true
    })
    if (!ok) return
    await window.api.workspace.archive(workspace.id)
    if (active) void select(null)
  }

  // 멀티 에이전트 상태 — 행 배지와 메뉴 토글이 같은 판단을 쓴다. 훅을 두 번 부르면 행마다
  // store 구독이 하나 더 늘어나므로(워크스페이스가 많을수록 손해) 한 번 읽어 나눠 쓴다.
  const multiAgent = useMultiAgent(workspace)

  // 행당 액션이 5개까지 늘어나 아이콘을 나열하면 제목 폭을 계속 잠식한다. 그래서 1차 액션
  // (뒤처진 stacked 워크스페이스의 restack)만 인라인으로 승격하고 나머지는 이 메뉴로 모은다.
  const stack = (agentBackend?: AgentBackendId): void =>
    void requireGithub('Stacked workspaces track their pull requests on GitHub.', () =>
      onStackWorkspace(workspace.repoId, workspace.id, agentBackend)
    )
  const alternateStackBackends = availableBackends.filter((b) => b.id !== workspace.agentBackend)

  const actions: RowAction[] = [
    {
      key: 'rename',
      label: 'Rename…',
      icon: <Pencil size={13} />,
      onSelect: () => setEditingName(displayName)
    },
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
    ...(workspace.parentWorkspaceId
      ? [
          {
            key: 'restack',
            label: githubDisconnected
              ? `Restack onto ${workspace.baseBranch} — Connect GitHub`
              : git && git.behind > 0
                ? `Restack onto ${workspace.baseBranch} (${git.behind} behind)`
                : `Restack onto ${workspace.baseBranch}`,
            icon: githubDisconnected ? <GithubMark size={12} /> : <RefreshCw size={13} />,
            onSelect: () =>
              void requireGithub('Restacking updates the branch and its pull request.', () =>
                restack(workspace.id)
              )
          }
        ]
      : []),
    // 멀티 에이전트 모드 토글(실험 기능). 대부분의 워크스페이스는 모달 없이 자동 생성되므로,
    // 만든 뒤에 켜는 이 경로가 사실상 주된 진입점이다. 다음 세션부터 적용된다.
    ...multiAgentAction(workspace, multiAgent),
    {
      key: 'mute',
      label: workspace.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: workspace.muted ? <BellOff size={13} /> : <Bell size={13} />,
      onSelect: () => void window.api.workspace.setMuted(workspace.id, !workspace.muted),
      separatorBefore: true
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
        <StatusDot
          status={workspace.status}
          awaitingPermission={awaitingPermission}
          compacting={compacting}
          stale={stale}
          runningMs={runningMs}
          pr={pr}
        />
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
            {/* 어떤 에이전트가 이 워크스페이스를 돌리는지. 생성 시 고정되고 바꿀 수 없으므로,
                여러 개를 병렬로 돌릴 때 어느 쪽인지 한눈에 보여야 한다. 에이전트가 하나뿐인
                사용자에게는 정보가 아니라 잡음이라 감춘다.
                멀티 에이전트면 마크 옆에 사람 아이콘을 붙여 "이 마크는 메인일 뿐이고 다른 종류도
                돈다"를 알린다 — 마크만 보고 단일 에이전트로 오해하지 않게 한다. */}
            {showAgent && (
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
            <GitBranch size={10} className="shrink-0" />
            <span className="truncate">{workspace.branch}</span>
            {/* base 대비 ahead/behind 커밋 수(↑N ↓N)도 여기 있었지만, 변경 파일 수 배지와 같은
                이유로 걷어냈다 — 행이 좁아 브랜치 이름을 잘라먹으면서까지 보여 줄 만큼 자주
                행동으로 이어지지 않는다. behind 는 restack 버튼(아래)과 그 툴팁이, 정확한
                수치는 워크스페이스 헤더가 이미 말해 준다. */}
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
          </div>
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
            {/* base(부모)보다 뒤처진 stacked 워크스페이스만 restack 을 1차 액션으로 승격한다.
              (뒤처지지 않았으면 급하지 않으므로 ⋯ 메뉴 안에만 둔다.) */}
            {workspace.parentWorkspaceId && git && git.behind > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void requireGithub('Restacking updates the branch and its pull request.', () =>
                    restack(workspace.id)
                  )
                }}
                className="h-5 w-5 grid place-items-center rounded shrink-0 hover:bg-[var(--surface-2)] text-[var(--warning-400)] hover:text-[var(--warning-300)]"
                title={
                  githubDisconnected
                    ? `Connect GitHub to restack onto ${workspace.baseBranch} (${git.behind} behind)`
                    : `Restack onto ${workspace.baseBranch} (${git.behind} behind) — rebase & force-push`
                }
              >
                <RefreshCw size={12} />
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
              className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0"
              title="More actions (or right-click the row)"
            >
              <MoreVertical size={14} />
            </button>
          </div>
        </div>
        {/* 상태 인디케이터는 "정보"이므로 고정 슬롯을 갖고, 액션 오버레이에 가려지지 않는다.
          (예전에는 호버 시 group-hover:hidden 으로 사라져서, 음소거 여부를 확인하면서
          음소거 버튼을 누를 수 없었다.) 아이콘 간 간격은 좁혀 하나의 묶음으로 읽히게 한다. */}
        {(shortcut !== undefined || (unread && !active) || workspace.muted) && (
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
      <WorkspaceAgents
        workspaceId={workspace.id}
        depth={depth}
        backend={workspace.agentBackend}
        now={now}
      />
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
  // 워크스페이스 행과 같은 규칙 — 에이전트가 하나뿐이면 정보가 아니라 잡음이다.
  const showAgent = useAvailableBackends().length > 1

  const { id, prNumber, prTitle } = session

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
      <ReviewStatusDot status={session.status} />
      <div className="flex-1 min-w-0">
        <div
          className={'truncate text-sm ' + (active ? 'text-neutral-100' : 'text-neutral-300')}
          title={prTitle}
        >
          {prTitle}
        </div>
        <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
          {showAgent && (
            <span className="shrink-0 text-neutral-500">
              <AgentBackendMark backend={session.agentBackend} size={10} />
            </span>
          )}
          <span className="shrink-0 tabular-nums">#{prNumber}</span>
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
          className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0"
          title="Archive (keeps the findings, removes the worktree)"
        >
          <Archive size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            void requestCloseReview(id)
          }}
          className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)] shrink-0"
          title="Delete review permanently"
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
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-neutral-600 hover:text-neutral-400"
      >
        <ChevronRight size={11} className={open ? 'rotate-90 transition' : 'transition'} />
        Archived ({reviews.length})
      </button>
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

  return (
    <div className="group/arcrev flex items-center gap-2 pl-6 pr-1.5 py-1 rounded-md hover:bg-[var(--surface)]">
      <span className="flex-1 truncate text-xs text-neutral-500" title={session.prTitle}>
        #{session.prNumber} {session.prTitle}
      </span>
      <button
        onClick={() => void unarchiveReview(session.id)}
        className="opacity-0 group-hover/arcrev:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        title="Unarchive (recreate the review worktree)"
      >
        <ArchiveRestore size={12} />
      </button>
      <button
        onClick={() => void requestCloseReview(session.id)}
        className="opacity-0 group-hover/arcrev:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
        title="Delete permanently"
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
          className="opacity-0 group-hover/arcsec:opacity-100 mr-1.5 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
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
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)
  const deleteWorkspaceNow = useStore((s) => s.deleteWorkspaceNow)
  const reportCarryFailures = useStore((s) => s.reportCarryFailures)
  const suggestCarry = useStore((s) => s.suggestCarry)

  const unarchive = async (): Promise<void> => {
    const res = await window.api.workspace.unarchive(workspace.id)
    if (res.error) pushToast('error', res.error)
    else {
      void select(workspace.id)
      // 언아카이브도 worktree 를 새로 만들므로 전달이 다시 일어난다 — 실패는 동일하게 알리고,
      // 전달 목록이 빈 리포라면 생성 경로와 똑같이 한 번 제안한다.
      reportCarryFailures(res.carryFailures)
      suggestCarry(workspace.repoId, workspace.id, res.carrySuggestions)
    }
  }

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
    <div className="group/arc flex items-center gap-2 pl-6 pr-1.5 py-1 rounded-md hover:bg-[var(--surface)]">
      <span className="flex-1 truncate text-xs text-neutral-500" title={workspace.branch}>
        {displayName}
      </span>
      <button
        onClick={unarchive}
        className="opacity-0 group-hover/arc:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        title="Unarchive (recreate worktree)"
      >
        <ArchiveRestore size={12} />
      </button>
      <button
        onClick={remove}
        className="opacity-0 group-hover/arc:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
        title="Delete permanently"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

/**
 * PR 상태별 점 색(bg) 과 라벨. Tailwind v4 는 보간한 클래스명을 스캔하지 못하므로
 * 상태마다 전체 클래스 문자열을 그대로 둔다(ChatView 의 PR_STYLE 와 색 일치).
 */
const PR_DOT: Record<PrState, { dotClass: string; label: string }> = {
  draft: { dotClass: 'bg-neutral-400', label: 'Draft' },
  review_required: { dotClass: 'bg-[var(--warning-400)]', label: 'Review required' },
  changes_requested: { dotClass: 'bg-[var(--attention-400)]', label: 'Changes requested' },
  approved: { dotClass: 'bg-[var(--success-400)]', label: 'Ready to merge' },
  conflict: { dotClass: 'bg-[var(--danger-400)]', label: 'Conflict' },
  open: { dotClass: 'bg-[var(--accent-400)]', label: 'Open' },
  merged: { dotClass: 'bg-[var(--merged-400)]', label: 'Merged' },
  closed: { dotClass: 'bg-neutral-500', label: 'Closed' }
}

/** 상태 표시 점/아이콘. 사이드바 행과 ⌘K 퀵 스위처가 같은 시각 언어를 쓰도록 공유한다. */
export function StatusDot({
  status,
  awaitingPermission,
  compacting,
  stale,
  runningMs,
  pr
}: {
  status: Workspace['status']
  awaitingPermission: boolean
  compacting: boolean
  stale: boolean
  runningMs: number
  pr?: PrStatus | null
}): React.JSX.Element {
  // 권한 대기는 가장 행동 가능한 상태라 다른 표시보다 우선한다.
  if (awaitingPermission) {
    return (
      <span title="Waiting for your permission" className="shrink-0 grid place-items-center">
        <ShieldQuestion size={13} className="text-[var(--warning-400)]" />
      </span>
    )
  }
  if (status === 'running') {
    // 압축 중(보라) · 오래 실행(앰버, 멈춤일 수 있음) · 일반 실행(파랑) 을 색으로 구분한다.
    const color = compacting
      ? 'text-[var(--merged-400)]'
      : stale
        ? 'text-[var(--warning-400)]'
        : 'text-[var(--info-400)]'
    const title = compacting
      ? 'Compacting conversation…'
      : stale
        ? `Running for ${Math.round(runningMs / 60000)}m — may be stuck`
        : 'Running'
    return (
      <span title={title} className="shrink-0 grid place-items-center">
        <Loader2 size={13} className={`${color} animate-spin`} />
      </span>
    )
  }
  // 에러는 PR 상태보다 우선해 알린다. 색만으로 idle 과 구분되지 않도록 경고 아이콘을 쓴다.
  if (status === 'error') {
    return (
      <span title="Last turn ended with an error" className="shrink-0 grid place-items-center">
        <AlertTriangle size={12} className="text-[var(--danger-400)]" aria-label="Error" />
      </span>
    )
  }
  // idle 이면서 PR 이 있으면 점 색으로 PR 상태를 한눈에 보여 준다.
  if (pr) {
    const { dotClass, label } = PR_DOT[pr.state]
    return (
      <span
        title={`PR #${pr.number} — ${label}`}
        className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`}
      />
    )
  }
  return (
    <span title="Idle — ready for input" className="h-2 w-2 rounded-full shrink-0 bg-neutral-600" />
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
  onNewWorkspace,
  onNewFromIssue
}: {
  repoId: string
  onNewWorkspace: (repoId: string, agentBackend?: AgentBackendId) => void
  onNewFromIssue: (repoId: string) => void
}): React.JSX.Element {
  const backends = useAvailableBackends()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

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

  return (
    <>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenuAt({ x: r.right, y: r.bottom + 4 })
        }}
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
          actions={actions}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  )
}
