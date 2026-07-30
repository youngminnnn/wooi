import { useEffect, useRef, useState } from 'react'
import type { CarryItem, CarryMode } from '@shared/types'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'

// Carry 경로 행 전용 클래스.
// inputClass/ghostBtn 에 w-[…]·px-[…] 를 덧붙여 덮어쓰려 하면 안 된다 — Tailwind 는 충돌하는
// 유틸리티를 "클래스 문자열 순서"가 아니라 "생성된 CSS 순서"로 해결한다. 실제로 inputClass 의
// w-full 이 w-[5.5rem] 을 이겨서 select 가 행 전체(486px)를 차지하고, shrink-0 때문에 줄지도
// 않아 경로 입력창이 26px 로 찌그러졌다(ghostBtn 의 px-3.5 도 px-2 를 이겼다).
// 그래서 여기서는 공용 상수를 조합하지 않고 필요한 유틸리티만 직접 쓴다.
const carryFieldBase =
  'bg-[var(--bg-2)] border border-[var(--border)] rounded-lg text-neutral-100 focus:outline-none focus:border-[var(--border-strong)] transition-colors'
// 경로가 주인공이므로 남는 공간을 전부 가져간다(min-w-0 없으면 긴 경로가 행을 밀어낸다).
const carryPathClass =
  carryFieldBase + ' flex-1 min-w-0 px-3 py-2 font-mono text-base placeholder:text-neutral-600'
// mode 와 삭제 버튼은 내용에 딱 맞게 좁게. self-stretch 로 높이는 입력창과 맞춘다.
const carryModeClass = carryFieldBase + ' shrink-0 self-stretch w-16 px-1.5 text-xs'
const carryRemoveClass =
  'shrink-0 self-stretch grid w-7 place-items-center rounded-lg border border-[var(--border-2)] text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100'

