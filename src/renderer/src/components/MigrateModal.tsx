import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderGit2, GitBranch, Loader2, MessageSquare } from 'lucide-react'
import type { MigrationRepoCandidate, MigrationScan } from '@shared/types'
import { useStore } from '../store'
import { AgentBackendMark } from './BrandIcons'
import Modal, { ghostBtn, primaryBtn } from './Modal'

/**
 * 이미 있는 worktree 를 워크스페이스로 들여오기.
 *
 * 화면이 답해야 하는 질문은 셋이다 — **무엇이 들어오는가**, **원래 있던 것은 어떻게 되는가**,
 * **대화도 따라오는가**. 두 번째가 특히 중요하다: 이 기능은 worktree 를 있던 자리에 그대로 두고
 * Wooi 가 같은 디렉터리를 가리키게만 하므로 지워지는 것도 옮겨지는 것도 없다. 그 사실을 모달
 * 안에 못 박아 두지 않으면 사용자는 "다른 앱의 작업이 사라질까 봐" 버튼을 누르지 않는다.
 */
export default function MigrateModal({
  repoId,
  onClose
}: {
  /** 주면 그 리포 하나만 훑는다(리포 메뉴에서 연 경우). 없으면 전부 + 다른 도구까지. */
  repoId?: string | null
  onClose: () => void
}): React.JSX.Element {
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const pushToast = useStore((s) => s.pushToast)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)

  useEffect(() => {
    setOverlayOpen(true)
    return () => setOverlayOpen(false)
  }, [setOverlayOpen])

  useEffect(() => {
    let active = true
    void window.api.migrate
      .scan(repoId ? { repoId } : undefined)
      .then((next) => {
        if (!active) return
        setScan(next)
        // 아직 안 들여온 것은 기본으로 전부 고른다. 여기까지 온 사람은 들여오러 온 것이고,
        // 빼고 싶은 항목이 있으면 체크를 끄는 편이 하나씩 켜는 것보다 짧다.
        setSelected(new Set(next.repos.flatMap(defaultKeys)))
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [repoId])

  const toggle = (key: string, on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const repos = scan?.repos ?? []
  const chosenRepos = repos.filter((repo) => selected.has(repo.key) && !repo.alreadyAdded)
  const chosenWorkspaces = repos.flatMap((repo) =>
    repo.workspaces.filter((ws) => selected.has(ws.key) && !ws.alreadyImported)
  )
  const nothingChosen = chosenRepos.length === 0 && chosenWorkspaces.length === 0

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const workspaceKeys = chosenWorkspaces.map((ws) => ws.key)
      const result = await window.api.migrate.run({
        repoKeys: repos.filter((repo) => selected.has(repo.key)).map((repo) => repo.key),
        workspaceKeys,
        // 세션 키는 워크스페이스 키에 접두사를 붙인 별개 항목이라, 되돌려 보낼 때 원래 키로 편다.
        sessionKeys: workspaceKeys.filter((key) => selected.has(sessionKey(key)))
      })
      const parts: string[] = []
      if (result.repos > 0)
        parts.push(`${result.repos} repositor${result.repos === 1 ? 'y' : 'ies'}`)
      if (result.workspaces > 0)
        parts.push(`${result.workspaces} workspace${result.workspaces === 1 ? '' : 's'}`)
      const resumed =
        result.sessions > 0
          ? ` ${result.sessions} continue${result.sessions === 1 ? 's' : ''} an existing conversation.`
          : ''
      pushToast(
        result.errors.length > 0 ? 'error' : 'success',
        parts.length > 0
          ? `Imported ${parts.join(' and ')}.${resumed}${result.errors.length > 0 ? ` ${result.errors.length} item(s) failed: ${result.errors[0]}` : ''}`
          : `Nothing was imported.${result.errors.length > 0 ? ` ${result.errors[0]}` : ''}`
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Import existing worktrees"
      onClose={busy ? (): void => undefined : onClose}
      width={640}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={run} disabled={busy || nothingChosen}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      {!scan && !error && (
        <p className="flex items-center gap-2 py-6 justify-center text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin" />
          Looking for worktrees…
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 text-sm text-[var(--danger-400)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {scan && repos.length === 0 && !error && (
        <div className="py-6 text-center text-sm text-neutral-500 leading-relaxed">
          <p className="text-neutral-300">Nothing left to import.</p>
          <p className="mt-1.5">
            {repoId
              ? 'Every worktree in this repository is already a workspace here.'
              : 'Wooi looks at the worktrees of your repositories, and at repositories Conductor or Orca know about on this Mac. Anything already imported is not listed again.'}
          </p>
        </div>
      )}

      {scan && repos.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-400 leading-relaxed">
            Wooi points at worktrees that already exist —{' '}
            <b className="text-neutral-300">nothing is moved, copied or deleted</b>. Where a coding
            agent was running in one, you can pick up that conversation where it left off, with its
            earlier messages copied into the chat.
          </p>

          <div className="overflow-hidden rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
            {repos.map((repo) => (
              <RepoRow key={repo.key} repo={repo} selected={selected} onToggle={toggle} />
            ))}
          </div>

          {scan.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-xs text-[var(--warning-400)]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      )}
    </Modal>
  )
}

/**
 * 대화 이어받기 체크박스의 키. worktree 키에 접두사를 붙여 같은 선택 집합에 담는다 —
 * 두 개의 Set 을 따로 들면 항목을 지울 때마다 둘을 같이 손봐야 하고, 한쪽만 지우는 사고가 난다.
 */
function sessionKey(workspaceKey: string): string {
  return `session:${workspaceKey}`
}

/** 아직 들여오지 않은 것만 기본 선택한다. 대화 이어받기도 기본은 켜짐이다. */
function defaultKeys(repo: MigrationRepoCandidate): string[] {
  const pending = repo.workspaces.filter((ws) => !ws.alreadyImported)
  return [
    ...(repo.alreadyAdded ? [] : [repo.key]),
    ...pending.map((ws) => ws.key),
    ...pending.filter((ws) => ws.session).map((ws) => sessionKey(ws.key))
  ]
}

function RepoRow({
  repo,
  selected,
  onToggle
}: {
  repo: MigrationRepoCandidate
  selected: Set<string>
  onToggle: (key: string, on: boolean) => void
}): React.JSX.Element {
  // 리포 체크를 끄면 그 안의 worktree 도 갈 곳이 없다. 그래서 리포를 끄면 자식도 함께 끈다.
  const repoOn = repo.alreadyAdded || selected.has(repo.key)
  const setRepo = (on: boolean): void => {
    onToggle(repo.key, on)
    if (!on)
      for (const ws of repo.workspaces) {
        onToggle(ws.key, false)
        onToggle(sessionKey(ws.key), false)
      }
  }
  const carried = [
    repo.setupScript ? 'setup command' : '',
    repo.runScripts.length > 0 ? 'dev command' : '',
    repo.archiveScript ? 'archive command' : ''
  ].filter(Boolean)

  return (
    <div className="px-4 py-3">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={repoOn}
          disabled={repo.alreadyAdded}
          onChange={(event) => setRepo(event.target.checked)}
        />
        <FolderGit2 size={15} className="mt-0.5 shrink-0 text-neutral-500" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-200">{repo.name}</span>
            {repo.alreadyAdded ? (
              <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
                <Check size={11} /> already added
              </span>
            ) : (
              repo.sourceLabel && (
                <span className="rounded-full border border-[var(--border-2)] px-1.5 text-xs text-neutral-500">
                  from {repo.sourceLabel}
                </span>
              )
            )}
          </span>
          <span className="block truncate text-xs text-neutral-600" title={repo.path}>
            {repo.path}
          </span>
          {carried.length > 0 && !repo.alreadyAdded && (
            <span className="block text-xs text-neutral-500">Brings its {carried.join(', ')}</span>
          )}
        </span>
      </label>

      {repo.workspaces.length > 0 && (
        <div className="mt-2 ml-8 space-y-2">
          {repo.workspaces.map((ws) => {
            const disabled = ws.alreadyImported || !repoOn
            return (
              <div key={ws.key}>
                <label
                  className={`flex items-center gap-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
                >
                  <input
                    type="checkbox"
                    checked={ws.alreadyImported || selected.has(ws.key)}
                    disabled={disabled}
                    onChange={(event) => {
                      onToggle(ws.key, event.target.checked)
                      // worktree 를 빼면 그 대화를 이어받을 자리도 사라진다.
                      if (!event.target.checked) onToggle(sessionKey(ws.key), false)
                    }}
                  />
                  <GitBranch size={13} className="shrink-0 text-neutral-600" />
                  <span className="min-w-0 truncate text-sm text-neutral-300">{ws.name}</span>
                  <span className="min-w-0 truncate text-xs text-neutral-600">{ws.branch}</span>
                  {ws.alreadyImported && (
                    <span className="shrink-0 text-xs text-neutral-600">already in Wooi</span>
                  )}
                </label>

                {/* 대화 이어받기는 worktree 와 따로 고른다 — 이어받으면 첫 턴이 지난 맥락을
                    통째로 다시 읽어 토큰을 크게 쓴다. 켜고 끄는 선택이 눈에 보여야 한다. */}
                {ws.session && !ws.alreadyImported && (
                  <label
                    className={`mt-1 ml-6 flex items-center gap-2 ${!selected.has(ws.key) || !repoOn ? 'opacity-50' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(sessionKey(ws.key))}
                      disabled={!selected.has(ws.key) || !repoOn}
                      onChange={(event) => onToggle(sessionKey(ws.key), event.target.checked)}
                    />
                    <MessageSquare size={12} className="shrink-0 text-neutral-600" />
                    <span className="shrink-0">
                      <AgentBackendMark backend={ws.session.backend} size={11} />
                    </span>
                    <span className="min-w-0 truncate text-xs text-neutral-400">
                      Continue “{ws.session.label}” and bring its messages
                    </span>
                  </label>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
