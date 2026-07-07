import { Plus, FolderGit2 } from 'lucide-react'
import { useStore } from '../store'
import Logo from './Logo'

export default function EmptyState(): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const hasRepo = app.repos.length > 0
  const active = app.workspaces.filter((w) => !w.archived)
  const running = active.filter((w) => w.status === 'running').length

  return (
    <div className="relative h-full w-full grid place-items-center text-center px-8 overflow-hidden">
      {/* 로고 뒤에 깔리는 은은한 방사형 글로우로 깊이를 준다. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(420px 320px at 50% 38%, color-mix(in srgb, var(--focus-ring) 9%, transparent), transparent 70%)'
        }}
      />
      <div className="relative max-w-md flex flex-col items-center">
        <div className="mb-5 grid h-20 w-20 place-items-center rounded-2xl bg-[var(--surface)] border border-[var(--border-2)] shadow-xl">
          <Logo size={44} />
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100 mb-2">Ditto</h2>
        <p className="text-base text-neutral-400 leading-relaxed">
          {hasRepo
            ? 'Create a workspace to spin up an AI coding agent in its own isolated git worktree. Each workspace runs independently and in parallel.'
            : 'Connect a git repository to get started. Each task becomes its own worktree, branch, and agent session.'}
        </p>

        <div className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-[var(--border-2)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-neutral-300">
          {hasRepo ? (
            <>
              <Plus size={13} className="text-neutral-400" />
              Press the <span className="font-medium text-neutral-100">+</span> next to a repository
            </>
          ) : (
            <>
              <FolderGit2 size={13} className="text-neutral-400" />
              Use the <span className="font-medium text-neutral-100">+</span> in the top-left to add
              a repo
            </>
          )}
        </div>

        {hasRepo && active.length > 0 && (
          <p className="mt-5 text-sm text-neutral-500">
            {active.length} workspace{active.length > 1 ? 's' : ''}
            {running > 0 && <span className="text-[var(--info-400)]"> · {running} running</span>}
            <br />
            <span className="text-neutral-600">⌘1–9 to switch · ⌘[ / ⌘] to cycle</span>
          </p>
        )}
      </div>
    </div>
  )
}
