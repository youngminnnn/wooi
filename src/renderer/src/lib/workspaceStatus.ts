import type { PrState, PrStatus, RateLimitPause, Workspace } from '@shared/types'

/** running 상태가 이 시간을 넘기면 "오래 실행 중" 힌트(멈춤일 수 있음)를 표시한다. */
export const RUNNING_STALE_MS = 5 * 60 * 1000

/**
 * `runningMs`/`stale` 을 계산해 StatusDot 에 그대로 펼쳐 넣을 수 있는 형태로 돌려준다.
 *
 * 이 세 줄이 소비자마다 복제되던 것이 사다리가 갈라진 경로 중 하나다 — QuickSwitcher 는
 * 아예 `stale={false} runningMs={0}` 으로 굳혀 두어 "5분 넘게 도는 중" 이 그 화면에서만
 * 영영 뜨지 않았다. 계산을 여기 한 곳에 두어 그 표류를 막는다.
 *
 * `runningSince` 가 없으면 `lastActiveAt` 을 근사치로 쓴다(세션이 재기동된 직후 등).
 */
export function runningFor(
  workspace: Pick<Workspace, 'status' | 'lastActiveAt'>,
  runningSince: number | undefined,
  now: number
): { runningMs: number; stale: boolean } {
  const start = runningSince ?? workspace.lastActiveAt
  const runningMs = workspace.status === 'running' ? Math.max(0, now - start) : 0
  return { runningMs, stale: runningMs >= RUNNING_STALE_MS }
}

export type StatusRung =
  | 'awaiting-permission'
  | 'compacting'
  | 'running-stale'
  | 'running'
  | 'rate-limited'
  | 'awaiting-stacked-work'
  | 'error'
  | 'background-tasks'
  | 'interrupted'
  | 'pr'
  | 'idle'

export interface WorkspaceStatusInput {
  status: Workspace['status']
  awaitingPermission: boolean
  /** 지금 무엇을 묻고 있는지 한 줄 요약. 비어 있으면 일반 문구로 물러선다. */
  ask?: string
  /** 마지막 턴이 사용자 중단으로 끝났는가([[wasInterrupted]]). 호출부가 판정해 넘긴다. */
  interrupted?: boolean
  compacting: boolean
  stale: boolean
  runningMs: number
  pendingRateLimitResume?: Workspace['pendingRateLimitResume']
  awaitingStackedWork?: Workspace['awaitingStackedWork']
  /** 제한에 걸린 상태(해제 시각이 지나지 않은 것). 호출부가 activeRateLimitPause 로 걸러 넘긴다. */
  rateLimited?: RateLimitPause | null
  /**
   * 에이전트가 두고 간, 아직 살아 있는 백그라운드 셸의 수. 상태를 running 으로 만들지는 않는다
   * ([[claude/session]] syncStatus) — 이 표시가 그 사실을 알리는 자리다.
   */
  backgroundTasks?: number
  pr?: PrStatus | null
}

export interface WorkspaceStatusDescriptor {
  rung: StatusRung
  /** 아이콘 종류. 렌더러가 lucide 컴포넌트로 푼다. 'dot' 이면 원형 점이다. */
  icon:
    | 'shield-question'
    | 'loader'
    | 'hourglass'
    | 'clock'
    | 'alert-triangle'
    | 'terminal'
    | 'circle-stop'
    | 'dot'
  /** 아이콘 색 유틸리티 클래스. 'dot' 일 때는 배경 클래스. */
  toneClass: string
  size: number
  spin: boolean
  title: string
  aria?: string
  /** 사람이 읽는 짧은 라벨. Overview 가 raw enum 대신 쓴다. */
  label: string
}

/**
 * 자동 이어가기 예약의 툴팁. 시각 하나만 보여 주면 "그때가 됐는데 왜 안 갔지" 를 설명하지 못한다 —
 * 네트워크가 없거나 이어 보낸 턴이 실패해 다시 기다리는 중이면 그 사정까지 말한다.
 *
 * 무엇 때문에 멈췄는지도 함께 말한다 — API 에 닿지 못해 걸린 예약을 "usage limit" 이라고 부르면
 * 사용자는 있지도 않은 제한이 풀리기를 기다리게 된다.
 */
