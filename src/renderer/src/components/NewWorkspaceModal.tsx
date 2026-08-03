import { useState } from 'react'
import { AGENT_BACKEND_LABELS, experimentsOf, workspaceDisplayName } from '@shared/types'
import type { AgentBackendId } from '@shared/types'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import { sanitizePreview } from '../lib/format'
import { useAvailableBackends } from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'

export default function NewWorkspaceModal({
  repoId,
  parentWorkspaceId = null,
  onClose
}: {
  repoId: string
  /** 지정하면 이 워크스페이스 위에 stacked 로 만든다(base = 부모 브랜치). */
  parentWorkspaceId?: string | null
  onClose: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((r) => r.id === repoId)!
  const parent = parentWorkspaceId
    ? app.workspaces.find((w) => w.id === parentWorkspaceId)
    : undefined
  const [name, setName] = useState('')

  // 에이전트는 생성 시 정해져 **세션 내내 고정**된다. 쓸 수 있는 에이전트가 하나뿐이면
  // 물어볼 이유가 없으므로 피커를 감추고 그 하나로 만든다.
  const available = useAvailableBackends()
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>(
    () => app.settings.defaultAgentBackend
  )
  const showPicker = available.length > 1
  // 기본 백엔드를 쓸 수 없으면(CLI 제거 등) 쓸 수 있는 것으로 대체한다.
  const effectiveBackend =
    available.some((b) => b.id === agentBackend) || available.length === 0
      ? agentBackend
      : available[0].id

  // 위임 대상 후보 = 쓸 수 있는 백엔드 중 메인이 아닌 것. 실험 기능이 꺼져 있거나 후보가 없으면
  // (에이전트가 하나뿐인 사용자) 이 블록은 통째로 나오지 않는다.
  const [subBackends, setSubBackends] = useState<AgentBackendId[]>([])
  const canDelegate =
    experimentsOf(app.settings).multiAgent &&
    // 조율하는 쪽이 될 수 있는 백엔드에서만 묻는다(capabilities.delegate).
    Boolean(available.find((b) => b.id === effectiveBackend)?.capabilities.delegate)
  const delegateCandidates = available.filter((b) => b.id !== effectiveBackend)
  const showDelegation = canDelegate && delegateCandidates.length > 0

  const toggleSub = (id: AgentBackendId): void => {
    setSubBackends((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // 닫고 즉시 사이드바에 스피너 행을 띄운다(worktree 준비는 백그라운드). 실패는 토스트로 알린다.
  const create = (): void => {
    if (!name.trim()) return
    const trimmed = name.trim()
    void useStore.getState().createWorkspace(
      repoId,
      {
        name: trimmed,
        parentWorkspaceId,
        agentBackend: effectiveBackend,
        // 메인을 바꿔 후보에서 빠진 값이 남아 있을 수 있으므로 여기서 한 번 더 거른다
        // (main 도 multiAgentConfigFrom 에서 같은 판단을 한다).
        ...(showDelegation
          ? { subBackends: subBackends.filter((id) => id !== effectiveBackend) }
          : {})
      },
      trimmed
    )
    onClose()
  }

  return (
    <Modal
      title={parent ? `Stack workspace · ${repo.name}` : `New workspace · ${repo.name}`}
      onClose={onClose}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={create} disabled={!name.trim()}>
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelClass}>Name</label>
          <input
            autoFocus
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="e.g. fix login bug"
          />
          {name.trim() && (
            <p className="mt-1.5 text-xs text-neutral-600">
              Creates branch <span className="text-neutral-400">{sanitizePreview(name)}</span>.
            </p>
          )}
        </div>

        {showPicker && (
          <div>
            <label className={labelClass}>Agent</label>
            <div className="flex gap-1.5">
              {available.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setAgentBackend(b.id)}
                  className={
                    'flex-1 flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (effectiveBackend === b.id
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <AgentBackendMark backend={b.id} size={15} />
                  {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              A workspace stays on the agent it was created with.
            </p>
          </div>
        )}

        {showDelegation && (
          <div>
            <label className={labelClass}>Delegate to (experimental)</label>
            <div className="flex gap-1.5">
              {delegateCandidates.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => toggleSub(b.id)}
                  className={
                    'flex-1 flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (subBackends.includes(b.id)
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <AgentBackendMark backend={b.id} size={15} />
                  {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              {AGENT_BACKEND_LABELS[effectiveBackend]} can hand a task to these agents and wait for
              the answer. They run in this worktree — you don&apos;t drive them directly.
            </p>
          </div>
        )}

        <div>
          <label className={labelClass}>Base branch</label>
          {parent ? (
            <p className="text-xs text-neutral-600">
              Stacked on <span className="text-neutral-400">{workspaceDisplayName(parent)}</span> —
              branches from <span className="text-neutral-400">{parent.branch}</span>. Its PR will
              target that branch.
            </p>
          ) : (
            <p className="text-xs text-neutral-600">
              Branches from the latest{' '}
              <span className="text-neutral-400">origin/{repo.defaultBranch}</span> (fetched first).
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
