import { useState } from 'react'
import {
  FolderGit2,
  Plus,
  Settings2,
  GitBranch,
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
  LayoutDashboard
} from 'lucide-react'
import { useStore } from '../store'
import { workspaceDisplayName } from '@shared/types'
import { useNow } from '../lib/useNow'
import { formatDuration } from '../lib/format'
import type { PrState, PrStatus, Repo, Workspace } from '@shared/types'

/** running 상태가 이 시간을 넘기면 사이드바에 "오래 실행 중" 힌트(멈춤일 수 있음)를 표시한다. */
const RUNNING_STALE_MS = 5 * 60 * 1000

export default function Sidebar({
  onNewWorkspace,
  onConfigRepo
}: {
  onNewWorkspace: (repoId: string) => void
  onConfigRepo: (repoId: string) => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const pending = useStore((s) => s.pending)
  const pushToast = useStore((s) => s.pushToast)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)

  // Overview 는 활성(비아카이브) 워크스페이스가 하나라도 있을 때만 의미가 있다(App.tsx 라우팅과 동일).
  const hasActiveWorkspaces = app.workspaces.some((w) => !w.archived)
  const onOverview = selectedId === null

  // 실행 중인 세션이 하나라도 있으면 1초마다 갱신해 경과 시간을 흐르게 하고("오래 실행 중" 힌트도
  // 같은 틱으로 갱신), 없으면 틱을 멈춰 불필요한 재렌더를 막는다.
  const anyRunning = app.workspaces.some((w) => !w.archived && w.status === 'running')
  const now = useNow(1000, anyRunning)

  // ⌘1–9 단축키(App.tsx)는 archived 제외 전체 워크스페이스의 평탄한 순서에 매핑된다.
  // 같은 순서로 앞 9개에 번호를 매겨 사이드바 행에 배지로 노출, 화면-키맵 불일치를 없앤다.
  const shortcutById = new Map<string, number>()
  app.workspaces
    .filter((w) => !w.archived)
    .slice(0, 9)
    .forEach((w, i) => shortcutById.set(w.id, i + 1))

  const addRepo = async (): Promise<void> => {
    const res = await window.api.repo.add()
    if (res.error) pushToast('error', res.error)
  }

  return (
    <aside className="w-72 shrink-0 flex flex-col bg-[var(--bg-2)]">
      {hasActiveWorkspaces && (
        <div className="px-2 pt-2 shrink-0">
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
            <div key={repo.id} className="mb-3">
              <div className="group flex items-center gap-1.5 px-2 py-1.5 rounded-md">
                <RepoIcon repo={repo} />
                <span
                  className="flex-1 truncate text-sm font-medium text-neutral-300"
                  title={repo.path}
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
                <button
                  onClick={() => onConfigRepo(repo.id)}
                  className="h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
                  title="Repository settings (setup / dev / archive scripts)"
                >
                  <Settings2 size={13} />
                </button>
                <button
                  onClick={() => onNewWorkspace(repo.id)}
                  className="h-5 w-5 grid place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
                  title="New workspace"
                >
                  <Plus size={14} />
                </button>
              </div>

              <div className="mt-0.5 space-y-0.5">
                {active.length === 0 && repoPending.length === 0 && (
                  <p className="px-3 py-1 text-xs text-neutral-600">No workspaces</p>
                )}
                {active.map((ws) => (
                  <WorkspaceRow
                    key={ws.id}
                    workspace={ws}
                    shortcut={shortcutById.get(ws.id)}
                    now={now}
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
  shortcut,
  now
}: {
  workspace: Workspace
  shortcut?: number
  now: number
}): React.JSX.Element {
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)
  const git = useStore((s) => s.gitStatus[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  const unread = useStore((s) => s.unread[workspace.id])
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const runningSince = useStore((s) => s.runningSince[workspace.id])
  const confirm = useStore((s) => s.confirm)
  const awaitingPermission = useStore((s) =>
    s.permissions.some((p) => p.workspaceId === workspace.id)
  )
  // null 이 아니면 표시 이름 인라인 편집 중. 초깃값은 현재 표시 이름으로 채운다.
  const [editingName, setEditingName] = useState<string | null>(null)

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

  const archive = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
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

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void select(workspace.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void select(workspace.id)
        }
      }}
      className={
        'group/ws relative w-full flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-md text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)] ' +
        // 선택 행은 좌측에 파란 액센트 바를 띄워 현재 위치를 또렷하게 표시한다.
        (active
          ? 'bg-[var(--surface-3)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--info-500)]'
          : 'hover:bg-[var(--surface)]')
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
      <div className="flex-1 min-w-0">
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
          <div className="flex items-center gap-1 min-w-0">
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
            {/* 편집 가능 힌트: 호버 시 연필 아이콘을 띄워 이름을 바꿀 수 있음을 알린다. */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                setEditingName(displayName)
              }}
              className="opacity-0 group-hover/ws:opacity-100 shrink-0 grid place-items-center text-neutral-500 hover:text-neutral-200"
              title="Rename workspace"
            >
              <Pencil size={11} />
            </button>
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
      </div>
      {shortcut !== undefined && (
        <kbd
          className="shrink-0 text-xs leading-none font-medium text-neutral-600 group-hover/ws:hidden tabular-nums"
          title={`Switch with ⌘${shortcut}`}
        >
          ⌘{shortcut}
        </kbd>
      )}
      {/* 미확인 완료는 권한 대기·실행 중과 별개의 상태이므로, 좌측 상태 점과 함께 같이 보여 준다
          (좌측 StatusDot 이 권한 대기/실행/압축을 표시하고, 우측 파란 점이 미확인 응답을 표시). */}
      {unread && !active && (
        <span
          className="h-2 w-2 rounded-full bg-[var(--info-500)] shrink-0 group-hover/ws:hidden"
          title="Completed response — unread"
        />
      )}
      {/* 음소거 상태는 호버하지 않아도 보이도록 상시 표시(호버 시 토글 버튼으로 대체된다). */}
      {workspace.muted && (
        <BellOff
          size={12}
          className="shrink-0 text-neutral-600 group-hover/ws:hidden"
          aria-label="Notifications muted"
        />
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          void window.api.workspace.setMuted(workspace.id, !workspace.muted)
        }}
        className="opacity-0 group-hover/ws:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0"
        title={workspace.muted ? 'Unmute notifications' : 'Mute notifications'}
      >
        {workspace.muted ? <BellOff size={13} /> : <Bell size={13} />}
      </button>
      <button
        onClick={archive}
        className="opacity-0 group-hover/ws:opacity-100 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 shrink-0"
        title="Archive workspace"
      >
        <Archive size={13} />
      </button>
    </div>
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

  const unarchive = async (): Promise<void> => {
    const res = await window.api.workspace.unarchive(workspace.id)
    if (res.error) pushToast('error', res.error)
    else void select(workspace.id)
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

function StatusDot({
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
