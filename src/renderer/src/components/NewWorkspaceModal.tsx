import { useState } from 'react'
import { workspaceDisplayName } from '@shared/types'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import { sanitizePreview } from '../lib/format'

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

  // 닫고 즉시 사이드바에 스피너 행을 띄운다(worktree 준비는 백그라운드). 실패는 토스트로 알린다.
  const create = (): void => {
    if (!name.trim()) return
    const trimmed = name.trim()
    void useStore.getState().createWorkspace(repoId, { name: trimmed, parentWorkspaceId }, trimmed)
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