export function resumeTitle(pending: NonNullable<Workspace['pendingRateLimitResume']>): string {
  const why =
    pending.cause === 'connection' ? 'Paused — no connection to the API' : 'Paused by usage limit'
  if (pending.blocked === 'offline') return `${why} — waiting for a network connection to continue`
  const at = new Date(pending.retryAt).toLocaleString()
  return pending.blocked === 'error'
    ? `${why} — the last attempt to continue failed, retrying at ${at}`
    : `${why} — scheduled to resume at ${at}`
}

/**
 * PR 상태별 점 색(bg) 과 라벨. Tailwind v4 는 보간한 클래스명을 스캔하지 못하므로
 * 상태마다 전체 클래스 문자열을 그대로 둔다(ChatView 의 PR_STYLE 와 색 일치).
 */
export const PR_DOT: Record<PrState, { dotClass: string; label: string }> = {
  draft: { dotClass: 'bg-neutral-400', label: 'Draft' },
  review_required: { dotClass: 'bg-[var(--warning-400)]', label: 'Review required' },
  changes_requested: { dotClass: 'bg-[var(--attention-400)]', label: 'Changes requested' },
  ci_pending: { dotClass: 'bg-[var(--warning-400)]', label: 'Checks pending' },
  ci_failed: { dotClass: 'bg-[var(--danger-400)]', label: 'Checks failed' },
  approved: { dotClass: 'bg-[var(--success-400)]', label: 'Ready to merge' },
  conflict: { dotClass: 'bg-[var(--danger-400)]', label: 'Conflict' },
  open: { dotClass: 'bg-[var(--open-400)]', label: 'Open' },
  merged: { dotClass: 'bg-[var(--merged-400)]', label: 'Merged' },
  closed: { dotClass: 'bg-neutral-500', label: 'Closed' }
}

/**
 * 워크스페이스 상태 표시의 판단 — 사이드바 행, ⌘K 퀵 스위처, 현황판이 같은 시각 언어를 쓰도록
 * 공유한다. 우선순위 순서를 바꾸지 마라: 각 분기 위 주석에 왜 그 자리인지가 적혀 있다.
 */
