import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowUp,
  Check,
  Columns2,
  Loader2,
  MessageSquare,
  Rows3,
  Trophy,
  X
} from 'lucide-react'
import { workspaceDisplayName } from '@shared/types'
import type { FanoutGroup, FileDiff, WorkspaceDiff, Workspace } from '@shared/types'
import { useStore } from '../../store'
import { AgentBackendMark } from '../BrandIcons'
import DiffView from '../DiffView'

/**
 * fan-out 비교 화면 — 같은 프롬프트를 받은 후보들의 결과를 나란히 놓고 하나를 고른다.
 *
 * 여기서 하는 일은 **읽기와 한 번의 결정**뿐이다. 후보의 diff 는 워크스페이스 Changes 탭과
 * 똑같이 `git.diff`(base 대비 커밋 + 미커밋)로 읽고, 그리는 것도 같은 [[DiffView]] 다 —
 * 비교 화면에서만 다르게 보이는 diff 를 만들면 "여기서 본 것"과 "저기서 볼 것"이 갈라진다.
 *
 * hunk 단위로 골라 합치는 3-pane 병합은 여기에 없다(M2). 지금의 채택은 승자를 남기고 나머지를
 * 아카이브하는 것이고, 아카이브는 브랜치·PR·대화를 남기므로 되돌릴 수 있다.
 */
