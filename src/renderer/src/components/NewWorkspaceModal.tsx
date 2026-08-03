import { useState } from 'react'
import { experimentsOf, workspaceDisplayName } from '@shared/types'
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

  // 멀티 에이전트는 **모드**다 — 어떤 종류를 쓸지 여기서 고르지 않는다. 켜 두면 대화에서
  // "Codex 한테 시켜줘" 라고 말하는 것으로 종류가 정해진다.
  const [multiAgent, setMultiAgent] = useState(false)
  // 에이전트가 둘 이상 있고, 고른 메인이 조율하는 쪽이 될 수 있을 때만 모드를 제안한다.
  const showModePicker =
    experimentsOf(app.settings).multiAgent &&
    available.length > 1 &&
    Boolean(available.find((b) => b.id === effectiveBackend)?.capabilities.delegate)
  // 메인을 조율 불가 백엔드로 바꾸면 모드도 함께 꺼진 것으로 읽는다(체크는 남겨 두고 되돌아오면 살아난다).
  const effectiveMultiAgent = multiAgent && showModePicker

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
        ...(effectiveMultiAgent ? { multiAgent: true } : {})
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

        {showModePicker && (
          <div>
            <label className={labelClass}>Mode</label>
            <div className="flex gap-1.5">
              {[
                { on: false, label: 'Single agent', hint: 'One agent does the work.' },
                {
                  on: true,
                  label: 'Multi-agent',
                  hint: 'The main agent can run tasks with other agents.'
                }
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setMultiAgent(option.on)}
                  className={
                    'flex-1 text-left text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (effectiveMultiAgent === option.on
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <div className="font-medium">{option.label}</div>
                  <div className="mt-0.5 text-xs text-neutral-500">{option.hint}</div>
                </button>
              ))}
            </div>
            {effectiveMultiAgent && (
              <p className="mt-1.5 text-xs text-neutral-600">
                Experimental. You don&apos;t pick the other agents here — just ask in the chat
                (&ldquo;have Codex review this&rdquo;) and the main agent runs them for you.
              </p>
            )}
          </div>
        )}

        {showPicker && (
          <div>
            <label className={labelClass}>{effectiveMultiAgent ? 'Main agent' : 'Agent'}</label>
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
              {effectiveMultiAgent
                ? 'The agent you talk to. It stays fixed for the life of the workspace.'
                : 'A workspace stays on the agent it was created with.'}
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
