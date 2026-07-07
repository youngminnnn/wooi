import {
  FolderGit2,
  Plus,
  Settings,
  GitBranch,
  Loader2,
  Send,
  FileText,
  GitPullRequest,
  Terminal,
  ShieldCheck
} from 'lucide-react'
import Logo from './Logo'

/**
 * 최초 실행 온보딩 투어에서만 쓰는 예시(데모) 앱 화면.
 * 실제 스토어/백엔드를 건드리지 않는 순수 표현용 목업으로, 워크스페이스가 아직 없는
 * 첫 실행에서도 스포트라이트가 실제 UI 를 가리키는 것처럼 보이게 한다.
 * FeatureTour 가 이 안의 data-tour 마커를 하이라이트한다.
 */
export default function TourDemo(): React.JSX.Element {
  return (
    <div className="h-full w-full flex flex-col bg-[var(--bg)] select-none pointer-events-none">
      {/* 타이틀 바 */}
      <div className="h-11 shrink-0 flex items-center justify-between bg-[var(--bg)] border-b border-[var(--border)] pl-20 pr-3">
        <div className="flex items-center gap-2 text-base font-semibold tracking-tight text-neutral-200">
          <Logo size={18} />
          Ditto
          <span className="text-neutral-600 font-normal">· AI coding agent orchestrator</span>
        </div>
        <div
          data-tour="settings"
          className="h-7 w-7 grid place-items-center rounded-md text-neutral-400"
        >
          <Settings size={16} />
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 사이드바 */}
        <aside className="w-72 shrink-0 flex flex-col bg-[var(--bg-2)]">
          <div data-tour="repos" className="flex items-center justify-between px-3 h-10 shrink-0">
            <span className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">
              Repositories
            </span>
            <div className="h-6 w-6 grid place-items-center rounded-md text-neutral-400">
              <Plus size={15} />
            </div>
          </div>

          <div data-tour="workspaces" className="flex-1 overflow-hidden px-2 pb-4">
            <div className="mb-3">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <FolderGit2 size={14} className="text-neutral-500 shrink-0" />
                <span className="flex-1 truncate text-sm font-medium text-neutral-300">
                  acme-web
                </span>
                <span className="flex items-center gap-1 text-xs text-[var(--info-400)]/80">
                  <Loader2 size={10} className="animate-spin" />1
                </span>
              </div>
              <div className="mt-0.5 space-y-0.5">
                <DemoWs
                  name="Add dark mode toggle"
                  branch="feat/dark-mode"
                  shortcut={1}
                  state="running"
                  active
                />
                <DemoWs
                  name="Fix login redirect"
                  branch="fix/login-redirect"
                  shortcut={2}
                  state="pr"
                />
                <DemoWs
                  name="Upgrade to React 19"
                  branch="chore/react-19"
                  shortcut={3}
                  state="idle"
                />
              </div>
            </div>
          </div>
        </aside>

        {/* 본문: 채팅 + 작업 패널 */}
        <div className="flex-1 min-w-0 border-l border-[var(--border)] flex">
          <div data-tour="chat" className="flex-1 min-w-0 flex flex-col bg-[var(--bg)]">
            <div className="flex-1 overflow-hidden p-4 space-y-3">
              <DemoBubble role="user">Add a dark mode toggle to the settings page.</DemoBubble>
              <DemoBubble role="assistant">
                I&rsquo;ll add a theme toggle. Reading <code>Settings.tsx</code> and wiring it to
                the existing theme store…
              </DemoBubble>
              <div className="flex items-center gap-2 text-xs text-neutral-500">
                <Loader2 size={12} className="animate-spin text-[var(--info-400)]" />
                Editing <code className="text-neutral-400">ThemeToggle.tsx</code>
              </div>
            </div>
            <div className="p-3 border-t border-[var(--border)]">
              <div className="flex items-center gap-2 mb-2">
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-[var(--info-600)]/15 text-[var(--info-300)] border border-[var(--info-500)]/20">
                  <ShieldCheck size={11} />
                  Accept edits
                </span>
                <span className="text-xs text-neutral-600">⇧⇥ to change</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2">
                <span className="flex-1 text-sm text-neutral-600">Message your agent…</span>
                <Send size={14} className="text-neutral-500" />
              </div>
            </div>
          </div>

          {/* 작업 패널 */}
          <div
            data-tour="work-panel"
            className="w-[420px] shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--bg)]"
          >
            <div className="flex items-center gap-1 px-2 h-9 border-b border-[var(--border)] text-xs">
              <Tab icon={<FileText size={12} />} label="Files" active />
              <Tab icon={<GitBranch size={12} />} label="Changes" badge="4" />
              <Tab icon={<GitPullRequest size={12} />} label="Checks" />
              <Tab icon={<Terminal size={12} />} label="Terminal" />
            </div>
            <div className="flex-1 p-3 font-mono text-xs leading-relaxed overflow-hidden">
              <div className="text-neutral-500 mb-1.5">ThemeToggle.tsx</div>
              <div className="text-[var(--success-400)]">+ export function ThemeToggle() {'{'}</div>
              <div className="text-[var(--success-400)]">
                +&nbsp;&nbsp;const [dark, setDark] = …
              </div>
              <div className="text-[var(--success-400)]">
                +&nbsp;&nbsp;return &lt;Switch … /&gt;
              </div>
              <div className="text-[var(--success-400)]">+ {'}'}</div>
              <div className="text-neutral-600 mt-2">- // TODO: theme toggle</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function DemoWs({
  name,
  branch,
  shortcut,
  state,
  active = false
}: {
  name: string
  branch: string
  shortcut: number
  state: 'running' | 'idle' | 'pr'
  active?: boolean
}): React.JSX.Element {
  return (
    <div
      className={
        'relative flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-md ' +
        (active
          ? 'bg-[var(--surface-3)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--info-500)]'
          : '')
      }
    >
      {state === 'running' ? (
        <Loader2 size={13} className="text-[var(--info-400)] animate-spin shrink-0" />
      ) : state === 'pr' ? (
        <span className="h-2 w-2 rounded-full bg-[var(--success-400)] shrink-0" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-neutral-600 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className={'truncate text-sm ' + (active ? 'text-neutral-100' : 'text-neutral-300')}>
          {name}
        </div>
        <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
          <GitBranch size={10} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </div>
      </div>
      <kbd className="shrink-0 text-xs leading-none font-medium text-neutral-600 tabular-nums">
        ⌘{shortcut}
      </kbd>
    </div>
  )
}

function DemoBubble({
  role,
  children
}: {
  role: 'user' | 'assistant'
  children: React.ReactNode
}): React.JSX.Element {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[var(--info-600)]/90 text-white text-sm px-3 py-2">
          {children}
        </div>
      </div>
    )
  }
  return <div className="max-w-[85%] text-sm text-neutral-300 leading-relaxed">{children}</div>
}

function Tab({
  icon,
  label,
  active = false,
  badge
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  badge?: string
}): React.JSX.Element {
  return (
    <div
      className={
        'flex items-center gap-1 px-2 py-1 rounded-md ' +
        (active ? 'bg-[var(--surface-2)] text-neutral-200' : 'text-neutral-500')
      }
    >
      {icon}
      {label}
      {badge && <span className="ml-0.5 text-[10px] text-[var(--warning-500)]/90">{badge}</span>}
    </div>
  )
}