export default function FanoutCompareScreen({ groupId }: { groupId: string }): React.JSX.Element {
  const group = useStore((s) => s.app?.fanoutGroups.find((g) => g.id === groupId))
  const workspaces = useStore((s) => s.app?.workspaces)
  const close = useStore((s) => s.closeFanoutCompare)

  // 나란히(옆으로) 볼지, 한 번에 하나씩 볼지. 후보가 셋을 넘으면 나란히 보기는 각 칸이 너무
  // 좁아지므로 탭이 기본이 된다.
  const [mode, setMode] = useState<'split' | 'tabs'>('split')
  const [pickedId, setPickedId] = useState<string | null>(null)

  const candidates = useMemo(
    () =>
      (group?.workspaceIds ?? [])
        .map((id) => workspaces?.find((w) => w.id === id))
        .filter((w): w is Workspace => !!w),
    [group?.workspaceIds, workspaces]
  )

  // 아카이브된 후보는 worktree 가 없어 diff 를 물을 수 없다. 목록에는 남겨 두되(채택 결과를
  // 읽을 수 있어야 한다) diff 는 비운다.
  const live = candidates.filter((w) => !w.archived)

  // 고른 후보가 사라지면(영구 삭제) 첫 후보로 되돌린다. 상태를 고쳐 쓰는 대신 그릴 때마다
  // 다시 고르는 쪽이다 — 이펙트로 되돌리면 한 프레임 동안 없는 후보를 가리킨다.
  const activeId =
    pickedId && candidates.some((w) => w.id === pickedId) ? pickedId : (candidates[0]?.id ?? null)

  if (!group) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-neutral-500">
        This fan-out group no longer exists.
      </div>
    )
  }

  const shown = mode === 'tabs' ? candidates.filter((w) => w.id === activeId) : candidates

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg)]">
      <Header group={group} candidates={candidates} mode={mode} onMode={setMode} onClose={close} />

      {mode === 'tabs' && candidates.length > 0 && (
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)]">
          {candidates.map((w, i) => (
            <button
              key={w.id}
              onClick={() => setPickedId(w.id)}
              className={
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ' +
                (activeId === w.id
                  ? 'bg-[var(--surface-2)] text-neutral-100'
                  : 'text-neutral-400 hover:bg-[var(--surface)] hover:text-neutral-200')
              }
            >
              <AgentBackendMark backend={w.agentBackend} size={12} />
              <span className="truncate max-w-[16rem]">
                {i + 1}. {workspaceDisplayName(w)}
              </span>
            </button>
          ))}
        </div>
      )}

      {candidates.length === 0 ? (
        <div className="flex-1 grid place-items-center text-sm text-neutral-500">
          None of this group&rsquo;s candidates exist any more.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex divide-x divide-[var(--border)]">
          {shown.map((w) => (
            <CandidateColumn
              key={w.id}
              workspace={w}
              group={group}
              index={candidates.indexOf(w)}
              // 아카이브된 후보만 남은 그룹에서 "채택" 버튼을 남겨 두면 아무 형제도 없는 채택이
              // 된다 — 그 자체는 유효하지만(그룹을 닫는 동작), 살아 있는 후보가 있을 때만 고르는
              // 것이 자연스럽다.
              canAdopt={live.length > 0 && !w.archived}
              showFileList={mode === 'tabs'}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Header({
  group,
  candidates,
  mode,
  onMode,
  onClose
}: {
  group: FanoutGroup
  candidates: Workspace[]
  mode: 'split' | 'tabs'
  onMode: (mode: 'split' | 'tabs') => void
  onClose: () => void
}): React.JSX.Element {
  const forget = useStore((s) => s.forgetFanoutGroup)
  const confirm = useStore((s) => s.confirm)
  const adopting = useStore((s) => s.adoptingFanoutWorkspaceId)
  const adopted = candidates.find((w) => w.id === group.adoptedWorkspaceId)
  // 형제는 하나씩 아카이브되고 그때마다 상태가 방송된다 — 아직 살아 있는 형제를 세면 "몇 개
  // 남았는가" 가 공짜로 나온다. 도는 시간이 몇 초라, 도는 중이라는 사실만 알리는 것보다
  // 줄어드는 숫자를 보여 주는 편이 기다릴 만한지 판단할 근거가 된다.
  const remaining = adopting ? candidates.filter((w) => w.id !== adopting && !w.archived).length : 0

  return (
    <div className="shrink-0 border-b border-[var(--border)]">
      <div className="flex items-center gap-2 px-3 h-11">
        <Trophy size={15} className="shrink-0 text-[var(--warning-400)]" />
        <span className="font-medium text-neutral-100 truncate">{group.name}</span>
        <span className="text-xs text-neutral-500 shrink-0">
          {candidates.length} candidate{candidates.length === 1 ? '' : 's'}
        </span>
        {adopting ? (
          <span
            role="status"
            className="flex items-center gap-1.5 shrink-0 text-xs text-[var(--info-400)]"
          >
            <Loader2 size={11} className="animate-spin" />
            {remaining > 0
              ? `Archiving ${remaining} candidate${remaining === 1 ? '' : 's'}…`
              : 'Finishing up…'}
          </span>
        ) : (
          adopted && (
            <span className="flex items-center gap-1 shrink-0 text-xs text-[var(--success-400)]">
              <Check size={11} />
              Adopted {workspaceDisplayName(adopted)}
            </span>
          )
        )}

        <div className="flex-1" />

        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          {(
            [
              { key: 'split' as const, icon: <Columns2 size={13} />, label: 'Side by side' },
              { key: 'tabs' as const, icon: <Rows3 size={13} />, label: 'One at a time' }
            ] satisfies Array<{ key: 'split' | 'tabs'; icon: React.ReactNode; label: string }>
          ).map((option) => (
            <button
              key={option.key}
              onClick={() => onMode(option.key)}
              title={option.label}
              aria-pressed={mode === option.key}
              className={
                'h-7 w-8 grid place-items-center transition-colors ' +
                (mode === option.key
                  ? 'bg-[var(--surface-2)] text-neutral-100'
                  : 'text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-200')
              }
            >
              {option.icon}
            </button>
          ))}
        </div>

        <button
          onClick={() => {
            void confirm({
              title: `Forget the fan-out group “${group.name}”?`,
              body: 'Only the grouping is removed — every workspace, branch and conversation stays exactly where it is.',
              confirmLabel: 'Forget group'
            }).then((ok) => ok && void forget(group.id))
          }}
          // 채택이 도는 중에 그룹을 지우면, 끝나고 나서 갱신할 그룹이 사라진 상태가 된다.
          disabled={adopting !== null}
          className="h-7 px-2 grid place-items-center rounded-md text-xs text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="Remove the grouping (workspaces are kept)"
        >
          Forget
        </button>
        <button
          onClick={onClose}
          aria-label="Close comparison"
          title="Back to the workspace"
          className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
        >
          <X size={15} />
        </button>
      </div>

      {group.prompt && (
        <div className="flex items-start gap-2 px-3 pb-2.5 text-xs text-neutral-500">
          <MessageSquare size={12} className="mt-0.5 shrink-0" />
          <p className="flex-1 whitespace-pre-wrap leading-relaxed line-clamp-3">{group.prompt}</p>
        </div>
      )}
    </div>
  )
}

/**
 * 후보 한 명의 칸 — 위쪽에 상태·요약·채택 버튼, 아래쪽에 base 대비 diff.
 *
 * diff 는 이 컴포넌트가 스스로 읽는다. 화면 전체에서 한 번에 모아 읽으면 가장 느린 후보 하나가
 * 나머지 전부를 붙잡는데, 후보마다 리포 크기가 같으므로 그 대기는 곧 N 배가 된다.
 */
function CandidateColumn({
  workspace,
  group,
  index,
  canAdopt,
  showFileList
}: {
  workspace: Workspace
  group: FanoutGroup
  index: number
  canAdopt: boolean
  /** 한 후보만 보는 모드에서는 옆에 파일 목록을 두고 한 파일씩 좁혀 볼 수 있게 한다. */
  showFileList: boolean
}): React.JSX.Element {
  const git = useStore((s) => s.gitStatus[workspace.id])
  const select = useStore((s) => s.selectWorkspace)
  const adopt = useStore((s) => s.requestAdoptFanoutWinner)
  const adopting = useStore((s) => s.adoptingFanoutWorkspaceId)
  const isAdopting = adopting === workspace.id
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(true)
  /** 파일 목록에서 고른 경로. null 이면 전부 본다. */
  const [path, setPath] = useState<string | null>(null)

  const isAdopted = group.adoptedWorkspaceId === workspace.id
  // 후보가 도는 동안 diff 는 계속 자란다. 한 번 읽고 멈추면 비교 화면이 오래된 상태를 자신
  // 있게 보여 주므로, 변경 파일 수(미커밋)와 턴 상태 둘 다를 다시 읽는 계기로 삼는다 —
  // 에이전트가 커밋해 버리면 changedFiles 는 0 으로 떨어지고 상태는 idle 로 정착한다.
  // (git 상태 자체를 새로 고치는 것은 store 가 턴 종료 때 이미 한다.)
  const changedFiles = git?.changedFiles ?? 0
  const status = workspace.status

  useEffect(() => {
    if (workspace.archived) return
    let cancelled = false
    setLoading(true)
    void window.api.git
      .diff(workspace.id)
      .catch(() => null)
      .then((next) => {
        if (cancelled) return
        setDiff(next)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.archived, changedFiles, status])

  // 고른 파일은 다음 턴에 사라질 수 있다(에이전트가 되돌렸을 때). 그때는 전체 보기로 읽는다 —
  // 없는 파일을 골라 둔 상태로 빈 diff 를 보여 주면 "이 후보는 아무것도 안 했다" 로 읽힌다.
  const files = diff?.files ?? []
  const activePath = path && files.some((f) => f.path === path) ? path : null
  const shownDiff =
    diff && activePath ? { ...diff, files: files.filter((f) => f.path === activePath) } : diff

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-2)]">
        <div className="flex items-center gap-2">
          <span className="shrink-0 h-5 w-5 grid place-items-center rounded bg-[var(--surface-2)] text-xs font-medium text-neutral-400">
            {index + 1}
          </span>
          <AgentBackendMark backend={workspace.agentBackend} size={13} />
          <button
            onClick={() => void select(workspace.id)}
            title="Open this workspace’s conversation"
            className="flex-1 min-w-0 truncate text-left text-sm font-medium text-neutral-200 hover:text-neutral-50"
          >
            {workspaceDisplayName(workspace)}
          </button>
          <StatusChip workspace={workspace} />
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1 min-w-0 truncate font-mono text-xs text-neutral-600">
            {workspace.branch}
          </span>
          <GitSummary
            changedFiles={git?.changedFiles ?? 0}
            ahead={git?.ahead ?? 0}
            archived={workspace.archived}
          />
        </div>

        <div className="mt-2">
          {workspace.archived ? (
            <span className="flex items-center gap-1.5 text-xs text-neutral-500">
              <Archive size={12} />
              Archived — unarchive it from the sidebar to look again.
            </span>
          ) : isAdopted ? (
            <span className="flex items-center gap-1.5 text-xs text-[var(--success-400)]">
              <Check size={12} />
              Adopted
            </span>
          ) : (
            <button
              onClick={() => void adopt(group.id, workspace.id)}
              // 채택이 도는 동안에는 **모든** 후보의 버튼을 잠근다. 누른 칸만 잠그면 그 사이
              // 옆 칸을 눌러 두 번째 채택이 시작되고, 그 대상은 지금 사라지는 중인 형제다.
              disabled={!canAdopt || adopting !== null}
              className={
                'w-full flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-md border transition-colors disabled:cursor-not-allowed ' +
                // 도는 중인 칸은 흐려지면 안 된다 — 지금 무슨 일이 일어나는지 알려 주는
                // 유일한 표시라서, 다른 잠긴 버튼과 같은 취급을 하면 스피너까지 같이 묻힌다.
                (isAdopting
                  ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                  : 'border-[var(--border-2)] text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent')
              }
              title={
                isAdopting
                  ? 'Archiving the other candidates…'
                  : 'Keep this one and archive the other candidates'
              }
            >
              {isAdopting ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Adopting…
                </>
              ) : (
                <>
                  <Trophy size={12} />
                  Adopt this one
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {workspace.archived ? (
        <p className="flex-1 grid place-items-center px-3 text-center text-sm text-neutral-600">
          No worktree to diff — this candidate is archived.
        </p>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {showFileList && files.length > 0 && (
            <FileList
              files={files}
              selected={activePath}
              onSelect={(next) => setPath(next === activePath ? null : next)}
            />
          )}
          <div className="flex-1 min-w-0 overflow-y-auto p-3">
            <DiffView diff={shownDiff} loading={loading} baseBranch={workspace.baseBranch} />
          </div>
        </div>
      )}
    </div>
  )
}

/** 후보가 건드린 파일 목록. 한 줄을 고르면 오른쪽 diff 가 그 파일만 남는다(다시 누르면 전체). */
function FileList({
  files,
  selected,
  onSelect
}: {
  files: FileDiff[]
  selected: string | null
  onSelect: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] py-2">
      {files.map((f) => (
        <button
          key={f.path}
          onClick={() => onSelect(f.path)}
          title={f.path}
          className={
            'w-full flex items-center gap-2 px-3 py-1 text-left transition-colors ' +
            (selected === f.path
              ? 'bg-[var(--surface-2)] text-neutral-100'
              : 'text-neutral-400 hover:bg-[var(--surface)]')
          }
        >
          <span className="flex-1 min-w-0 truncate font-mono text-xs" dir="rtl">
            {f.path}
          </span>
          {f.binary ? (
            <span className="shrink-0 text-2xs text-neutral-600">bin</span>
          ) : (
            <span className="shrink-0 font-mono text-2xs">
              <span className="text-[var(--success-400)]">+{f.additions}</span>{' '}
              <span className="text-[var(--danger-400)]">−{f.deletions}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 실행 상태 한 조각. 사이드바의 표시와 같은 어휘를 쓴다(도는 중·에러·유휴). */
function StatusChip({ workspace }: { workspace: Workspace }): React.JSX.Element {
  if (workspace.status === 'running') {
    return (
      <span
        title="Running"
        className="flex items-center gap-1 shrink-0 text-xs text-[var(--info-400)]"
      >
        <Loader2 size={11} className="animate-spin" />
        Running
      </span>
    )
  }
  if (workspace.status === 'error') {
    return (
      <span
        title="Last turn ended with an error"
        className="flex items-center gap-1 shrink-0 text-xs text-[var(--danger-400)]"
      >
        <AlertTriangle size={11} />
        Error
      </span>
    )
  }
  return <span className="shrink-0 text-xs text-neutral-600">Idle</span>
}

/** "3 changed · ↑2" — 사이드바 행과 같은 요약을 후보 칸에서도 그대로 쓴다. */
function GitSummary({
  changedFiles,
  ahead,
  archived
}: {
  changedFiles: number
  ahead: number
  archived: boolean
}): React.JSX.Element {
  if (archived) return <span className="shrink-0 text-xs text-neutral-600">—</span>
  if (!changedFiles && !ahead)
    return <span className="shrink-0 text-xs text-neutral-600">No changes yet</span>
  return (
    <span className="flex items-center gap-2 shrink-0 text-xs text-neutral-500">
      {changedFiles > 0 && <span>{changedFiles} changed</span>}
      {ahead > 0 && (
        <span className="flex items-center gap-0.5" title={`${ahead} commits ahead of base`}>
          <ArrowUp size={10} />
          {ahead}
        </span>
      )}
    </span>
  )
}
