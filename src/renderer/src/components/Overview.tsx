import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  Loader2,
  ShieldQuestion,
  GitPullRequest,
  Square,
  Gauge,
  Timer,
  AlertTriangle,
  MessageSquarePlus
} from 'lucide-react'
import { refreshAccountUsage, useStore } from '../store'
import { useNow } from '../lib/useNow'
import { formatCost, formatCountdown, formatDuration, formatTime } from '../lib/format'
import { AGENT_BACKEND_IDS, AGENT_BACKEND_LABELS, workspaceDisplayName } from '@shared/types'
import type { AgentBackendId, RateLimitSnapshot, UsageInfo, Workspace } from '@shared/types'
import { AgentBackendMark } from './BrandIcons'
import { usesAccountUsageSnapshot } from '../lib/rateLimit'

/** 요금제 사용률 재조회 주기. 5시간 창이 눈에 띄게 움직이는 단위가 분이라 1분이면 충분하다. */
const USAGE_REFRESH_MS = 60_000
/** 창 포커스로 인한 재조회의 최소 간격(왕복이 ~1.1s 라 alt-tab 연타에 딸려가지 않게 한다). */
const USAGE_FOCUS_MIN_GAP_MS = 15_000

/** 요금제 한도 창 하나를 표시용으로 정규화한 값. utilization 이 없는 창은 null 로 남긴다. */
type PlanWindow = {
  label: string
  /** 0–100 사용률. 표기·정렬 모두 이 값 기준이다(claude.ai 와 동일). */
  usedPct: number | null
  /** 리셋 시각(epoch ms). 알 수 없으면 null. */
  resetsAt: number | null
}

type FilterKey = 'all' | 'running' | 'attention' | 'unread' | 'idle'

/**
 * 워크스페이스를 선택하지 않았을 때 보이는 전역 현황 보드.
 * 모든 활성 세션의 상태(실행/권한대기/미확인/유휴)를 한 화면에서 보고,
 * 상태별로 필터링하거나 카드를 눌러 바로 진입한다.
 */
