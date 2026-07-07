import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { ClaudeMark, GithubMark } from './BrandIcons'
import ClaudeLoginModal from './ClaudeLoginModal'
import GithubLoginModal from './GithubLoginModal'

export default function IntegrationsPanel(): React.JSX.Element {
  const auth = useStore((s) => s.authStatus)
  const refreshAuth = useStore((s) => s.refreshAuth)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [claudeLoginOpen, setClaudeLoginOpen] = useState(false)
  const closeClaudeLogin = useCallback(() => setClaudeLoginOpen(false), [])
  const [githubLoginOpen, setGithubLoginOpen] = useState(false)
  const closeGithubLogin = useCallback(() => setGithubLoginOpen(false), [])

  useEffect(() => {
    void refreshAuth()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refreshAuth])

  // GitHub 로그아웃은 계정 확인 프롬프트 때문에 Terminal 에서 진행되므로, 트리거 후 인증 상태를
  // 폴링해 자동 반영한다. 상태가 바뀌면(로그아웃 감지) 즉시 멈추고, 최대 60초까지만 시도한다.
  // (Claude·GitHub 로그인은 앱 내부 모달이 직접 refreshAuth 하므로 폴링하지 않는다.)
  const pollUntilChange = (): void => {
    if (pollRef.current) clearInterval(pollRef.current)
    const before = JSON.stringify(useStore.getState().authStatus)
    let ticks = 0
    const stop = (): void => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
    pollRef.current = setInterval(() => {
      ticks++
      void refreshAuth()
      const changed = JSON.stringify(useStore.getState().authStatus) !== before
      if (changed || ticks >= 20) stop()
    }, 3000)
  }

  const claude = auth?.claude
  const github = auth?.github

  return (
    <div className="space-y-3">
      <IntegrationRow
        name="Claude Code"
        icon={<ClaudeMark size={18} />}
        loading={!auth}
        installed={!!claude?.installed}
        installUrl="https://claude.com/claude-code"
        connected={!!claude?.loggedIn}
        detail={
          !claude?.installed
            ? 'Not installed — install Claude Code to continue'
            : claude.loggedIn
              ? [claude.email, claude.orgName].filter(Boolean).join(' · ') || 'Signed in'
              : 'Sign in to run Claude Code agents'
        }
        warning={
          claude?.apiKeyInEnv
            ? 'ANTHROPIC_API_KEY is set in your environment — agents authenticate and bill via that key, not the account here.'
            : undefined
        }
        onConnect={() => setClaudeLoginOpen(true)}
        onDisconnect={() => window.api.auth.claudeLogout().then(() => refreshAuth())}
      />

      <IntegrationRow
        name="GitHub"
        icon={<GithubMark size={17} />}
        loading={!auth}
        installed={!!github?.installed}
        installUrl="https://cli.github.com"
        connected={!!github?.loggedIn}
        detail={
          !github?.installed
            ? 'Required — install the GitHub CLI (gh) to use Ditto'
            : github.loggedIn
              ? `@${github.account ?? '?'}${github.protocol ? ` · ${github.protocol}` : ''}`
              : 'Sign in to GitHub to continue'
        }
        onConnect={() => setGithubLoginOpen(true)}
        onDisconnect={() => {
          void window.api.auth.githubLogout()
          pollUntilChange()
        }}
      />

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-neutral-500 leading-relaxed pr-3">
          Claude and GitHub sign-in finish in-app via your browser. Status refreshes automatically —
          or click Refresh.
        </p>
        <button
          onClick={() => void refreshAuth()}
          className="shrink-0 flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg text-neutral-300 hover:bg-[var(--surface-2)]"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {claudeLoginOpen && <ClaudeLoginModal onClose={closeClaudeLogin} />}
      {githubLoginOpen && <GithubLoginModal onClose={closeGithubLogin} />}
    </div>
  )
}

function IntegrationRow({
  name,
  icon,
  detail,
  warning,
  connected,
  loading,
  installed,
  installUrl,
  onConnect,
  onDisconnect
}: {
  name: string
  icon: React.ReactNode
  detail: string
  warning?: string
  connected: boolean
  loading: boolean
  installed: boolean
  installUrl: string
  onConnect: () => void | Promise<void>
  onDisconnect: () => void | Promise<void>
}): React.JSX.Element {
  // 로그아웃/재연결은 CLI 실행이 끝날 때까지 수 초가 걸릴 수 있어, 진행 중에는
  // 버튼에 스피너를 띄우고 버튼을 비활성화해 멈춘 것처럼 보이지 않게 한다.
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const run = (which: 'connect' | 'disconnect', fn: () => void | Promise<void>): void => {
    if (busy) return
    setBusy(which)
    void Promise.resolve(fn()).finally(() => setBusy(null))
  }
  return (
    <div className="flex items-center gap-3 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3.5 py-3">
      <div className="h-8 w-8 grid place-items-center rounded-lg bg-[var(--surface-2)] text-neutral-300 shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-base font-medium text-neutral-100">
          {name}
          {connected && <Check size={13} className="text-[var(--success-400)]" />}
        </div>
        <div className="text-xs text-neutral-500 truncate">{detail}</div>
        {warning && <div className="text-xs text-[var(--warning-500)]/90 mt-0.5">{warning}</div>}
      </div>
      {loading ? (
        <Loader2 size={15} className="text-neutral-500 animate-spin" />
      ) : !installed ? (
        <button
          onClick={() => void window.api.openExternal(installUrl)}
          className="text-sm px-3 py-1.5 rounded-lg bg-[var(--surface-2)] text-neutral-200 font-medium hover:bg-[var(--border)]"
        >
          Install
        </button>
      ) : connected ? (
        <div className="flex gap-1.5">
          <button
            onClick={() => run('connect', onConnect)}
            disabled={busy !== null}
            className="text-sm px-2.5 py-1.5 rounded-lg text-neutral-300 hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Reconnect
          </button>
          <button
            onClick={() => run('disconnect', onDisconnect)}
            disabled={busy !== null}
            className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg text-neutral-400 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)] disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {busy === 'disconnect' && <Loader2 size={13} className="animate-spin" />}
            {busy === 'disconnect' ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => run('connect', onConnect)}
          disabled={busy !== null}
          className="text-sm px-3 py-1.5 rounded-lg bg-[var(--info-600)] text-white font-medium hover:bg-[var(--info-500)] disabled:opacity-60"
        >
          Sign in
        </button>
      )}
    </div>
  )
}
