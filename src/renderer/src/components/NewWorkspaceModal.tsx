import { useState } from 'react'
import { Copy, GitBranch } from 'lucide-react'
import {
  FANOUT_MAX_SLOTS,
  FANOUT_MIN_SLOTS,
  fanoutSlotName,
  workspaceDisplayName
} from '@shared/types'
import type { AgentBackendId, FanoutSlot } from '@shared/types'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import { sanitizePreview } from '../lib/format'
import { useAvailableBackends } from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'

/** 후보 수 선택지. 하나는 fan-out 이 아니고, 다섯이면 한 화면에서 나란히 비교할 수 없다. */
const SLOT_COUNTS = Array.from(
  { length: FANOUT_MAX_SLOTS - FANOUT_MIN_SLOTS + 1 },
  (_, i) => FANOUT_MIN_SLOTS + i
)

export default function NewWorkspaceModal({
  repoId,
  parentWorkspaceId = null,
  initialAgentBackend,
  fanout = false,
  onClose
}: {
  repoId: string
  /** 지정하면 이 워크스페이스 위에 stacked 로 만든다(base = 부모 브랜치). */
  parentWorkspaceId?: string | null
  /** 사이드바에서 특정 에이전트의 + 버튼을 눌렀다면 그 선택을 생성 모달까지 유지한다. */
  initialAgentBackend?: AgentBackendId
  /**
   * fan-out 모드로 연다 — 같은 프롬프트를 후보 여럿에게 동시에 던진다.
   * 스택 생성과는 함께 쓸 수 없다(후보는 전부 기본 브랜치에서 갈라진다).
   */
  fanout?: boolean
  onClose: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((r) => r.id === repoId)!
  const manualSetup = app.settings.manualWorkspaceSetup
  const parent = parentWorkspaceId
    ? app.workspaces.find((w) => w.id === parentWorkspaceId)
    : undefined
  const [name, setName] = useState('')

  // 에이전트는 생성 시 정해져 **세션 내내 고정**된다. 쓸 수 있는 에이전트가 하나뿐이면
  // 물어볼 이유가 없으므로 피커를 감추고 그 하나로 만든다.
  const available = useAvailableBackends()
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>(
    () => initialAgentBackend ?? parent?.agentBackend ?? app.settings.defaultAgentBackend
  )
  const showPicker = available.length > 1
  // 기본 백엔드를 쓸 수 없으면(CLI 제거 등) 쓸 수 있는 것으로 대체한다.
  const effectiveBackend =
    available.some((b) => b.id === agentBackend) || available.length === 0
      ? agentBackend
      : available[0].id

  // Solo/팀은 여기서 묻지 않는다. 팀은 워크스페이스의 **종류**가 아니라 언제든 켤 수 있는
  // 능력이고, 무엇을 위임할 만한지는 만드는 순간이 아니라 대화 중에 드러난다 — 가장 모르는
  // 때에 고르게 하는 셈이라 그 선택지를 뺐다. 새 워크스페이스는 언제나 Solo 로 시작하고,
  // 전환은 헤더 배지·사이드바 메뉴·switch_to_agent_team 이 맡는다.

  // ── fan-out ────────────────────────────────────────────────────────────
  // 스택 자식은 부모 브랜치 위에 쌓이는 수직 관계라 후보를 여럿 둘 자리가 없다. 그래서 스택
  // 생성으로 열렸으면 fan-out 은 아예 없는 것으로 친다(모드 전환도 막는다).
  const canFanout = !parent
  const [prompt, setPrompt] = useState('')
  const [slotCount, setSlotCount] = useState(FANOUT_MIN_SLOTS)
  // 후보별 에이전트. 기본은 전부 위에서 고른 것과 같고, 여기서 슬롯마다 바꿀 수 있다.
  // 길이는 최대치로 고정해 두어, 후보 수를 줄였다 늘려도 골라 둔 값이 살아 있게 한다.
  const [slotBackends, setSlotBackends] = useState<(AgentBackendId | null)[]>(() =>
    Array.from({ length: FANOUT_MAX_SLOTS }, () => null)
  )
  const backendForSlot = (i: number): AgentBackendId => slotBackends[i] ?? effectiveBackend

  const nameHint = name.trim() ? sanitizePreview(name) : ''

  // 닫고 즉시 사이드바에 스피너 행을 띄운다(worktree 준비는 백그라운드). 실패는 토스트로 알린다.
  const create = (): void => {
    const trimmed = name.trim()
    if (manualSetup && !trimmed) return
    void useStore.getState().createWorkspace(
      repoId,
      {
        // 자동 설정에서는 이름을 비워 main 의 고유 이름 생성기를 그대로 사용한다.
        ...(manualSetup ? { name: trimmed } : {}),
        parentWorkspaceId,
        agentBackend: effectiveBackend
        // multiAgent 는 넘기지 않는다 — main 이 Solo 로 만든다.
      },
      manualSetup ? trimmed : undefined
    )
    onClose()
  }

  const createFanout = (): void => {
    if (!prompt.trim()) return
    const slots: FanoutSlot[] = Array.from({ length: slotCount }, (_, i) => ({
      agentBackend: backendForSlot(i)
    }))
    void useStore
      .getState()
      .createFanout(repoId, { name: name.trim(), prompt: prompt.trim(), slots })
    onClose()
  }

  const submit = fanout ? createFanout : create
  // fan-out 이 요구하는 것은 프롬프트뿐이다 — 이름은 비워 두면 main 이 짓는다. 일반 생성은
  // 수동 설정일 때만 이름을 요구한다(자동 설정에서는 애초에 입력칸이 없다).
  const canSubmit = fanout ? !!prompt.trim() : !manualSetup || !!name.trim()

  return (
    <Modal
      title={
        fanout
          ? `Fan out · ${repo.name}`
          : parent
            ? `Stack workspace · ${repo.name}`
            : `New workspace · ${repo.name}`
      }
      onClose={onClose}
      width={fanout ? 560 : 460}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={submit} disabled={!canSubmit}>
            {fanout ? `Create ${slotCount} workspaces` : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {fanout && (
          <div>
            <label className={labelClass}>Prompt</label>
            <textarea
              autoFocus
              rows={4}
              className={`${inputClass} resize-y leading-relaxed`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
              placeholder="e.g. Add rate limiting to the public API"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Every candidate gets this exact prompt and starts working immediately. They branch
              from <span className="text-neutral-400">origin/{repo.defaultBranch}</span> and cannot
              see each other — ⌘↵ to send.
            </p>
          </div>
        )}

        {fanout && (
          <div>
            <label className={labelClass}>Candidates</label>
            <div className="flex gap-1.5">
              {SLOT_COUNTS.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setSlotCount(count)}
                  className={
                    'flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (slotCount === count
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  {count}
                </button>
              ))}
            </div>
            {showPicker && (
              <div className="mt-2 space-y-1">
                {Array.from({ length: slotCount }, (_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate font-mono text-xs text-neutral-500">
                      {fanoutSlotName(nameHint || 'auto-name', i)}
                    </span>
                    <div className="flex flex-1 gap-1.5">
                      {available.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() =>
                            setSlotBackends((prev) => {
                              const next = prev.slice()
                              next[i] = b.id
                              return next
                            })
                          }
                          className={
                            'flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition-colors ' +
                            (backendForSlot(i) === b.id
                              ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                              : 'border-[var(--border)] text-neutral-400 hover:bg-[var(--surface-2)]')
                          }
                        >
                          <AgentBackendMark backend={b.id} size={12} />
                          {b.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-xs text-neutral-600">
              {showPicker
                ? 'Give candidates different agents to compare how each one solves it.'
                : `${slotCount} workspaces run the same prompt in parallel, and you keep the one you like.`}
            </p>
          </div>
        )}

        {/* 자동 설정에서는 이름을 묻지 않는다(main 의 생성기가 짓는다). fan-out 은 예외로 늘
            보여 주되 **선택**이다 — 후보 브랜치의 공통 뿌리라, 지어 두면 사이드바에서 이 묶음을
            부를 이름이 생기고 비워 두면 그것도 자동으로 지어진다. */}
        {(fanout || manualSetup) && (
          <div>
            <label className={labelClass}>{fanout ? 'Name (optional)' : 'Name'}</label>
            <input
              autoFocus={!fanout}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !fanout && create()}
              placeholder={fanout ? 'e.g. rate-limit (auto if left blank)' : 'e.g. fix login bug'}
            />
            {nameHint && (
              <p className="mt-1.5 text-xs text-neutral-600">
                Creates {fanout ? 'branches ' : 'branch '}
                <span className="text-neutral-400">
                  {fanout
                    ? `${fanoutSlotName(nameHint, 0)} … ${fanoutSlotName(nameHint, slotCount - 1)}`
                    : nameHint}
                </span>
                .
              </p>
            )}
          </div>
        )}

        {canFanout && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-neutral-500">
            {fanout ? (
              <Copy size={13} className="mt-0.5 shrink-0" />
            ) : (
              <GitBranch size={13} className="mt-0.5 shrink-0" />
            )}
            <p className="flex-1 leading-relaxed">
              {fanout
                ? 'Fan-out sends one prompt to several workspaces so you can compare the results side by side.'
                : 'Not sure which approach will work? Fan out the same prompt to several workspaces and compare.'}
            </p>
          </div>
        )}

        {/* fan-out 은 후보마다 에이전트를 따로 고르므로 단일 피커를 겹쳐 보여 주지 않는다. */}
        {showPicker && !fanout && (
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
                  {parent?.agentBackend === b.id && (
                    <span className="text-[10px] text-neutral-500">Inherited</span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              A workspace stays on the agent it was created with.
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
              {fanout ? 'Every candidate branches' : 'Branches'} from the latest{' '}
              <span className="text-neutral-400">origin/{repo.defaultBranch}</span> (fetched first).
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