export default function Overview(): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const unread = useStore((s) => s.unread)
  const permissions = useStore((s) => s.permissions)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const stopAll = useStore((s) => s.stopAll)
  const confirm = useStore((s) => s.confirm)
  const [filter, setFilter] = useState<FilterKey>('all')

  const active = useMemo(() => app.workspaces.filter((w) => !w.archived), [app.workspaces])
  const anyRunning = active.some((w) => w.status === 'running')

  const auth = useStore((s) => s.authStatus)
  // **목록을 손으로 적지 않는다.** 예전에는 `['claude','codex']` 를 박아 뒀는데, 백엔드가 늘어도
  // 컴파일이 통과해 버려 새 백엔드만 조용히 이 화면에서 빠졌다.
  const connectedAgents = AGENT_BACKEND_IDS.filter((id) => {
    const hasActiveWorkspace = active.some((w) => w.agentBackend === id)
    // 레거시 Claude 스냅샷(app.rateLimits)은 backend별 맵이 생기기 전의 저장 형식이다.
    const hasSnapshot = !!(
      app.rateLimitsByAgent?.[id] ?? (id === 'claude' ? app.rateLimits : undefined)
    )
    // 인증 조회는 앱 시작·focus 때 여러 번 겹칠 수 있고 일시 실패도 가능하다. 이미 이 backend를
    // 쓰는 workspace나 account snapshot이 있는데 loggedIn 하나만 보고 패널을 제거하지 않는다.
    return !!auth?.agents[id]?.loggedIn || hasActiveWorkspace || hasSnapshot
  })
  /** 계정 스냅샷 경로로 사용량을 읽는 백엔드들. 워크스페이스가 없어도 값이 나온다. */
  const snapshotAgents = connectedAgents.filter(usesAccountUsageSnapshot)
  const snapshotAgentsKey = snapshotAgents.join(',')

  // backend별 사용량을 주기적으로, 그리고 창으로 돌아올 때 다시 조회한다.
  const [usageNonce, setUsageNonce] = useState(0)
  const lastUsageFetch = useRef(0)
  useEffect(() => {
    const bump = (): void => {
      lastUsageFetch.current = Date.now()
      setUsageNonce((n) => n + 1)
    }
    const id = window.setInterval(bump, USAGE_REFRESH_MS)
    // 창 전환을 반복해도 매번 왕복하지 않도록 최소 간격을 둔다.
    const onFocus = (): void => {
      if (Date.now() - lastUsageFetch.current >= USAGE_FOCUS_MIN_GAP_MS) bump()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // 계정 스냅샷 경로를 쓰는 백엔드의 사용량은 AppState 의 backend별 스냅샷으로 관리된다.
  // Overview 에서 workspace /usage 를 다시 실행하면 같은 rate-limit 왕복을 중복하므로, 전용 갱신
  // 경로만 한 번 호출하고 저장된 스냅샷은 갱신이 끝나기 전에도 그대로 표시한다.
  const lastSnapshotRefreshNonce = useRef<number | null>(null)
  const [usageLoading, setUsageLoading] = useState<Partial<Record<AgentBackendId, boolean>>>({})
  const [snapshots, setSnapshots] = useState<Partial<Record<AgentBackendId, RateLimitSnapshot>>>(
    () => ({ ...app.rateLimitsByAgent })
  )
  useEffect(() => {
    if (!snapshotAgents.length || lastSnapshotRefreshNonce.current === usageNonce) return
    lastSnapshotRefreshNonce.current = usageNonce
    for (const id of snapshotAgents) {
      setUsageLoading((prev) => ({ ...prev, [id]: true }))
      void refreshAccountUsage(id)
        .then((next) => {
          // refresh 응답 자체가 최신 상태의 정본이다. evtState 방송 수신 여부에 화면 갱신을
          // 의존하지 않는다.
          setSnapshots((prev) => ({ ...prev, [id]: next.rateLimitsByAgent?.[id] }))
          useStore.setState((state) => ({
            app: state.app
              ? {
                  ...state.app,
                  rateLimitsByAgent: {
                    ...state.app.rateLimitsByAgent,
                    [id]: next.rateLimitsByAgent?.[id]
                  }
                }
              : next
          }))
        })
        .finally(() => setUsageLoading((prev) => ({ ...prev, [id]: false })))
    }
    // snapshotAgents 는 매 렌더 새 배열이라 내용으로 만든 키를 의존성에 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotAgentsKey, usageNonce])

  const now = useNow(anyRunning ? 1000 : 30_000, anyRunning || connectedAgents.length > 0)
  const claudeSnapshot = app.rateLimitsByAgent ? app.rateLimitsByAgent.claude : app.rateLimits
  const showCardCost = claudeSnapshot?.available === false

  // 카드별 비용. 메인이 집계해 숫자만 넘겨준다 — 대화 기록을 렌더러로 끌어오지 않는다.
  // 요금제 사용자에게는 이 값이 화면에 나오지 않으므로(showCardCost) 아예 묻지도 않는다.
  // 비용은 턴이 끝날 때만 바뀌니, 사용량 갱신과 같은 박자로 다시 읽으면 충분하다.
  const [costByWorkspace, setCostByWorkspace] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!showCardCost) return
    let cancelled = false
    void window.api.chat.getCosts().then((costs) => {
      if (!cancelled) setCostByWorkspace(costs)
    })
    return () => {
      cancelled = true
    }
  }, [showCardCost, usageNonce])

  const pendingIds = new Set(permissions.map((p) => p.workspaceId))

  const flagsOf = (
    w: Workspace
  ): { running: boolean; attention: boolean; unread: boolean; idle: boolean } => {
    const running = w.status === 'running'
    const attention = pendingIds.has(w.id)
    const isUnread = !!unread[w.id]
    return { running, attention, unread: isUnread, idle: !running && !attention && !isUnread }
  }

  const counts = {
    all: active.length,
    running: active.filter((w) => flagsOf(w).running).length,
    attention: active.filter((w) => flagsOf(w).attention).length,
    unread: active.filter((w) => flagsOf(w).unread).length,
    idle: active.filter((w) => flagsOf(w).idle).length
  }

  const shown = active.filter((w) => (filter === 'all' ? true : flagsOf(w)[filter]))

  const repoName = (repoId: string): string =>
    app.repos.find((r) => r.id === repoId)?.name ?? 'repo'

  const onStopAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Stop all ${counts.running} running session${counts.running > 1 ? 's' : ''}?`,
      body: 'Interrupts the current turn in every running workspace.',
      confirmLabel: 'Stop all',
      danger: true
    })
    if (ok) void stopAll()
  }

  const FILTERS: { key: FilterKey; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'running', label: 'Running', count: counts.running },
    { key: 'attention', label: 'Needs input', count: counts.attention },
    { key: 'unread', label: 'Unread', count: counts.unread },
    { key: 'idle', label: 'Idle', count: counts.idle }
  ]

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8">
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-lg font-semibold text-neutral-100">Overview</h2>
          <span className="text-sm text-neutral-500">
            {counts.all} workspace{counts.all === 1 ? '' : 's'}
            {counts.running > 0 && (
              <span className="text-[var(--info-400)]"> · {counts.running} running</span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* PR 리뷰는 워크스페이스와 무관한 별도 흐름이라 여기서 바로 들어갈 수 있게 둔다. */}
            <button
              data-tour="review-pr"
              onClick={() => window.dispatchEvent(new Event('wooi:open-pr-review'))}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-neutral-300 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-100"
              title="Review a pull request — enter a PR number to start"
            >
              <MessageSquarePlus size={12} />
              Review PR
              {/* 단축키를 버튼에 붙여 둔다 — 사이드바의 'Search workspaces / ⌘K' 와 같은 방식으로,
                  익히기 전까지만 눈에 들어오고 익히면 자연히 배경이 된다. */}
              <kbd className="ml-0.5 text-[11px] leading-none font-medium text-neutral-600 tabular-nums">
                ⇧⌘R
              </kbd>
            </button>
            {counts.running > 0 && (
              <button
                onClick={onStopAll}
                className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-[var(--danger-300)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 hover:bg-[var(--danger-500)]/20"
                title="Stop the current turn in every running session"
              >
                <Square size={11} fill="currentColor" />
                Stop all
              </button>
            )}
          </div>
        </div>

        <div
          className={`grid gap-2.5 mb-5 ${connectedAgents.length > 1 ? 'lg:grid-cols-2' : 'grid-cols-1'}`}
        >
          {connectedAgents.map((agentId) => {
            const candidates = active.filter((w) => w.agentBackend === agentId)
            const target = candidates.find((w) => w.status === 'running') ?? candidates[0]
            return (
              <AgentUsagePanel
                key={agentId}
                agentId={agentId}
                targetId={target?.id}
                snapshot={
                  snapshots[agentId] ??
                  app.rateLimitsByAgent?.[agentId] ??
                  (agentId === 'claude' ? app.rateLimits : undefined)
                }
                refreshNonce={usageNonce}
                refreshing={!!usageLoading[agentId]}
                now={now}
              />
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mb-5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                'flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border ' +
                (filter === f.key
                  ? 'bg-[var(--surface-3)] border-[var(--border-strong)] text-neutral-100'
                  : 'bg-transparent border-[var(--border)] text-neutral-400 hover:border-[var(--border-strong)]')
              }
            >
              {f.label}
              <span className="text-neutral-500 tabular-nums">{f.count}</span>
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="text-sm text-neutral-500 py-12 text-center">
            No workspaces match this filter.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {shown.map((w) => (
              <OverviewCard
                key={w.id}
                workspace={w}
                repoName={repoName(w.repoId)}
                flags={flagsOf(w)}
                now={now}
                cost={costByWorkspace[w.id] ?? 0}
                showCost={showCardCost}
                onOpen={() => void selectWorkspace(w.id)}
              />
            ))}
          </div>
        )}

        <p className="mt-6 text-xs text-neutral-600 text-center">
          ⌘K to search · ⌘1–9 to switch · ⌘↑ / ⌘↓ to cycle · ⌘[ to go back ·{' '}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('wooi:open-shortcuts'))}
            className="underline decoration-dotted hover:text-neutral-400"
          >
            press ? for all shortcuts
          </button>
        </p>
      </div>
    </div>
  )
}

/** 연결된 에이전트 계정 하나의 플랜 사용량. 두 계정이 연결되면 같은 모양으로 나란히 보인다. */
function AgentUsagePanel({
  agentId,
  targetId,
  snapshot,
  refreshNonce,
  refreshing,
  now
}: {
  agentId: AgentBackendId
  targetId?: string
  snapshot?: RateLimitSnapshot
  refreshNonce: number
  refreshing: boolean
  now: number
}): React.JSX.Element {
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [loading, setLoading] = useState(!usesAccountUsageSnapshot(agentId) && !!targetId)
  const label = AGENT_BACKEND_LABELS[agentId]
  const panelLoading = loading || refreshing

  useEffect(() => {
    // 계정 스냅샷 경로는 상위 Overview가 이미 갱신하므로, 여기서 /usage까지 호출하면 같은
    // rate-limit 왕복을 중복하게 된다.
    if (usesAccountUsageSnapshot(agentId)) {
      setLoading(false)
      return
    }
    if (!targetId) return
    let cancelled = false
    setLoading(true)
    void window.api.commands
      .run(targetId, 'usage')
      .then(({ result }) => {
        if (cancelled) return
        if (result?.kind === 'usage') setUsage(result.usage)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, targetId, refreshNonce])

  const planApplies = usage ? usage.rateLimitsAvailable : (snapshot?.available ?? null)
  const windows = useMemo<PlanWindow[]>(() => {
    const source =
      usage?.rateLimitsAvailable && usage.rateLimits.length > 0
        ? usage.rateLimits
        : snapshot?.available
          ? snapshot.windows
          : []
    return source.map((window) => {
      const used =
        window.utilization == null ? null : Math.min(100, Math.max(0, window.utilization))
      const parsed = window.resetsAt ? Date.parse(window.resetsAt) : NaN
      return {
        label: window.label,
        usedPct: used,
        resetsAt: Number.isNaN(parsed) ? null : parsed
      }
    })
  }, [usage, snapshot])
  const withValues = windows.filter((window) => window.usedPct != null)
  const highest = withValues.reduce<PlanWindow | null>(
    (current, window) =>
      !current || (window.usedPct ?? 0) > (current.usedPct ?? 0) ? window : current,
    null
  )
  const primary = windows[0]

  return (
    <section className="rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] p-3.5">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-neutral-200">
        <AgentBackendMark backend={agentId} size={16} />
        {label}
        <span className="text-[11px] font-normal text-neutral-600">account usage</span>
        {panelLoading && <Loader2 size={11} className="ml-auto animate-spin text-neutral-500" />}
      </div>

      {planApplies === false ? (
        <p className="text-xs text-neutral-500">
          Plan rate limits are not available for this authentication method.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2.5 mb-3">
            <StatTile
              icon={<Gauge size={14} className="text-[var(--warning-400)]" />}
              label="Plan usage"
              value={highest ? `${Math.round(highest.usedPct ?? 0)}%` : '—'}
              loading={panelLoading && !highest}
              hint={
                highest ? `Highest window used (${highest.label})` : `Checking ${label} limits…`
              }
            />
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label={primary ? `${primary.label} resets in` : 'Primary limit resets in'}
              value={primary?.resetsAt == null ? '—' : formatCountdown(primary.resetsAt - now)}
              loading={panelLoading && primary?.resetsAt == null}
              hint={
                primary?.resetsAt == null
                  ? `Checking the ${label} primary usage window…`
                  : `${primary.label} usage window resets at ${formatTime(primary.resetsAt)}`
              }
            />
          </div>
          <PlanLimits
            accountLabel={label}
            windows={windows}
            extra={usage?.extraUsage ?? null}
            loading={panelLoading}
            now={now}
            embedded
          />
        </>
      )}
    </section>
  )
}

function StatTile({
  icon,
  label,
  value,
  hint,
  loading = false
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  /** 값 옆에 스피너를 띄운다. 타일 자체는 그대로 두어 로딩 중 레이아웃이 흔들리지 않는다. */
  loading?: boolean
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] px-3.5 py-2.5 min-w-[140px]"
      title={hint}
    >
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--surface-2)] shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
        <div className="flex items-center gap-1.5">
          <span className="text-base font-semibold text-neutral-100 tabular-nums">{value}</span>
          {loading && <Loader2 size={12} className="animate-spin text-neutral-500 shrink-0" />}
        </div>
      </div>
    </div>
  )
}

/** 많이 쓸수록 눈에 띄게. 75%/90% 위에서 경고·위험 색으로 바뀐다. */
function usedTone(usedPct: number | null): string {
  if (usedPct == null) return 'bg-[var(--surface-3)]'
  if (usedPct >= 90) return 'bg-[var(--danger-400)]'
  if (usedPct >= 75) return 'bg-[var(--warning-400)]'
  return 'bg-[var(--accent-400)]'
}

/**
 * 요금제 한도 창별(5시간·7일·모델별) 사용량과 리셋까지 남은 시간.
 * rate limit 은 계정 단위 값이라 워크스페이스와 무관하게 계정 전체 기준으로 동일하다.
 *
 * 표기는 claude.ai·데스크톱 앱과 같은 "쓴 %" 기준이다. 위쪽 Plan usage 타일도 쓴 %라
 * 여기만 "남은 %"로 두면 같은 화면에서 8% 와 92% 가 나란히 보여 서로 어긋난 값처럼 읽힌다.
 */
function PlanLimits({
  accountLabel,
  windows,
  extra,
  loading,
  now,
  embedded = false
}: {
  accountLabel: string
  windows: PlanWindow[]
  extra: UsageInfo['extraUsage']
  loading: boolean
  now: number
  embedded?: boolean
}): React.JSX.Element {
  return (
    <div
      className={
        embedded
          ? 'border-t border-[var(--surface-2)] pt-3'
          : 'rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] px-3.5 py-3 mb-5'
      }
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Plan usage</span>
        {loading && <Loader2 size={11} className="animate-spin text-neutral-500" />}
        {/* 모델별 창(Opus·Sonnet)은 계정에 있을 때만 행으로 나타나므로 헤더에서 약속하지 않는다. */}
        <span className="text-[11px] text-neutral-600">{accountLabel} · account-wide · used</span>
      </div>
      {windows.length === 0 ? (
        // 조회 중: 실제 행과 같은 높이의 자리표시자를 둬 결과가 와도 화면이 밀리지 않는다.
        <div className="space-y-2.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 rounded bg-[var(--surface-2)] animate-pulse" />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {windows.map((w) => (
            <li key={w.label} className="flex items-center gap-2.5 text-xs">
              <span className="w-28 shrink-0 truncate text-neutral-400">{w.label}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                <div
                  className={'h-full ' + usedTone(w.usedPct)}
                  style={{ width: `${w.usedPct ?? 0}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-neutral-200">
                {w.usedPct == null ? '—' : `${Math.round(w.usedPct)}% used`}
              </span>
              <span
                className="w-24 shrink-0 text-right tabular-nums text-neutral-500 whitespace-nowrap"
                title={w.resetsAt == null ? undefined : `Resets at ${formatTime(w.resetsAt)}`}
              >
                {w.resetsAt == null
                  ? ''
                  : w.resetsAt - now <= 0
                    ? 'resetting…'
                    : `in ${formatCountdown(w.resetsAt - now)}`}
              </span>
            </li>
          ))}
          {/* 추가 크레딧은 한도 "창"이 아니라 월 단위 지갑이라 리셋 카운트다운이 없고,
              위 타일의 최대 사용률 롤업에도 참여하지 않는다. 계정에 켜진 적이 있을 때만 보인다. */}
          {extra && (
            <li className="flex items-center gap-2.5 text-xs border-t border-[var(--surface-2)] pt-2">
              <span className="w-28 shrink-0 truncate text-neutral-400">Extra usage</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                <div
                  className={'h-full ' + usedTone(extra.utilization)}
                  style={{ width: `${Math.min(100, Math.max(0, extra.utilization ?? 0))}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-neutral-200">
                {extra.utilization == null ? '—' : `${Math.round(extra.utilization)}% used`}
              </span>
              <span className="w-24 shrink-0 text-right tabular-nums text-neutral-500 whitespace-nowrap">
                {extra.isEnabled ? formatCredits(extra) : 'off'}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** 크레딧은 최소 단위(센트)로 오므로 통화 금액으로 되돌려 "$21 / $30" 처럼 보여준다. */
function formatCredits(extra: NonNullable<UsageInfo['extraUsage']>): string {
  const { usedCredits, monthlyLimit, currency } = extra
  if (usedCredits == null || monthlyLimit == null) return ''
  const sign = currency === 'USD' || currency == null ? '$' : `${currency} `
  return `${sign}${Math.round(usedCredits / 100)} / ${sign}${Math.round(monthlyLimit / 100)}`
}

function OverviewCard({
  workspace,
  repoName,
  flags,
  now,
  cost,
  showCost,
  onOpen
}: {
  workspace: Workspace
  repoName: string
  flags: { running: boolean; attention: boolean; unread: boolean; idle: boolean }
  now: number
  cost: number
  showCost: boolean
  onOpen: () => void
}): React.JSX.Element {
  const git = useStore((s) => s.gitStatus[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  const runningSince = useStore((s) => s.runningSince[workspace.id])
  const context = useStore((s) => s.contextUsage[workspace.id])

  const displayName = workspaceDisplayName(workspace, pr?.title)

  return (
    <button
      onClick={onOpen}
      className={
        'text-left rounded-xl border bg-[var(--bg-2)] p-3 transition-all duration-150 hover:border-[var(--border-strong)] hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-none ' +
        (flags.attention
          ? 'border-[var(--warning-500)]/40'
          : flags.running
            ? 'border-[var(--info-500)]/30'
            : workspace.status === 'error'
              ? 'border-[var(--danger-500)]/30'
              : 'border-[var(--surface-2)]')
      }
    >
      <div className="flex items-center gap-2">
        <StatusDot workspace={workspace} attention={flags.attention} />
        <span className="flex-1 min-w-0 truncate text-sm text-neutral-100" title={displayName}>
          {displayName}
        </span>
        {flags.attention && (
          <ShieldQuestion size={13} className="text-[var(--warning-400)] shrink-0" />
        )}
        {flags.unread && !flags.attention && (
          <span
            className="h-2 w-2 rounded-full bg-[var(--info-500)] shrink-0"
            title="Unread response"
          />
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-500 min-w-0">
        <span className="truncate text-neutral-600">{repoName}</span>
        <GitBranch size={10} className="shrink-0" />
        <span className="truncate">{workspace.branch}</span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {flags.running && runningSince ? (
          <span className="flex items-center gap-1 text-[var(--info-400)] tabular-nums">
            <Loader2 size={10} className="animate-spin" />
            {formatDuration(now - runningSince)}
          </span>
        ) : (
          <span className="text-neutral-600">{workspace.status}</span>
        )}
        {git && git.changedFiles > 0 && (
          <span className="text-[var(--warning-500)]/80" title="Changed files">
            {git.changedFiles} changed
          </span>
        )}
        {showCost && cost > 0 && (
          <span className="text-neutral-500 tabular-nums" title="Cost so far in this workspace">
            {formatCost(cost)}
          </span>
        )}
        {context && context.percentage > 0 && (
          <span
            className="text-neutral-600 tabular-nums"
            title="Context window used in the last turn"
          >
            {Math.round(context.percentage <= 1 ? context.percentage * 100 : context.percentage)}%
            ctx
          </span>
        )}
        {pr && (
          <span
            className="flex items-center gap-1 text-[var(--accent-300)]/80 ml-auto truncate"
            title={pr.label}
          >
            <GitPullRequest size={10} className="shrink-0" />
            <span className="truncate">{pr.label}</span>
          </span>
        )}
      </div>
    </button>
  )
}

function StatusDot({
  workspace,
  attention
}: {
  workspace: Workspace
  attention: boolean
}): React.JSX.Element {
  if (attention) return <ShieldQuestion size={13} className="text-[var(--warning-400)] shrink-0" />
  if (workspace.status === 'running')
    return <Loader2 size={13} className="text-[var(--info-400)] animate-spin shrink-0" />
  // 색만으로 idle/error 를 구분하지 않도록 error 는 별도 아이콘(경고 삼각형)으로 표시한다.
  if (workspace.status === 'error')
    return (
      <AlertTriangle size={12} className="text-[var(--danger-400)] shrink-0" aria-label="Error" />
    )
  return <span className="h-2 w-2 rounded-full shrink-0 bg-neutral-600" aria-label="Idle" />
}
