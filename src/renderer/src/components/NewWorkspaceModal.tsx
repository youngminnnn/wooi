import { useState } from 'react'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import { sanitizePreview } from '../lib/format'

export default function NewWorkspaceModal({
  repoId,
  onClose
}: {
  repoId: string
  onClose: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((r) => r.id === repoId)!
  const [name, setName] = useState('')

  // 닫고 즉시 사이드바에 스피너 행을 띄운다(worktree 준비는 백그라운드). 실패는 토스트로 알린다.
  const create = (): void => {
    if (!name.trim()) return
    const trimmed = name.trim()
    void useStore.getState().createWorkspace(repoId, { name: trimmed }, trimmed)
    onClose()
  }

  return (
    <Modal
      title={`New workspace · ${repo.name}`}
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

        <div>
          <label className={labelClass}>Base branch</label>
          <p className="text-xs text-neutral-600">
            Always branches from the latest{' '}
            <span className="text-neutral-400">origin/{repo.defaultBranch}</span> (fetched first).
          </p>
        </div>
      </div>
    </Modal>
  )
}
