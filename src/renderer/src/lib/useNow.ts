import { useEffect, useState } from 'react'

/**
 * 일정 간격으로 현재 시각(epoch ms)을 갱신해 리렌더를 유발하는 훅.
 * 실행 중 세션의 경과 시간처럼 "흐르는" 표시를 위해 사용한다.
 * @param intervalMs 갱신 주기(기본 1초). active 가 false 면 타이머를 돌리지 않는다.
 */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])
  return now
}
