import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Loader2, MinusCircle, CircleDot, ExternalLink } from 'lucide-react'
import { useStore } from '../store'
import { PanelToolbar } from './ChangesPanel'
import { GithubMark } from './BrandIcons'
import { useGithubDisconnected } from '../lib/github'
import type { PrCheck, PrCheckState, PrChecks } from '@shared/types'

/**
 * 우측 패널의 Check 탭. PR 의 CI 체크 롤업(gh pr view statusCheckRollup)을 표시한다.
 * 턴이 끝나 PR 상태가 갱신되면 함께 다시 불러온다.
 */
export default function ChecksPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [checks, setChecks] = useState<PrChecks | null>(null)
  const [loading, setLoading] = useState(true)
  // PR 번호가 바뀌면(생성/연결) 다시 가져오는 트리거.
  const prNumber = useStore((s) => s.prStatus[workspaceId]?.number ?? 0)
  // 체크는 gh 로만 조회할 수 있다 — 미연결이면 탭을 숨기지 않고 연결 안내로 바꿔 노출한다.
  const githubDisconnected = useGithubDisconnected()
  const requireGithub = useStore((s) => s.requireGithub)

  const load = (): void => {
    if (githubDisconnected) return
    setLoading(true)
    void window.api.pr.checks(workspaceId).then((c) => {
      setChecks(c)
      setLoading(false)
    })
  }

  useEffect(() => {
    // 미연결이면 조회 자체를 하지 않는다(조용한 no-op — 에러도 스피너도 남기지 않는다).
    if (githubDisconnected) {
      setChecks(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void window.api.pr.checks(workspaceId).then((c) => {
      if (alive) {
        setChecks(c)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [workspaceId, prNumber, githubDisconnected])

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar
        label={checks ? `PR #${checks.prNumber} · ${checks.checks.length} checks` : 'Checks'}
        onRefresh={load}
        spinning={loading}
      />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {githubDisconnected ? (
          <div className="py-14 text-center">
            <p className="text-base text-neutral-500 leading-relaxed">
              CI checks come from GitHub.
              <br />
              Connect the GitHub CLI to see them here.
            </p>
            <button
              onClick={() =>
                void requireGithub('Pull request checks are read from GitHub.', () => {})
              }
              className="mt-4 inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-[var(--surface-2)] text-neutral-200 font-medium hover:bg-[var(--border)]"
            >
              <GithubMark size={14} />
              Connect GitHub
            </button>
          </div>
        ) : loading ? (
          <div className="grid place-items-center py-16 text-neutral-500">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : !checks ? (
          <p className="py-16 text-center text-base text-neutral-500 leading-relaxed">
            No pull request for this branch yet.
            <br />
            Checks appear once a PR exists.
          </p>
        ) : checks.checks.length === 0 ? (
          <div className="py-10 text-center text-base text-neutral-500">
            <p>No checks reported on this PR.</p>
            <OpenPrLink url={checks.prUrl} />
          </div>
        ) : (
          <div className="space-y-1">
            {checks.checks.map((c) => (
              <CheckRow key={c.name} check={c} />
            ))}
            <div className="pt-2">
              <OpenPrLink url={checks.prUrl} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CheckRow({ check }: { check: PrCheck }): React.JSX.Element {
  const open = (): void => {
    if (check.url) void window.api.openExternal(check.url)
  }
  return (
    <button
      onClick={open}
      disabled={!check.url}
      className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-[var(--surface)] disabled:hover:bg-transparent"
      title={check.url ? 'Open check details' : undefined}
    >
      <CheckIcon state={check.state} />
      <span className="flex-1 truncate text-sm text-neutral-200">{check.name}</span>
      <span className={'text-xs ' + stateColor(check.state)}>{check.state}</span>
      {check.url && (
        // 아이콘 자체는 포커스를 받지 않는다 — 포커스는 감싸는 버튼(.group)이 받으므로
        // focus-visible 이 아니라 group-focus-visible 로 그 버튼의 키보드 포커스에 반응시킨다.
        <ExternalLink
          size={11}
          className="text-neutral-600 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 shrink-0"
        />
      )}
    </button>
  )
}

function OpenPrLink({ url }: { url: string }): React.JSX.Element {
  return (
    <button
      onClick={() => void window.api.openExternal(url)}
      className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200"
    >
      Open PR on GitHub <ExternalLink size={11} />
    </button>
  )
}

function CheckIcon({ state }: { state: PrCheckState }): React.JSX.Element {
  const cls = 'shrink-0'
  switch (state) {
    case 'success':
      return <CheckCircle2 size={14} className={`${cls} text-[var(--success-400)]`} />
    case 'failure':
      return <XCircle size={14} className={`${cls} text-[var(--danger-400)]`} />
    case 'pending':
      return <Loader2 size={14} className={`${cls} text-[var(--warning-400)] animate-spin`} />
    case 'skipped':
      return <MinusCircle size={14} className={`${cls} text-neutral-500`} />
    default:
      return <CircleDot size={14} className={`${cls} text-neutral-500`} />
  }
}

function stateColor(state: PrCheckState): string {
  switch (state) {
    case 'success':
      return 'text-[var(--success-400)]'
    case 'failure':
      return 'text-[var(--danger-400)]'
    case 'pending':
      return 'text-[var(--warning-400)]'
    default:
      return 'text-neutral-500'
  }
}
