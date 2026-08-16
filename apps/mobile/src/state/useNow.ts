import { useEffect, useState } from 'react'

/**
 * 주기적으로 갱신되는 현재 시각.
 *
 * "마지막 확인 4분 전" 같은 표시는 **아무 데이터도 바뀌지 않는 동안에도** 낡는다.
 * 랩탑이 죽으면 last_seen_at 은 그대로 멈춰 있으므로, 시계가 따로 흐르지 않으면
 * 화면은 "방금 전"에 영원히 머문다 — 정확히 알아야 할 순간에 거짓말을 한다.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** "4m ago" 형태의 짧은 경과 표시. */
export function agoLabel(timestamp: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
