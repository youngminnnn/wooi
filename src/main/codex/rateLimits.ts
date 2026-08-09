import { WEEKLY_RATE_LIMIT_LABEL } from '@shared/types'

/** app-server가 알려 준 실제 rate-limit 창 길이를 사람이 읽을 수 있는 이름으로 바꾼다. */
export function durationLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback
  if (minutes % 10_080 === 0) {
    const weeks = minutes / 10_080
    return weeks === 1 ? WEEKLY_RATE_LIMIT_LABEL : `${weeks}-week`
  }
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}
