/**
 * 오류 문구에서 "사용량 제한" 을 읽어내는 규칙.
 *
 * 워크스페이스 턴(claude/session.ts)과 PR 리뷰(review/manager.ts)가 **같은 판정을 써야 한다** —
 * 둘 다 같은 CLI 가 같은 문구로 알려 주는데, 한쪽만 알아보면 같은 사고가 한쪽에서는
 * "제한에 걸려 멈춤", 다른 쪽에서는 그냥 "실패" 로 보인다.
 */

/** fast-mode cooldown이 아닌 계정 전체 사용량 제한 문구만 좁게 식별한다. */
export const RATE_LIMIT_ERROR =
  /(?:usage limit|rate[ _-]?limit|quota).*(?:reached|exceeded|reset|available)|(?:reached|exceeded).*(?:usage limit|rate[ _-]?limit|quota)|hit your limit|assistant error:\s*rate_limit/i

/**
 * CLI 는 사용량 제한을 알릴 때 해제 시각을 epoch 로 덧붙인다
 * (예: `Claude AI usage limit reached|1754880000`).
 */
const RATE_LIMIT_RESET_EPOCH = /\|\s*(\d{10,13})\b/

/** 제한 오류 문구가 알려 준 해제 시각(epoch ms). 없거나 말이 안 되는 값이면 null. */
export function rateLimitResetAt(text: string | null, now: number): number | null {
  if (!text) return null
  const match = RATE_LIMIT_RESET_EPOCH.exec(text)
  if (!match) return null
  const digits = match[1]
  const at = digits.length >= 13 ? Number(digits) : Number(digits) * 1000
  // 스냅샷보다 이 값을 우선하므로, 미래이면서 상식적인 범위(30일)일 때만 믿는다.
  if (!Number.isFinite(at) || at <= now || at > now + 30 * 24 * 60 * 60_000) return null
  return at
}