export default function RepoConfigModal({
  repoId,
  onClose
}: {
  repoId: string
  onClose: () => void
}): React.JSX.Element | null {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((r) => r.id === repoId)
  // 리포가 제거되면(예: 아래 removeRepo) main 의 state 브로드캐스트가 onClose 보다 먼저 도착해
  // 이 모달이 사라진 리포로 한 번 더 렌더된다. 비널 단언으로 repo.name 등에 접근하면 렌더 중
  // TypeError 가 나고, 에러 바운더리가 없어 앱 전체가 멈춘다(먹통). repo 가 없으면 닫고 빠진다.
  const [name, setName] = useState(repo?.name ?? '')
  const [setupScript, setSetup] = useState(repo?.setupScript ?? '')
  const [devScript, setDev] = useState(repo?.devScript ?? '')
  const [archiveScript, setArchive] = useState(repo?.archiveScript ?? '')
  const [carryItems, setCarryItems] = useState<CarryItem[]>(repo?.carryItems ?? [])

  const confirm = useStore((s) => s.confirm)

  useEffect(() => {
    if (!repo) onClose()
  }, [repo, onClose])

  // '+ Add path' 로 만든 빈 행에 포커스를 옮기기 위한 것들. 버튼에 포커스가 남으면 이어서 친
  // 글자가 아무 입력창에도 들어가지 않아 "입력이 안 된다"로 보인다(행은 늘었는데 타이핑만 무반응).
  const pathInputs = useRef<(HTMLInputElement | null)[]>([])
  const focusOnMount = useRef<number | null>(null)

  // 모든 훅 호출 뒤에서 가드한다(훅 규칙). repo 가 사라진 프레임에서는 아무것도 렌더하지 않고,
  // 위 useEffect 가 onClose 로 모달을 정리한다.
  if (!repo) return null

  const save = async (): Promise<void> => {
    await window.api.repo.update(repoId, {
      name: name.trim() || repo.name,
      setupScript,
      devScript,
      archiveScript,
      // 빈 줄은 저장하지 않는다 — 편집 중 잠깐 비워 둔 행이 그대로 남지 않도록.
      carryItems: carryItems
        .filter((i) => i.path.trim())
        .map((i) => ({ ...i, path: i.path.trim() }))
    })
    onClose()
  }

  const updateCarry = (index: number, patch: Partial<CarryItem>): void =>
    setCarryItems((items) => items.map((it, i) => (i === index ? { ...it, ...patch } : it)))

  const addCarryRow = (): void => {
    const lastIdx = carryItems.length - 1
    // 마지막 행이 아직 비어 있으면 빈 행을 또 만들지 않고 그 행으로 포커스만 옮긴다.
    if (lastIdx >= 0 && !carryItems[lastIdx].path.trim()) {
      pathInputs.current[lastIdx]?.focus()
      return
    }
    // 새 행의 input 은 아직 없으므로, 붙는 순간 ref 콜백에서 포커스한다.
    focusOnMount.current = carryItems.length
    setCarryItems((items) => [...items, { path: '', mode: 'copy' }])
  }

  const removeRepo = async (): Promise<void> => {
    const wsCount = app.workspaces.filter((w) => w.repoId === repoId).length
    const ok = await confirm({
      title: `Remove repository "${repo.name}"?`,
      body:
        wsCount > 0
          ? `${wsCount} workspace(s) and their worktree directories will also be removed. (Branches are kept.)`
          : undefined,
      confirmLabel: 'Remove repo',
      danger: true
    })
    if (!ok) return
    await window.api.repo.remove(repoId)
    onClose()
  }

  return (
    <Modal
      title={`Repository settings · ${repo.name}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button
            className={
              ghostBtn + ' mr-auto text-[var(--danger-400)] hover:bg-[var(--danger-500)]/15'
            }
            onClick={removeRepo}
          >
            Remove repo
          </button>
          <button className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelClass}>Display name</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1.5 text-xs text-neutral-600 truncate" title={repo.path}>
            {repo.path}
          </p>
        </div>

        <div>
          <label className={labelClass}>Setup script</label>
          <input
            className={inputClass + ' font-mono'}
            value={setupScript}
            onChange={(e) => setSetup(e.target.value)}
            placeholder="e.g. npm install"
          />
          <p className="mt-1.5 text-xs text-neutral-600">
            Runs once right after a workspace is created (if set).
          </p>
        </div>

        <div>
          <label className={labelClass}>Dev script</label>
          <input
            className={inputClass + ' font-mono'}
            value={devScript}
            onChange={(e) => setDev(e.target.value)}
            placeholder="e.g. npm run dev"
          />
          <p className="mt-1.5 text-xs text-neutral-600">
            Dev command you start/stop from the scripts panel. Each workspace gets a unique{' '}
            <span className="font-mono">$PORT</span> (also{' '}
            <span className="font-mono">$WOOI_DEV_PORT</span>) — use it so parallel dev processes
            don&rsquo;t collide, e.g. <span className="font-mono">vite --port $PORT</span>.
          </p>
        </div>

        <div>
          <label className={labelClass}>Archive script</label>
          <input
            className={inputClass + ' font-mono'}
            value={archiveScript}
            onChange={(e) => setArchive(e.target.value)}
            placeholder="e.g. docker compose down"
          />
          <p className="mt-1.5 text-xs text-neutral-600">
            Runs in the worktree when a workspace is archived (before the worktree is removed).
          </p>
        </div>

        <div>
          <label className={labelClass}>Carry into new workspaces</label>
          <p className="mb-2 text-xs text-neutral-600">
            New worktrees only contain git-tracked files, so ignored ones (
            <span className="font-mono">CLAUDE.local.md</span>,{' '}
            <span className="font-mono">.env</span>, …) are missing unless listed here. Paths are
            relative to the repo root and are skipped if they don&rsquo;t exist.
          </p>

          <div className="space-y-1.5">
            {carryItems.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  ref={(el) => {
                    pathInputs.current[i] = el
                    if (el && focusOnMount.current === i) {
                      focusOnMount.current = null
                      el.focus()
                    }
                  }}
                  className={carryPathClass}
                  value={item.path}
                  onChange={(e) => updateCarry(i, { path: e.target.value })}
                  placeholder="e.g. CLAUDE.local.md"
                  spellCheck={false}
                  // Enter 로 다음 행을 이어서 추가한다(여러 경로를 손 안 떼고 입력).
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    if (!item.path.trim()) return
                    addCarryRow()
                  }}
                />
                <select
                  className={carryModeClass}
                  value={item.mode}
                  onChange={(e) => updateCarry(i, { mode: e.target.value as CarryMode })}
                >
                  <option value="copy">Copy</option>
                  <option value="link">Link</option>
                </select>
                <button
                  className={carryRemoveClass}
                  onClick={() => setCarryItems((items) => items.filter((_, x) => x !== i))}
                  title="Remove"
                  aria-label={`Remove ${item.path || 'entry'}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button className={ghostBtn + ' mt-1.5 text-xs'} onClick={addCarryRow}>
            + Add path
          </button>

          <p className="mt-2 text-xs text-neutral-600">
            <span className="font-mono">Copy</span> gives each workspace its own independent copy —
            right for <span className="font-mono">.env</span>, where values like{' '}
            <span className="font-mono">$PORT</span> differ per workspace.{' '}
            <span className="font-mono">Link</span> symlinks the original, so edits are shared
            across every workspace.
          </p>
          {/* 동시 쓰기 레이스는 해결하지 않고 경고만 남긴다 — link 는 원본 하나를 N 개가 공유한다. */}
          {carryItems.some((i) => i.mode === 'link') && (
            <p className="mt-1.5 text-xs text-[var(--warning-400,#d9a441)]">
              Heads-up: linked files are shared. If parallel agents write to the same one (e.g. an
              accumulating <span className="font-mono">MEMORY.md</span>), they can overwrite each
              other. Use Copy if the agent is expected to write to it.
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
