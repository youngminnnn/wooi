import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderGit2, GitBranch, Loader2 } from 'lucide-react'
import type { MigrationRepoCandidate, MigrationScan } from '@shared/types'
import { useStore } from '../store'
import Modal, { ghostBtn, primaryBtn } from './Modal'

/**
 * Conductor·Orca 에서 옮겨오기.
 *
 * 화면이 답해야 하는 질문은 둘뿐이다 — **무엇이 옮겨지는가**, 그리고 **원래 도구는 어떻게
 * 되는가**. 두 번째가 특히 중요하다: 이 기능은 worktree 를 있던 자리에 그대로 두고 Wooi 가
 * 같은 디렉터리를 가리키게만 하므로, 지워지는 것도 옮겨지는 것도 없다. 그 사실을 모달 안에
 * 못 박아 두지 않으면 사용자는 "다른 앱의 작업이 사라질까 봐" 버튼을 누르지 않는다.
 */
export default function MigrateModal({ onClose }: { onClose: () => void }): React.JSX.Element {
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
      .scan()
      .then((next) => {
        if (!active) return
        setScan(next)
        // 아직 안 옮긴 것은 기본으로 전부 고른다. 여기까지 온 사람은 옮기러 온 것이고,
        // 빼고 싶은 항목이 있으면 체크를 끄는 편이 하나씩 켜는 것보다 짧다.
        setSelected(new Set(next.sources.flatMap((source) => source.repos.flatMap(defaultKeys))))
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [])

  const toggle = (key: string, on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const repos = scan?.sources.flatMap((source) => source.repos) ?? []
  const chosenRepos = repos.filter((repo) => selected.has(repo.key) && !repo.alreadyAdded)
  const chosenWorkspaces = repos.flatMap((repo) =>
    repo.workspaces.filter((ws) => selected.has(ws.key) && !ws.alreadyImported)
  )
  const nothingChosen = chosenRepos.length === 0 && chosenWorkspaces.length === 0

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.migrate.run({
        repoKeys: [...selected].filter((key) => key.includes(':repo:')),
        workspaceKeys: [...selected].filter((key) => key.includes(':ws:'))
      })
      const parts: string[] = []
      if (result.repos > 0)
        parts.push(`${result.repos} repositor${result.repos === 1 ? 'y' : 'ies'}`)
      if (result.workspaces > 0)
        parts.push(`${result.workspaces} workspace${result.workspaces === 1 ? '' : 's'}`)
      pushToast(
        result.errors.length > 0 ? 'error' : 'success',
        parts.length > 0
          ? `Imported ${parts.join(' and ')}.${result.errors.length > 0 ? ` ${result.errors.length} item(s) failed: ${result.errors[0]}` : ''}`
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
      title="Import from Conductor or Orca"
      onClose={busy ? (): void => undefined : onClose}
      width={620}
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
          Looking for Conductor and Orca data…
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 text-sm text-[var(--danger-400)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {scan && scan.sources.length === 0 && !error && (
        <div className="py-6 text-center text-sm text-neutral-500 leading-relaxed">
          <p className="text-neutral-300">Nothing left to import.</p>
          <p className="mt-1.5">
            Wooi looks for Conductor&rsquo;s database and Orca&rsquo;s data file on this Mac.
            Repositories you already added and worktrees you already imported are not listed again.
          </p>
        </div>
      )}

      {scan && scan.sources.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-400 leading-relaxed">
            Wooi points at the worktrees these tools already created —{' '}
            <b className="text-neutral-300">nothing is moved, copied or deleted</b>, and Conductor
            and Orca keep working as before.
          </p>

          {scan.sources.map((source) => (
            <div key={source.id} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h4 className="text-sm font-semibold text-neutral-200">{source.label}</h4>
                <span className="min-w-0 truncate text-xs text-neutral-600" title={source.dataPath}>
                  {source.dataPath}
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
                {source.repos.map((repo) => (
                  <RepoRow key={repo.key} repo={repo} selected={selected} onToggle={toggle} />
                ))}
              </div>
            </div>
          ))}

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

/** 아직 옮기지 않은 것만 기본 선택한다. */
function defaultKeys(repo: MigrationRepoCandidate): string[] {
  return [
    ...(repo.alreadyAdded ? [] : [repo.key]),
    ...repo.workspaces.filter((ws) => !ws.alreadyImported).map((ws) => ws.key)
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
    if (!on) for (const ws of repo.workspaces) onToggle(ws.key, false)
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
            {repo.alreadyAdded && (
              <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
                <Check size={11} /> already added
              </span>
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
        <div className="mt-2 ml-8 space-y-1.5">
          {repo.workspaces.map((ws) => (
            <label
              key={ws.key}
              className={`flex items-center gap-2.5 ${ws.alreadyImported || !repoOn ? 'opacity-50' : 'cursor-pointer'}`}
            >
              <input
                type="checkbox"
                checked={ws.alreadyImported || selected.has(ws.key)}
                disabled={ws.alreadyImported || !repoOn}
                onChange={(event) => onToggle(ws.key, event.target.checked)}
              />
              <GitBranch size={13} className="shrink-0 text-neutral-600" />
              <span className="min-w-0 truncate text-sm text-neutral-300">{ws.name}</span>
              <span className="min-w-0 truncate text-xs text-neutral-600">{ws.branch}</span>
              {ws.alreadyImported && (
                <span className="shrink-0 text-xs text-neutral-600">already in Wooi</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
