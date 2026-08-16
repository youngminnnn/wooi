import {
  RATE_LIMIT_STALE_AFTER_MS,
  RATE_LIMIT_WARN_THRESHOLD,
  SESSION_RATE_LIMIT_LABEL,
  WEEKLY_RATE_LIMIT_LABEL
} from '@shared/types'
import type { AgentBackendId, RateLimitSnapshot } from '@shared/types'

/** 레이트리밋 창 1개(스냅샷에 담긴 모양 그대로). */
export type RateLimitWindow = RateLimitSnapshot['windows'][number]

/**
 * 상태줄에 요약할 대표 창 = 가장 많이 소진된 창.
 * 세션을 실제로 죽이는 건 가장 먼저 차는 창이므로, 평균이나 첫 번째가 아니라 최대치를 보여 준다.
 * utilization 이 null 인 창(값 미제공)은 후보에서 제외한다. 후보가 없으면 null.
 */
export function tightestWindow(windows: RateLimitWindow[]): RateLimitWindow | null {
  const withValues = windows.filter((w) => w.utilization != null)
  if (!withValues.length) return null
  return withValues.reduce((a, b) => ((b.utilization ?? 0) > (a.utilization ?? 0) ? b : a))
}

/**
 * 상태줄에 요약할 대표 창을 **backend 별로 고정**한다.
 *
 * 예전에는 tightestWindow 로 "가장 많이 쓴 창"을 골랐는데, 그러면 같은 워크스페이스에서도
 * 사용률 순위가 바뀔 때마다 5시간 창과 주간 창이 번갈아 나와 무슨 숫자를 보고 있는지 알 수 없었다.
 * 그래서 백엔드마다 항상 같은 창을 보여 준다:
 *
 * - Claude: 5시간 세션 창 — 실제로 세션을 멈추는 건 이쪽이고, 사용자도 이 숫자로 페이스를 잡는다.
 * - Codex: 주간 창 — 요금제가 사실상 주 단위로 메기고, 5시간 창은 금방 리셋돼 페이스 판단에 덜 쓰인다.
 *
 * 정해 둔 창이 응답에 없을 때만 tightestWindow 로 폴백한다(빈 자리를 남기느니 다른 숫자라도 보여 준다).
 * 다 찬 다른 창을 놓치지 않게 하는 건 호출부의 경고색 몫이다.
 */
export function statusWindow(
  backend: AgentBackendId,
  windows: RateLimitWindow[]
): RateLimitWindow | null {
  const usable = windows.filter((w) => w.utilization != null)
  if (!usable.length) return null
  const preferred =
    backend === 'codex'
      ? usable.find((w) => isWeeklyLabel(w.label))
      : usable.find((w) => w.label === SESSION_RATE_LIMIT_LABEL)
  return preferred ?? tightestWindow(usable)
}

/**
 * 화면 하나가 요약해서 보여 줄 창 한 쌍 — 숫자로 쓸 대표 창(shown)과, 그것보다 더 뜨거워서
 * 경고로 덧붙여야 하는 창(hotter).
 *
 * 상태줄과 Overview 가 각자 대표 창을 고르면 같은 계정을 두고 5시간 4% 와 주간 78% 가 동시에
 * 보여 둘 중 하나가 틀린 값처럼 읽힌다. 고르는 규칙을 여기 하나로 두는 이유다.
 */
export function headlineWindows(
  backend: AgentBackendId,
  windows: RateLimitWindow[]
): { shown: RateLimitWindow | null; hotter: RateLimitWindow | null } {
  const shown = statusWindow(backend, windows)
  const hottest = tightestWindow(windows)
  const hotter =
    shown &&
    hottest &&
    hottest.label !== shown.label &&
    isWarning(normalizeUtilization(hottest.utilization))
      ? hottest
      : null
  return { shown, hotter }
}

/** 'Weekly'·'2-week' 처럼 주 단위 창인지(Codex 의 durationLabel 이 만드는 이름 기준). */
function isWeeklyLabel(label: string): boolean {
  return label === WEEKLY_RATE_LIMIT_LABEL || /\bweeks?\b/i.test(label)
}

/** 0–100 으로 정규화한 사용률(범위를 벗어난 값도 안전하게 자른다). null 이면 null. */
export function normalizeUtilization(utilization: number | null): number | null {
  if (utilization == null) return null
  return Math.min(100, Math.max(0, Math.round(utilization)))
}

/** 경고 임계치를 넘었는지. 임계치 '초과'(>)가 기준 — 정확히 80% 는 아직 경고가 아니다. */
export function isWarning(pct: number | null): boolean {
  return pct != null && pct > RATE_LIMIT_WARN_THRESHOLD
}

/** 스냅샷이 묵어서 신뢰할 수 없는 상태인지(흐리게 + "N분 전" 표시 대상). */
export function isStale(snapshot: RateLimitSnapshot, now: number): boolean {
  return now - snapshot.fetchedAt > RATE_LIMIT_STALE_AFTER_MS
}

/** "3m ago" 같은 상대 시각(스냅샷이 얼마나 묵었는지). */
export function agoLabel(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * 리셋까지 남은 시간("2h 10m"). 표시할 값이 없으면 null:
 * resetsAt 이 없거나, 파싱 불가이거나, 이미 지난 시각(= 곧 갱신될 값이라 굳이 보여 주지 않는다).
 */
export function resetLabel(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const left = at - now
  if (left <= 0) return null
  const min = Math.floor(left / 60_000)
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  const rem = min % 60
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * 상태줄에 레이트리밋을 그려야 하는지.
 *
 * - 스냅샷 없음(첫 조회 전): 숨긴다. 요금제/API 키 중 무엇인지 모르는 상태에서 자리를 잡으면
 *   API 키 사용자에게 잠깐 나타났다 사라지는 깜빡임이 된다.
 * - available=false(API 키 등 요금제 한도 미적용): 숨긴다 — 0% 나 "N/A" 를 보여 주지 않는다.
 * - 사용률이 있는 창이 하나도 없음: 보여 줄 숫자가 없으므로 숨긴다.
 */
export function shouldShowRateLimits(snapshot: RateLimitSnapshot | undefined): boolean {
  if (!snapshot || !snapshot.available) return false
  return tightestWindow(snapshot.windows) != null
}
