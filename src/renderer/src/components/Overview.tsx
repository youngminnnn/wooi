import { useEffect, useMemo, useState } from 'react'
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

/** 요금제 한도 창 하나를 표시용으로 정규화한 값. utilization 이 없는 창은 null 로 남긴다. */
type PlanWindow = {
  label: string
  /** 0–100 사용률. */
  usedPct: number | null
  /** 0–100 잔여율(= 100 - usedPct). */
  leftPct: number | null
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
  // 자리는 유지한 채 로딩만 표시한다(usageLoading). usageChecked 는 "한 번이라도 응답을 받았나"로,
  // 요금제(%) 타일과 달러 타일 중 무엇을 보여줄지 정하는 데만 쓴다(대상이 바뀌어도 되돌리지 않아
  // 재조회 중 마지막 상태를 유지한다).
  const [usageLoading, setUsageLoading] = useState(true)
  const [usageChecked, setUsageChecked] = useState(false)
  const usageTargetId = (active.find((w) => w.status === 'running') ?? active[0])?.id
  useEffect(() => {
    if (!usageTargetId) {
      setUsage(null)
      setUsageLoading(false)
      setUsageChecked(true)
      return
    }
    let cancelled = false
    setUsageLoading(true)
    void window.api.commands
      .run(usageTargetId, 'usage')
      .then(({ result }) => {
        if (cancelled) return
        if (result?.kind === 'usage') setUsage(result.usage)
        setUsageChecked(true)
        setUsageLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setUsageChecked(true)
        setUsageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [usageTargetId])

  // 한도 창(5시간·7일·Opus·Sonnet)을 표시용으로 정규화: 사용률·잔여율·리셋 시각.
  const planWindows = useMemo<PlanWindow[]>(() => {
    if (!usage?.rateLimitsAvailable) return []
    return usage.rateLimits.map((r) => {
      const used = r.utilization == null ? null : Math.min(100, Math.max(0, r.utilization))
      const parsed = r.resetsAt ? Date.parse(r.resetsAt) : NaN
      return {
        label: r.label,
        usedPct: used,
        leftPct: used == null ? null : 100 - used,
        resetsAt: Number.isNaN(parsed) ? null : parsed
      }
    })
  }, [usage])

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
  const isSubscription = usage?.rateLimitsAvailable === true
  const showCardCost = usageChecked && !isSubscription

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
              API 키 사용자는 rate limit 이 없으니(planUsage=null) 기존 누적 달러로 폴백한다.
              첫 조회 전에는 어느 쪽인지 모르므로, 타일 자리는 잡아 두고 값만 로딩으로 표시한다. */}
          {!usageChecked ? (
            <StatTile
              icon={<Gauge size={14} className="text-[var(--warning-400)]" />}
              label="Plan usage"
              value="—"
              loading
              hint="Checking plan rate limits…"
            />
          ) : planUsage ? (
            <StatTile
              icon={<Gauge size={14} className="text-[var(--warning-400)]" />}
              label="Plan usage"
              value={`${Math.round(planUsage.usedPct ?? 0)}%`}
              loading={usageLoading}
              hint={
                `Highest plan rate-limit window used (${planUsage.label})` +
                (totals.cost > 0 ? ` · ${formatCost(totals.cost)} spent in app` : '')
              }
            />
          ) : (
            <StatTile
              icon={<DollarSign size={14} className="text-[var(--success-400)]" />}
              label="Total spend"
              value={formatCost(totals.cost)}
              loading={usageLoading}
              hint="Sum of session costs across all workspaces"
            />
          )}
          {/* 세션 한도(5시간 창)가 언제 초기화되는지. 조회 전에도 자리를 잡아 두어야 값이 도착할 때
              뒤 타일들이 옆으로 밀리지 않는다. 리셋 시각을 끝내 모르면(=API 키) 그때 내린다. */}
          {!usageChecked ? (
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label="Session resets in"
              value="—"
              loading
              hint="Checking the session limit window…"
            />
          ) : sessionWindow?.resetsAt != null ? (
            <StatTile
              icon={<Timer size={14} className="text-[var(--info-400)]" />}
              label="Session resets in"
              value={formatCountdown(sessionWindow.resetsAt - now)}
              hint={
                `The ${SESSION_RATE_LIMIT_LABEL} session limit resets at ` +
                formatTime(sessionWindow.resetsAt) +
                (sessionWindow.leftPct == null
                  ? ''
                  : ` · ${Math.round(sessionWindow.leftPct)}% left`)
              }
            />
          ) : null}
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
        {(!usageChecked || planWindows.length > 0) && (
          <PlanLimits windows={planWindows} loading={usageLoading} now={now} />
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

/** 잔여량이 적을수록 눈에 띄게. 25%/10% 아래에서 경고·위험 색으로 바뀐다. */
function leftTone(leftPct: number | null): string {
  if (leftPct == null) return 'bg-[var(--surface-3)]'
  if (leftPct <= 10) return 'bg-[var(--danger-400)]'
  if (leftPct <= 25) return 'bg-[var(--warning-400)]'
  return 'bg-[var(--accent-400)]'
}

/**
 * 요금제 한도 창별(5시간·7일·모델별) 잔여 사용량과 리셋까지 남은 시간.
 * rate limit 은 계정 단위 값이라 워크스페이스와 무관하게 계정 전체 기준으로 동일하다.
 */
function PlanLimits({
  windows,
  loading,
  now
}: {
  windows: PlanWindow[]
  loading: boolean
  now: number
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--surface-2)] bg-[var(--bg-2)] px-3.5 py-3 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">
          Remaining plan usage
        </span>
        {loading && <Loader2 size={11} className="animate-spin text-neutral-500" />}
        {/* 모델별 창(Opus·Sonnet)은 계정에 있을 때만 행으로 나타나므로 헤더에서 약속하지 않는다. */}
        <span className="text-[11px] text-neutral-600">account-wide</span>
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
                  className={'h-full ' + leftTone(w.leftPct)}
                  style={{ width: `${w.leftPct ?? 0}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-neutral-200">
                {w.leftPct == null ? '—' : `${Math.round(w.leftPct)}% left`}
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
        </ul>
      )}
    </div>
  )
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
