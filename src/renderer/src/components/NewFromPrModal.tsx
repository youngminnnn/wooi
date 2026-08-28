import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Search } from 'lucide-react'
import type { AgentBackendId, PrCandidate, Workspace } from '@shared/types'
import { useStore } from '../store'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from './Modal'
import { useAvailableBackends, useDefaultBackend } from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'

type PickedPr = { candidate: PrCandidate; workspace?: Workspace }

export default function NewFromPrModal({
  repoId,
  onClose
}: {
  repoId: string
  onClose: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((item) => item.id === repoId)
  const available = useAvailableBackends()
  const defaultBackend = useDefaultBackend()
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>(() => defaultBackend)
  const effectiveBackend =
    available.some((backend) => backend.id === agentBackend) || available.length === 0
      ? agentBackend
      : available[0].id
  const [prs, setPrs] = useState<PrCandidate[] | null>(null)
  const [query, setQuery] = useState('')
  const [resolvedPr, setResolvedPr] = useState<PrCandidate | null>(null)
  const [resolving, setResolving] = useState(false)
  const [picked, setPicked] = useState<PickedPr | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.repo.listPrs(repoId).then((list) => {
      if (alive) setPrs(list)
    })
    return () => {
      alive = false
    }
  }, [repoId])

  useEffect(() => {
    const reference = query.trim()
    const looksLikeReference =
      /^#?\d+$/.test(reference) ||
      /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/i.test(reference)
    if (!looksLikeReference) {
      setResolvedPr(null)
      setResolving(false)
      return
    }
    let alive = true
    setResolving(true)
    const timer = window.setTimeout(() => {
      void window.api.repo
        .resolvePr(repoId, reference)
        .then((candidate) => {
          if (alive) setResolvedPr(candidate)
        })
        .catch(() => {
          // 직접 조회는 열린 목록에 더하는 보조 경로라, 실패가 기존 결과를 가려서는 안 된다.
          if (alive) setResolvedPr(null)
        })
        .finally(() => {
          if (alive) setResolving(false)
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query, repoId])

  const existingByPr = useMemo(
    () =>
      new Map(
        app.workspaces
          .filter((workspace) => workspace.repoId === repoId && workspace.prNumber !== undefined)
          .map((workspace) => [workspace.prNumber, workspace])
      ),
    [app.workspaces, repoId]
  )

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^#/, '')
    if (!needle) return prs ?? []
    return (prs ?? []).filter(
      (pr) =>
        String(pr.number).includes(needle) ||
        pr.title.toLowerCase().includes(needle) ||
        pr.author.toLowerCase().includes(needle) ||
        pr.head.toLowerCase().includes(needle) ||
        pr.base.toLowerCase().includes(needle)
    )
  }, [prs, query])

  const visible = useMemo(
    () => [
      ...(resolvedPr && !matches.some((candidate) => candidate.number === resolvedPr.number)
        ? [resolvedPr]
        : []),
      ...matches
    ],
    [matches, resolvedPr]
  )

  const actionLabel = picked?.workspace
    ? picked.workspace.archived
      ? 'Restore'
      : 'Open'
    : 'Create'

  const act = async (): Promise<void> => {
    if (!picked || busy) return
    setBusy(true)

    if (picked.workspace) {
      if (picked.workspace.archived) {
        const res = await window.api.workspace.unarchive(picked.workspace.id)
        if (res.error) {
          useStore.getState().pushToast('error', res.error)
          setBusy(false)
          return
        }
      }
      await useStore.getState().selectWorkspace(picked.workspace.id)
      onClose()
      return
    }

    const body = await window.api.repo.getPrBody(repoId, picked.candidate.number)
    if (body === null) {
      useStore.getState().pushToast('error', 'Could not load the pull request body.')
      setBusy(false)
      return
    }
    const workspaceId = await useStore
      .getState()
      .createWorkspace(
        repoId,
        { fromPrNumber: picked.candidate.number, agentBackend: effectiveBackend },
        picked.candidate.title
      )
    if (!workspaceId) {
      setBusy(false)
      return
    }
    // 내 PR은 이어서 작업하는 자리라 지시문이 방해가 되지만, 남의 PR은 맥락을 먼저 건네야 한다.
    if (!picked.candidate.isViewerAuthor) {
      const draft = [
        `#${picked.candidate.number} ${picked.candidate.title}`,
        picked.candidate.url ?? '',
        body
      ]
        .join('\n\n')
        .trimEnd()
      useStore.getState().setDraft(workspaceId, draft)
    }
    onClose()
  }

  return (
    <Modal
      title={`New from PR${repo ? ` · ${repo.name}` : ''}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={() => void act()} disabled={!picked || busy}>
            {busy ? `${actionLabel}…` : actionLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {available.length > 1 && (
          <div>
            <label className={labelClass}>Agent</label>
            <div className="flex gap-1.5">
              {available.map((backend) => (
                <button
                  key={backend.id}
                  type="button"
                  onClick={() => setAgentBackend(backend.id)}
                  className={
                    'flex-1 flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (effectiveBackend === backend.id
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <AgentBackendMark backend={backend.id} size={15} />
                  {backend.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              The workspace stays on the agent it was created with.
            </p>
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="pr-filter">
            Pull request
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-neutral-500" />
            <input
              id="pr-filter"
              className={`${inputClass} pl-9`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title, number, author, or branch"
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border)]">
          {prs === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500">
              <Loader2 size={15} className="animate-spin" /> Loading pull requests…
            </div>
          ) : resolving && visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">
              Looking up pull request…
            </p>
          ) : prs.length === 0 && visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">
              No open pull requests found. GitHub may not be connected.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">
              No matching pull requests.
            </p>
          ) : (
            visible.map((pr) => {
              const workspace = existingByPr.get(pr.number)
              const disabled = !workspace && pr.canCreateWorkspace === false
              const selected = picked?.candidate.number === pr.number
              return (
                <button
                  key={pr.number}
                  type="button"
                  disabled={disabled}
                  onClick={() => setPicked({ candidate: pr, workspace })}
                  title={disabled ? pr.createWorkspaceDisabledReason : undefined}
                  className={`flex w-full gap-3 border-b border-[var(--border)] px-3 py-2.5 text-left last:border-b-0 ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--surface-2)]'} ${selected ? 'bg-[var(--surface-2)]' : ''}`}
                >
                  <span className="w-10 shrink-0 text-xs tabular-nums text-neutral-500">
                    #{pr.number}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-200">
                      {pr.title}
                      {pr.isDraft && (
                        <span className="ml-2 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] text-neutral-500">
                          Draft
                        </span>
                      )}
                      {pr.state && pr.state !== 'OPEN' && (
                        <span className="ml-2 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] text-neutral-400">
                          {pr.state === 'MERGED' ? 'Merged' : 'Closed'}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                      <span>@{pr.author || 'unknown'}</span>
                      <span>
                        {pr.head} → {pr.base}
                      </span>
                      {workspace && (
                        <span className="rounded-full bg-[var(--surface-3)] px-1.5 py-0.5">
                          {workspace.archived ? 'Archived · Restore' : 'Workspace open'}
                        </span>
                      )}
                      {disabled && <span>{pr.createWorkspaceDisabledReason}</span>}
                      {pr.state === 'MERGED' && (
                        <span>
                          The branch will be checked out, but this PR will not accept further
                          pushes.
                        </span>
                      )}
                    </span>
                  </span>
                  {selected && <Check size={15} className="shrink-0 text-[var(--info-400)]" />}
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}
