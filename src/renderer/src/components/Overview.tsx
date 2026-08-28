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
  MessageSquarePlus,
  SquareArrowOutUpRight,
  Terminal
} from 'lucide-react'
import { backgroundTaskCount, refreshAccountUsage, useStore } from '../store'
import { useNow } from '../lib/useNow'
import { formatCost, formatCountdown, formatDuration, formatTime } from '../lib/format'
import { workspaceDisplayName } from '@shared/types'
import type {
  AgentBackendId,
  PermissionRequest,
  RateLimitSnapshot,
  UsageInfo,
  Workspace
} from '@shared/types'
import { askSummary } from '@shared/askSummary'
import { isPaneWindow } from '../lib/paneWindow'
import { headlineWindows, normalizeUtilization } from '../lib/rateLimit'
import type { RateLimitWindow } from '../lib/rateLimit'
import { ClaudeMark, CodexMark } from './BrandIcons'
import CacheTimer from './CacheTimer'

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
  const detachPane = useStore((s) => s.detachPane)
  const stopAll = useStore((s) => s.stopAll)
  const confirm = useStore((s) => s.confirm)
  const [filter, setFilter] = useState<FilterKey>('all')

  const active = useMemo(() => app.workspaces.filter((w) => !w.archived), [app.workspaces])
  const anyRunning = active.some((w) => w.status === 'running')

  const auth = useStore((s) => s.authStatus)
  const connectedAgents = (['claude', 'codex'] as const).filter((id) => {
    const hasActiveWorkspace = active.some((w) => w.agentBackend === id)
    const hasSnapshot =
      id === 'claude'
        ? !!(app.rateLimitsByAgent?.claude ?? app.rateLimits)
        : !!app.rateLimitsByAgent?.codex
    // 인증 조회는 앱 시작·focus 때 여러 번 겹칠 수 있고 일시 실패도 가능하다. 이미 이 backend를
    // 쓰는 workspace나 account snapshot이 있는데 loggedIn 하나만 보고 패널을 제거하지 않는다.
    return !!auth?.agents[id]?.loggedIn || hasActiveWorkspace || hasSnapshot
  })
  const codexConnected = connectedAgents.includes('codex')

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

  // Codex account usage 는 이미 AppState 의 backend별 스냅샷으로 관리된다. Overview 에서
  // workspace /usage 를 다시 실행하면 같은 rate-limit RPC를 중복 호출하므로, 전용 갱신 경로만
  // 한 번 호출하고 저장된 스냅샷은 갱신이 끝나기 전에도 그대로 표시한다.
  const lastCodexRefreshNonce = useRef<number | null>(null)
  const [codexUsageLoading, setCodexUsageLoading] = useState(false)
  const [codexSnapshot, setCodexSnapshot] = useState<RateLimitSnapshot | undefined>(
    app.rateLimitsByAgent?.codex
  )
  useEffect(() => {
    if (!codexConnected || lastCodexRefreshNonce.current === usageNonce) return
    lastCodexRefreshNonce.current = usageNonce
    setCodexUsageLoading(true)
    void refreshAccountUsage('codex')
      .then((next) => {
        // refresh 응답 자체가 최신 상태의 정본이다. evtState 방송 수신 여부에 화면 갱신을 의존하지 않는다.
        setCodexSnapshot(next.rateLimitsByAgent?.codex)
        useStore.setState({ app: next })
      })
      .finally(() => setCodexUsageLoading(false))
  }, [codexConnected, usageNonce])

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

  // 분리한 현황판 창은 계속 보드로 남는다 — 카드를 누르면 메인 창을 앞으로 가져와 거기서 연다.
  const openWorkspace = (id: string): void => {
    if (isPaneWindow) void window.api.pane.selectWorkspace(id)
    else void selectWorkspace(id)
  }

  // 워크스페이스마다 대기 중인 요청 **하나**를 집어 둔다(가장 먼저 온 것). id 집합만 들고
  // 있었을 때는 방패 아이콘밖에 그릴 수 없었지만, 요청을 들고 있으면 무엇을 묻는지도 그릴 수 있다.
  const pendingByWorkspace = new Map<string, PermissionRequest>()
  for (const p of permissions)
    if (!pendingByWorkspace.has(p.workspaceId)) pendingByWorkspace.set(p.workspaceId, p)

  const flagsOf = (
    w: Workspace
  ): { running: boolean; attention: boolean; unread: boolean; idle: boolean } => {
    const running = w.status === 'running'
    const attention = pendingByWorkspace.has(w.id)
    const isUnread = !!unread[w.id]
    return { running, attention, unread: isUnread, idle: !running && !attention && !isUnread }
  }

  /** 입력 대기 중이면 무엇을 묻고 있는지 한 줄로. 아니면 빈 문자열. */
  const askOf = (w: Workspace): string => {
    const pending = pendingByWorkspace.get(w.id)
    return pending ? askSummary(pending) : ''
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
            {!isPaneWindow && (
              <button
                onClick={() => detachPane('overview')}
                aria-label="Open the overview in a separate window"
                title="Open in a separate window — keep the board on a second monitor"
                className="h-7 w-7 shrink-0 grid place-items-center rounded-md text-neutral-500 border border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-200"
              >
                <SquareArrowOutUpRight size={13} />
              </button>
            )}
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
                  agentId === 'codex'
                    ? (codexSnapshot ?? app.rateLimitsByAgent?.codex)
                    : app.rateLimitsByAgent
                      ? app.rateLimitsByAgent[agentId]
                      : agentId === 'claude'
                        ? app.rateLimits
                        : undefined
                }
                refreshNonce={usageNonce}
                refreshing={agentId === 'codex' && codexUsageLoading}
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
                ask={askOf(w)}
                now={now}
                cost={costByWorkspace[w.id] ?? 0}
                showCost={showCardCost}
                onOpen={() => openWorkspace(w.id)}
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
  const [loading, setLoading] = useState(agentId === 'claude' && !!targetId)
  const label = agentId === 'claude' ? 'Claude Code' : 'Codex'
  const panelLoading = loading || refreshing

  useEffect(() => {
    // Codex 는 상위 Overview 가 rateLimits.refresh()로 갱신한 AppState 스냅샷을 사용한다.
    // 여기서 /usage 를 호출하면 account/rateLimits/read와 account/read가 다시 직렬 실행된다.
    if (agentId === 'codex') {
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
  const source = useMemo<RateLimitWindow[]>(
    () =>
      usage?.rateLimitsAvailable && usage.rateLimits.length > 0
        ? usage.rateLimits
        : snapshot?.available
          ? snapshot.windows
          : [],
    [usage, snapshot]
  )
  const windows = useMemo<PlanWindow[]>(
    () =>
      source.map((window) => {
        const parsed = window.resetsAt ? Date.parse(window.resetsAt) : NaN
        return {
          label: window.label,
          usedPct: normalizeUtilization(window.utilization),
          resetsAt: Number.isNaN(parsed) ? null : parsed
        }
      }),
    [source]
  )
  // 대표 창은 상태줄과 **같은 규칙**으로 고른다(headlineWindows — Claude=5시간, Codex=주간).
  // 여기서만 "가장 많이 쓴 창"을 고르면 같은 계정을 두고 상태줄은 5시간(4%), Overview 는
  // 주간(78%) 을 말해 둘 중 하나가 틀린 것처럼 읽힌다. 숫자를 고정한 대가로 다른 창이 한도에
  // 임박한 걸 놓치지 않도록, 더 뜨거운 창은 hint 에 덧붙인다.
  const { shown, hotter } = useMemo(() => {
    const picked = headlineWindows(agentId, source)
    return {
      shown: picked.shown ? (windows.find((w) => w.label === picked.shown!.label) ?? null) : null,
      hotter: picked.hotter
    }
  }, [agentId, source, windows])

  return (
    <section className="rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] p-3.5">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-neutral-200">
        {agentId === 'claude' ? <ClaudeMark size={16} /> : <CodexMark size={16} />}
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
              value={shown?.usedPct == null ? '—' : `${shown.usedPct}%`}
              loading={panelLoading && !shown}
              hint={
                shown
                  ? `${shown.label} window used` +
                    (hotter
                      ? ` · ${hotter.label} is at ${normalizeUtilization(hotter.utilization)}%`
                      : '')
                  : `Checking ${label} limits…`
              }
            />
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label={shown ? `${shown.label} resets in` : 'Primary limit resets in'}
              value={shown?.resetsAt == null ? '—' : formatCountdown(shown.resetsAt - now)}
              loading={panelLoading && shown?.resetsAt == null}
              hint={
                shown?.resetsAt == null
                  ? `Checking the ${label} primary usage window…`
                  : `${shown.label} usage window resets at ${formatTime(shown.resetsAt)}`
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
  ask,
  now,
  cost,
  showCost,
  onOpen
}: {
  workspace: Workspace
  repoName: string
  flags: { running: boolean; attention: boolean; unread: boolean; idle: boolean }
  /** 입력 대기 중일 때 무엇을 묻고 있는지 한 줄. 그 외 상태에서는 빈 문자열. */
  ask: string
  now: number
  cost: number
  showCost: boolean
  onOpen: () => void
}): React.JSX.Element {
  const git = useStore((s) => s.gitStatus[workspace.id])
  const pr = useStore((s) => s.prStatus[workspace.id])
  const runningSince = useStore((s) => s.runningSince[workspace.id])
  const context = useStore((s) => s.contextUsage[workspace.id])
  const backgroundTasks = useStore((s) => backgroundTaskCount(s.runningAgents[workspace.id]))

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
        <StatusDot
          workspace={workspace}
          attention={flags.attention}
          backgroundTasks={backgroundTasks}
        />
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

      {/* 무엇을 묻고 있는지 한 줄. 카드 다섯 장이 동시에 물어볼 때 다섯 번 열어 보지 않고
          우선순위를 정하게 하는 것이 이 줄의 존재 이유다. 제목 바로 아래에 두어 훑을 때
          이름 다음으로 읽히게 한다. */}
      {ask && (
        <div className="mt-1.5 truncate text-xs text-[var(--warning-400)]/90" title={ask}>
          {ask}
        </div>
      )}

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
        <CacheTimer workspace={workspace} />
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
  attention,
  backgroundTasks
}: {
  workspace: Workspace
  attention: boolean
  /** 에이전트가 두고 간, 아직 살아 있는 백그라운드 셸의 수. 사이드바와 같은 판단을 쓴다. */
  backgroundTasks: number
}): React.JSX.Element {
  if (attention) return <ShieldQuestion size={13} className="text-[var(--warning-400)] shrink-0" />
  if (workspace.status === 'running')
    return <Loader2 size={13} className="text-[var(--info-400)] animate-spin shrink-0" />
  // 색만으로 idle/error 를 구분하지 않도록 error 는 별도 아이콘(경고 삼각형)으로 표시한다.
  if (workspace.status === 'error')
    return (
      <AlertTriangle size={12} className="text-[var(--danger-400)] shrink-0" aria-label="Error" />
    )
  // 대화는 끝났는데 에이전트가 두고 간 셸이 아직 돈다. 스피너를 쓰면 "에이전트가 일하는 중" 으로
  // 읽히므로 돌지 않는 아이콘으로 사실만 알린다(사이드바 StatusDot 과 같은 어휘).
  if (backgroundTasks > 0)
    return (
      <Terminal
        size={12}
        className="text-neutral-400 shrink-0"
        aria-label="Background tasks running"
      />
    )
  return <span className="h-2 w-2 rounded-full shrink-0 bg-neutral-600" aria-label="Idle" />
}
