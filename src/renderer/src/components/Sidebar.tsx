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
  Search,
  X
} from 'lucide-react'
import { useStore } from '../store'
import RowActionsMenu, { type RowAction } from './RowActionsMenu'
import { GithubMark } from './BrandIcons'
import {
  QUICK_SWITCH_HINT_DISMISSED,
  readUiFlag,
  repoSettingsSeenFlag,
  setUiFlag
} from '../lib/uiFlags'
import { OPEN_REPO_SETTINGS_EVENT, openRepoSettings } from '../lib/repoSettings'
import { orderByStack, orderVisibleWorkspaces, workspaceDisplayName } from '@shared/types'
import { useGithubDisconnected } from '../lib/github'
import { WorkspaceAgents } from './WorkspaceAgents'
import { useNow } from '../lib/useNow'
import { formatDuration } from '../lib/format'
import { useDragReorder, type DragReorder } from '../lib/useDragReorder'
import type { PrState, PrStatus, Repo, Workspace } from '@shared/types'

/** running 상태가 이 시간을 넘기면 사이드바에 "오래 실행 중" 힌트(멈춤일 수 있음)를 표시한다. */
const RUNNING_STALE_MS = 5 * 60 * 1000

// 리포 드래그와 워크스페이스 드래그를 구분하는 dataTransfer 타입. 워크스페이스 행은 리포 블록
// 안에 중첩되므로, 이 타입으로 "지금 끌고 있는 게 무엇인지"를 각 드롭존이 판별한다.
const REPO_MIME = 'application/x-wooi-repo'
const WORKSPACE_MIME = 'application/x-wooi-workspace'

export default function Sidebar({
  onNewWorkspace,
  onStackWorkspace,
  onOpenQuickSwitch
}: {
  onNewWorkspace: (repoId: string) => void
  onStackWorkspace: (repoId: string, parentWorkspaceId: string) => void
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
                    !repo.devScript.trim() &&
                    !repo.archiveScript.trim() && (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--info-500)]"
                        aria-label="Not configured yet"
                      />
                    )}
                </button>
                <button
                  onClick={() => onNewWorkspace(repo.id)}
                  className="h-5 w-5 grid place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
                  title="New workspace (⌘N)"
                >
                  <Plus size={14} />
                </button>
              </div>

              <div className="mt-0.5 space-y-0.5">
                {active.length === 0 && repoPending.length === 0 && (
                  <p className="px-3 py-1 text-xs text-neutral-600">No workspaces</p>
                )}
                {/* 이 렌더 순서는 orderVisibleWorkspaces 의 정의(레포 순 → 레포 안 orderByStack)와
                    일치해야 한다 — ⌘1–9 번호가 "위에서 n번째" 와 어긋나지 않게 하는 불변식이다.
                    여기 정렬 방식을 바꾸면 shared/types.ts 의 orderVisibleWorkspaces 도 같이 고칠 것. */}
                {orderByStack(active).map(({ workspace: ws, depth }) => (
                  <WorkspaceRow
                    key={ws.id}
                    workspace={ws}
                    depth={depth}
                    onStackWorkspace={onStackWorkspace}
                    shortcut={shortcutById.get(ws.id)}
                    now={now}
                    dnd={workspaceDnd}
                  />
                ))}
                {repoPending.map((p) => (
                  <PendingRow key={p.id} name={p.name} />
                ))}
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
  onStackWorkspace: (repoId: string, parentWorkspaceId: string) => void
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

  // 행당 액션이 5개까지 늘어나 아이콘을 나열하면 제목 폭을 계속 잠식한다. 그래서 1차 액션
  // (뒤처진 stacked 워크스페이스의 restack)만 인라인으로 승격하고 나머지는 이 메뉴로 모은다.
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
      onSelect: () =>
        void requireGithub('Stacked workspaces track their pull requests on GitHub.', () =>
          onStackWorkspace(workspace.repoId, workspace.id)
        )
    },
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
      separatorBefore: true
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
        onClick={() => void select(workspace.id)}
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
            <GitBranch size={10} className="shrink-0" />
            <span className="truncate">{workspace.branch}</span>
            {git && git.changedFiles > 0 && (
              <span
                className="text-[var(--warning-500)]/80 shrink-0"
                title={`${git.changedFiles} changed file(s)`}
              >
                ·{git.changedFiles}
              </span>
            )}
            {git && git.behind > 0 && (
              <span
                className="text-neutral-500 shrink-0 tabular-nums"
                title={`${git.behind} commit(s) behind ${workspace.baseBranch}`}
              >
                ↓{git.behind}
              </span>
            )}
            {git && git.ahead > 0 && (
              <span
                className="text-neutral-500 shrink-0 tabular-nums"
                title={`${git.ahead} commit(s) ahead of ${workspace.baseBranch}`}
              >
                ↑{git.ahead}
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
function PendingRow({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="w-full flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-md text-left opacity-70 select-none">
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
    await window.api.workspace.remove(workspace.id, true)
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
  changes_requested: { dotClass: 'bg-orange-400', label: 'Changes requested' },
  approved: { dotClass: 'bg-[var(--success-400)]', label: 'Ready to merge' },
  conflict: { dotClass: 'bg-[var(--danger-400)]', label: 'Conflict' },
  open: { dotClass: 'bg-[var(--accent-400)]', label: 'Open' },
  merged: { dotClass: 'bg-purple-400', label: 'Merged' },
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
      ? 'text-purple-400'
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
