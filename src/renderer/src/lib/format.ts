/**
 * main 의 sanitizeBranch([[git]]) 와 같은 규칙으로 브랜치 슬러그를 미리보기한다.
 * 두 곳이 어긋나면 표시와 실제 생성 브랜치가 달라지므로 규칙을 동일하게 유지한다.
 */
export function sanitizePreview(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '')
    .replace(/^[-/]+/, '')
    .replace(/\/{2,}/g, '/')
  return slug || 'workspace'
}

/** epoch ms 를 로컬 시:분 으로(메시지 hover 표시용). */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** USD 비용을 표시용 문자열로. 0 이면 빈 문자열, 1센트 미만은 4자리, 그 이상은 2자리. */
export function formatCost(usd: number): string {
  if (!usd) return ''
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

/**
 * 경과 시간(ms)을 짧은 표시 문자열로(실행 중 세션의 진행 시간용).
 * 1분 미만은 초, 1시간 미만은 분(+초), 그 이상은 시(+분).
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM ? `${h}h ${remM}m` : `${h}h`
}
