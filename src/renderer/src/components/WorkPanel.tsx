import { useState } from 'react'
import { Files, GitCompare, CheckCheck, SquareArrowOutUpRight } from 'lucide-react'
import FileBrowser from './FileBrowser'
import ChangesPanel from './ChangesPanel'
import ChecksPanel from './ChecksPanel'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import type { Workspace } from '@shared/types'

type Tab = 'files' | 'changes' | 'check'

const TABS: {
  id: Tab
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}[] = [
  { id: 'files', label: 'All files', icon: Files },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'check', label: 'Check', icon: CheckCheck }
]

/** 우상단 탭 패널: All files / Changes / Check. */
export default function WorkPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('changes')
  const detachPane = useStore((s) => s.detachPane)

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg)]">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border)]">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={
                'flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md ' +
                (active
                  ? 'bg-[var(--surface-2)] text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200')
              }
            >
              <Icon size={13} />
              {label}
            </button>
          )
        })}

        {/* 이미 별도 창이면 더 뗄 곳이 없다 — 인라인일 때만 분리 버튼을 보여 준다. */}
        {!isPaneWindow && (
          <>
            <div className="flex-1" />
            <button
              onClick={() => detachPane('work')}
              aria-label="Open work panel in a separate window"
              title="Open in a separate window"
              className="h-6 w-6 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
            >
              <SquareArrowOutUpRight size={13} />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'files' && <FileBrowser workspaceId={workspace.id} />}
        {tab === 'changes' && (
          <ChangesPanel workspaceId={workspace.id} baseBranch={workspace.baseBranch} />
        )}
        {tab === 'check' && <ChecksPanel workspaceId={workspace.id} />}
      </div>
    </div>
  )
}
