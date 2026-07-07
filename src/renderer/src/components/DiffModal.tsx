import { useEffect, useState } from 'react'
import Modal from './Modal'
import DiffView from './DiffView'
import type { WorkspaceDiff } from '@shared/types'

export default function DiffModal({
  workspaceId,
  baseBranch,
  onClose
}: {
  workspaceId: string
  baseBranch: string
  onClose: () => void
}): React.JSX.Element {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.api.git.diff(workspaceId).then((d) => {
      if (alive) {
        setDiff(d)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  return (
    <Modal title={`Changes vs ${baseBranch}`} onClose={onClose} width={860}>
      <DiffView diff={diff} loading={loading} baseBranch={baseBranch} />
    </Modal>
  )
}
