import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Search } from 'lucide-react'
import type { AgentBackendId, IssueCandidate } from '@shared/types'
import { useStore } from '../store'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from './Modal'
import { useAvailableBackends, useDefaultBackend } from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'

export default function NewFromIssueModal({
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
  const [issues, setIssues] = useState<IssueCandidate[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<IssueCandidate | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.repo.listIssues(repoId).then((list) => {
      if (alive) setIssues(list)
    })
    return () => {
      alive = false
    }
  }, [repoId])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^#/, '')
    if (!needle) return issues ?? []
    return (issues ?? []).filter(
      (issue) => String(issue.number).includes(needle) || issue.title.toLowerCase().includes(needle)
    )
  }, [issues, query])

  const create = async (): Promise<void> => {
    if (!picked || busy) return
    setBusy(true)
    const body = await window.api.repo.getIssueBody(repoId, picked.number)
    if (body === null) {
      useStore.getState().pushToast('error', 'Could not load the issue body.')
      setBusy(false)
      return
    }
    const workspaceId = await useStore
      .getState()
      .createWorkspace(repoId, { name: picked.title, agentBackend: effectiveBackend }, picked.title)
    if (!workspaceId) {
      setBusy(false)
      return
    }
    const draft = [`#${picked.number} ${picked.title}`, picked.url, body].join('\n\n').trimEnd()
    useStore.getState().setDraft(workspaceId, draft)
    onClose()
  }

  return (
    <Modal
      title={`New from issue${repo ? ` · ${repo.name}` : ''}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={() => void create()} disabled={!picked || busy}>
            {busy ? 'Creating…' : 'Create'}
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
          <label className={labelClass} htmlFor="issue-filter">
            Issue
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-neutral-500" />
            <input
              id="issue-filter"
              className={`${inputClass} pl-9`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title or number"
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border)]">
          {issues === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500">
              <Loader2 size={15} className="animate-spin" /> Loading issues…
            </div>
          ) : issues.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">
              No open issues found. GitHub may not be connected.
            </p>
          ) : matches.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-neutral-500">No matching issues.</p>
          ) : (
            matches.map((issue) => {
              const selected = picked?.number === issue.number
              return (
                <button
                  key={issue.number}
                  type="button"
                  onClick={() => setPicked(issue)}
                  className={`flex w-full gap-3 border-b border-[var(--border)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--surface-2)] ${selected ? 'bg-[var(--surface-2)]' : ''}`}
                >
                  <span className="w-10 shrink-0 text-xs tabular-nums text-neutral-500">
                    #{issue.number}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-200">{issue.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                      <span>@{issue.author || 'unknown'}</span>
                      {issue.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full bg-[var(--surface-3)] px-1.5 py-0.5"
                        >
                          {label}
                        </span>
                      ))}
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
