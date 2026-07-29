import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  Loader2,
  ShieldQuestion,
  GitPullRequest,
  Square,
  DollarSign,
  Gauge,
  Repeat,
  Timer,
  AlertTriangle
} from 'lucide-react'
import { useStore } from '../store'
import { useNow } from '../lib/useNow'
import { formatCost, formatCountdown, formatDuration, formatTime } from '../lib/format'
import { SESSION_RATE_LIMIT_LABEL, workspaceDisplayName } from '@shared/types'
import type { ChatItem, UsageInfo, Workspace } from '@shared/types'

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

/** 트랜스크립트의 result 아이템에서 누적 비용(USD)과 턴 수를 합산한다. */
function sessionStats(items: ChatItem[]): { cost: number; turns: number } {
  let cost = 0
  let turns = 0
  for (const it of items) {
    if (it.type === 'result') {
      cost += it.costUsd
      turns += it.numTurns
    }
  }
  return { cost, turns }
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

  // 비용/토큰 롤업: 모든 활성 세션의 트랜스크립트를 (없으면) 불러와 result 아이템에서 집계한다.
  const transcripts = useStore((s) => s.transcripts)
  const ensureHistory = useStore((s) => s.ensureHistory)
  useEffect(() => {
    for (const w of active) void ensureHistory(w.id)
  }, [active, ensureHistory])
  const perWorkspace = useMemo(() => {
    const map: Record<string, { cost: number; turns: number }> = {}
    for (const w of active) map[w.id] = sessionStats(transcripts[w.id] ?? [])
    return map
  }, [active, transcripts])
  const totals = useMemo(() => {
    let cost = 0
    let turns = 0
    for (const w of active) {
      cost += perWorkspace[w.id]?.cost ?? 0
      turns += perWorkspace[w.id]?.turns ?? 0
    }
    return { cost, turns }
  }, [active, perWorkspace])

  // 요금제 사용률(rate-limit) 롤업: Claude 처럼 "전체 사용량의 %"를 함께 보여준다.
  // rate limit 은 계정 단위 값이라 활성 세션 하나에 /usage 를 물으면 계정 전체가 반영된다.
  // (구독 요금제일 때만 값이 있고, API 키 세션이면 rateLimitsAvailable=false → 달러 표기로 폴백한다.)
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  // 조회는 세션 왕복이 필요해 즉답이 아니다. 응답 전까지 타일을 감추면 화면이 뒤늦게 밀려나므로
  // 자리는 유지한 채 로딩만 표시한다(usageLoading).
  const [usageLoading, setUsageLoading] = useState(true)
  const usageTargetId = (active.find((w) => w.status === 'running') ?? active[0])?.id
  // main 이 유지하는 계정 단위 스냅샷(재시작해도 남는다). 이번 조회가 창을 못 받았을 때의 폴백이자,
  // 앱을 막 켠 시점에 "이 계정이 요금제인가"를 즉시 알려 주는 근거다.
  const snapshot = app.rateLimits

  // SDK 는 호출할 때마다 계정 사용률을 새로 읽어오지만, 대상 세션이 바뀔 때만 물으면
  // 화면을 연 시점의 값이 그대로 굳어 claude.ai/데스크톱 앱과 어긋난다(5시간 창은 특히 빨리 움직인다).
  // 주기적으로, 그리고 창으로 돌아올 때 다시 물어 그 격차를 없앤다.
  const [usageNonce, setUsageNonce] = useState(0)
  const lastUsageFetch = useRef(0)
  useEffect(() => {
    const bump = (): void => setUsageNonce((n) => n + 1)
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

  useEffect(() => {
    if (!usageTargetId) {
      setUsage(null)
      setUsageLoading(false)
      return
    }
    let cancelled = false
    setUsageLoading(true)
    lastUsageFetch.current = Date.now()
    void window.api.commands
      .run(usageTargetId, 'usage')
      .then(({ result }) => {
        if (cancelled) return
        if (result?.kind === 'usage') setUsage(result.usage)
        setUsageLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setUsageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [usageTargetId, usageNonce])

  /**
   * 이 계정에 요금제 한도가 적용되는가. true=구독, false=API 키(달러 표기), null=아직 모름.
   * **창(window)이 왔는지로 판단하지 않는다** — 라이브 세션이 없을 때의 단명 조회는 available 만
   * 주고 창은 비워서 오기 때문에, 창 유무로 고르면 앱을 켠 직후 달러 타일이 떴다가 첫 메시지
   * 이후 % 타일로 바뀌는 깜빡임이 생긴다.
   */
  const planApplies: boolean | null = usage
    ? usage.rateLimitsAvailable
    : (snapshot?.available ?? null)

  // 한도 창(5시간·7일·Opus·Sonnet)을 표시용으로 정규화: 사용률·잔여율·리셋 시각.
  // 이번 조회가 창을 못 받았으면 저장된 스냅샷(마지막으로 알던 값)으로 폴백한다.
  const planWindows = useMemo<PlanWindow[]>(() => {
    const source =
      usage?.rateLimitsAvailable && usage.rateLimits.length > 0
        ? usage.rateLimits
        : snapshot?.available
          ? snapshot.windows
          : []
    return source.map((r) => {
      const used = r.utilization == null ? null : Math.min(100, Math.max(0, r.utilization))
      const parsed = r.resetsAt ? Date.parse(r.resetsAt) : NaN
      return {
        label: r.label,
        usedPct: used,
        resetsAt: Number.isNaN(parsed) ? null : parsed
      }
    })
  }, [usage, snapshot])

  // 실행 중 경과 시간과 한도 리셋 카운트다운은 둘 다 "흐르는" 표시라 같은 타이머로 갱신한다.
  // 경과 시간은 초 단위라 1초가 필요하지만, 카운트다운만 남았다면 분 단위 표시라 30초면 충분하다.
  const now = useNow(anyRunning ? 1000 : 30_000, anyRunning || planWindows.length > 0)

  // 여러 창 중 가장 많이 소진된 창을 대표값으로 노출한다.
  const planUsage = useMemo(() => {
    const withVals = planWindows.filter((w) => w.usedPct != null)
    if (withVals.length === 0) return null
    return withVals.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a))
  }, [planWindows])

  // "session limit" = 5시간 창. 언제 초기화되는지가 가장 자주 확인하는 값이라 타일로 승격한다.
  const sessionWindow = planWindows.find((w) => w.label === SESSION_RATE_LIMIT_LABEL)

  // 정액 요금제 사용자에게는 달러 표기가 와닿지 않는다 → 카드의 개별 비용도 숨긴다.
  // (rate limit 은 계정 단위라 워크스페이스별 %는 성립하지 않으므로 그냥 감춘다.)
  // 아직 계정 종류를 모르면(null) 감춘 채로 둔다 — 나중에 사라질 값을 먼저 보여 주지 않는다.
  const showCardCost = planApplies === false

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
          {counts.running > 0 && (
            <button
              onClick={onStopAll}
              className="ml-auto flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-[var(--danger-300)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 hover:bg-[var(--danger-500)]/20"
              title="Stop the current turn in every running session"
            >
              <Square size={11} fill="currentColor" />
              Stop all
            </button>
          )}
        </div>

        {/* 비용/토큰 롤업: 모든 세션의 누적 지출·턴 수를 한눈에. */}
        <div className="flex flex-wrap gap-2.5 mb-2.5">
          {/* 요금제(구독) 사용자는 정액제라 달러 금액이 와닿지 않는다 → 전체 사용량 %로 보여준다.
              API 키 사용자는 rate limit 이 아예 없으므로 누적 달러로 폴백한다.
              어느 타일을 띄울지는 **계정 종류(planApplies)** 로만 정한다 — 사용률 값이 아직
              도착하지 않았다고 달러 타일로 갈아타면, 첫 메시지 직후 타일이 통째로 바뀐다. */}
          {planApplies === false ? (
            <StatTile
              icon={<DollarSign size={14} className="text-[var(--success-400)]" />}
              label="Total spend"
              value={formatCost(totals.cost)}
              hint="Sum of session costs across all workspaces"
            />
          ) : (
            <StatTile
              icon={<Gauge size={14} className="text-[var(--warning-400)]" />}
              label="Plan usage"
              value={planUsage ? `${Math.round(planUsage.usedPct ?? 0)}%` : '—'}
              loading={usageLoading || !planUsage}
              hint={
                planUsage
                  ? `Highest plan rate-limit window used (${planUsage.label})` +
                    (totals.cost > 0 ? ` · ${formatCost(totals.cost)} spent in app` : '')
                  : 'Checking plan rate limits…'
              }
            />
          )}
          {/* 세션 한도(5시간 창)가 언제 초기화되는지. 값이 오기 전에도 자리를 잡아 두어야 값이 도착할 때
              뒤 타일들이 옆으로 밀리지 않는다. 요금제 한도가 없는 계정(API 키)이면 내린다. */}
          {sessionWindow?.resetsAt != null ? (
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label="Session resets in"
              value={formatCountdown(sessionWindow.resetsAt - now)}
              hint={
                `The ${SESSION_RATE_LIMIT_LABEL} session limit resets at ` +
                formatTime(sessionWindow.resetsAt) +
                (sessionWindow.usedPct == null
                  ? ''
                  : ` · ${Math.round(sessionWindow.usedPct)}% used`)
              }
            />
          ) : planApplies === false ? null : (
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label="Session resets in"
              value="—"
              loading
              hint="Checking the session limit window…"
            />
          )}
          <StatTile
            icon={<Repeat size={14} className="text-[var(--accent-400)]" />}
            label="Agent turns"
            value={totals.turns.toLocaleString()}
            hint="Total assistant turns across all workspaces"
          />
          <StatTile
            icon={<Loader2 size={14} className="text-[var(--info-400)]" />}
            label="Active now"
            value={String(counts.running)}
            hint="Sessions currently running"
          />
        </div>

        {/* 모델별(Opus·Sonnet)·기간별 한도 창의 잔여량. 조회가 끝나기 전에도 자리를 지켜
            레이아웃이 뒤늦게 밀리지 않게 한다. API 키 세션이면 조회 후 조용히 사라진다. */}
        {(planApplies !== false || planWindows.length > 0) && (
          <PlanLimits
            windows={planWindows}
            extra={usage?.extraUsage ?? null}
            loading={usageLoading}
            now={now}
          />
        )}

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
                cost={perWorkspace[w.id]?.cost ?? 0}
                showCost={showCardCost}
                onOpen={() => void selectWorkspace(w.id)}
              />
            ))}
          </div>
        )}

        <p className="mt-6 text-xs text-neutral-600 text-center">
          ⌘K to search · ⌘1–9 to switch · ⌘[ / ⌘] to cycle ·{' '}
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
  windows,
  extra,
  loading,
  now
}: {
  windows: PlanWindow[]
  extra: UsageInfo['extraUsage']
  loading: boolean
  now: number
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] px-3.5 py-3 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Plan usage</span>
        {loading && <Loader2 size={11} className="animate-spin text-neutral-500" />}
        {/* 모델별 창(Opus·Sonnet)은 계정에 있을 때만 행으로 나타나므로 헤더에서 약속하지 않는다. */}
        <span className="text-[11px] text-neutral-600">account-wide · used</span>
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