export function describeWorkspaceStatus({
  status,
  awaitingPermission,
  ask,
  interrupted = false,
  compacting,
  stale,
  runningMs,
  pendingRateLimitResume,
  awaitingStackedWork,
  rateLimited,
  backgroundTasks = 0,
  pr
}: WorkspaceStatusInput): WorkspaceStatusDescriptor {
  // 권한 대기는 가장 행동 가능한 상태라 다른 표시보다 우선한다.
  if (awaitingPermission) {
    return {
      rung: 'awaiting-permission',
      icon: 'shield-question',
      toneClass: 'text-[var(--warning-400)]',
      size: 13,
      spin: false,
      title: ask || 'Waiting for your permission',
      label: 'Needs input'
    }
  }
  if (status === 'running') {
    // 압축 중(보라) · 오래 실행(앰버, 멈춤일 수 있음) · 일반 실행(파랑) 을 색으로 구분한다.
    if (compacting) {
      return {
        rung: 'compacting',
        icon: 'loader',
        toneClass: 'text-[var(--merged-400)]',
        size: 13,
        spin: true,
        title: 'Compacting conversation…',
        label: 'Compacting'
      }
    }
    if (stale) {
      return {
        rung: 'running-stale',
        icon: 'loader',
        toneClass: 'text-[var(--warning-400)]',
        size: 13,
        spin: true,
        title: `Running for ${Math.round(runningMs / 60000)}m — may be stuck`,
        label: 'May be stuck'
      }
    }
    return {
      rung: 'running',
      icon: 'loader',
      toneClass: 'text-[var(--info-400)]',
      size: 13,
      spin: true,
      title: 'Running',
      label: 'Running'
    }
  }
  // 사용량 제한으로 멈춘 상태는 단순 idle 도, 그냥 error 도 아니다 — 시간이 지나면 스스로 풀리는
  // 대기다. PR 상태·에러보다 우선해 표시하되, 위의 권한 대기·실행 중처럼 지금 일어나고 있는
  // 상태에는 양보한다. 자동 이어가기가 꺼져 있어도(예약 없이 표시만 있어도) 같은 아이콘을 쓴다.
  if (pendingRateLimitResume || rateLimited) {
    const title = pendingRateLimitResume
      ? resumeTitle(pendingRateLimitResume)
      : rateLimited?.resetsAt
        ? `Stopped by usage limit — resets at ${new Date(rateLimited.resetsAt).toLocaleString()}`
        : 'Stopped by usage limit'
    return {
      rung: 'rate-limited',
      icon: 'hourglass',
      toneClass: 'text-[var(--warning-400)]',
      size: 12,
      spin: false,
      title,
      aria:
        pendingRateLimitResume?.cause === 'connection'
          ? 'Paused — no connection to the API'
          : 'Paused by usage limit',
      label: 'Rate limited'
    }
  }
  if (awaitingStackedWork) {
    return {
      rung: 'awaiting-stacked-work',
      icon: 'clock',
      toneClass: 'text-neutral-400',
      size: 12,
      spin: false,
      title: `Waiting for ${awaitingStackedWork.targets.length} stacked workspaces — until ${new Date(awaitingStackedWork.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      aria: 'Waiting for stacked work',
      label: 'Waiting on stack'
    }
  }
  // 에러는 PR 상태보다 우선해 알린다. 색만으로 idle 과 구분되지 않도록 경고 아이콘을 쓴다.
  if (status === 'error') {
    return {
      rung: 'error',
      icon: 'alert-triangle',
      toneClass: 'text-[var(--danger-400)]',
      size: 12,
      spin: false,
      title: 'Last turn ended with an error',
      aria: 'Error',
      label: 'Error'
    }
  }
  // 대화는 끝났는데 에이전트가 두고 간 셸이 아직 돈다. 스피너를 쓰면 "에이전트가 일하는 중" 으로
  // 읽히므로 — 그렇게 읽히는 것이 정확히 이 표시를 만들게 된 문제다 — 돌지 않는 아이콘으로 사실만
  // 알린다. 무엇이 도는지와 개별 중지 버튼은 바로 아래 붙는 실행 목록(WorkspaceAgents)에 있다.
  // PR 점보다 앞에 둔다: PR 상태는 언제 봐도 그대로지만 이건 지금 이 순간에만 있는 정보다.
  if (backgroundTasks > 0) {
    return {
      rung: 'background-tasks',
      icon: 'terminal',
      toneClass: 'text-neutral-400',
      size: 12,
      spin: false,
      title: `${backgroundTasks} background ${backgroundTasks === 1 ? 'task' : 'tasks'} still running here — the agent itself is idle`,
      aria: 'Background tasks running',
      label: 'Background tasks'
    }
  }
  // 사용자가 끊은 턴은 에이전트가 스스로 마친 턴과 같은 idle 이지만, 목록을 훑는 사람에게는
  // 전혀 다른 사실이다 — 하나는 끝났고 하나는 재개할 것이 남았다. 같은 회색 점으로 두면 그 둘을
  // 고를 수 없어서, 아직 할 일이 남은 쪽만 다른 글리프로 뽑아낸다. PR 점보다 앞에 둔다:
  // PR 상태는 언제 봐도 그대로지만 "내가 여기서 멈췄다" 는 지금 이어 갈지 정하는 데 쓰인다.
  if (interrupted) {
    return {
      rung: 'interrupted',
      icon: 'circle-stop',
      toneClass: 'text-neutral-400',
      size: 12,
      spin: false,
      title: 'Stopped by you — the turn did not finish',
      aria: 'Stopped by you',
      label: 'Stopped'
    }
  }
  // idle 이면서 PR 이 있으면 점 색으로 PR 상태를 한눈에 보여 준다.
  if (pr) {
    const { dotClass, label } = PR_DOT[pr.state]
    return {
      rung: 'pr',
      icon: 'dot',
      toneClass: dotClass,
      size: 8,
      spin: false,
      title: `PR #${pr.number} — ${label}`,
      label
    }
  }
  return {
    rung: 'idle',
    icon: 'dot',
    toneClass: 'bg-neutral-600',
    size: 8,
    spin: false,
    title: 'Idle — ready for input',
    label: 'Idle'
  }
}
