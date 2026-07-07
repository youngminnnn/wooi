import { createServer } from 'node:net'
import { BASE_DEV_PORT } from '@shared/types'

/**
 * 포트가 실제로 비어 있는지 OS 수준에서 확인한다. 잠깐 listen 을 시도해 보고 성공하면
 * 곧바로 닫는다 — listen 이 EADDRINUSE 로 실패하면 누군가 점유 중이다.
 * 외부 프로세스(다른 앱·이전 dev 서버)가 잡고 있는 포트는 ditto state 만으로는 알 수 없으므로,
 * dev 포트를 배정하기 전에 이 프로브로 충돌을 한 번 더 피한다.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * start 부터 위로 올라가며, 이미 배정된(used) 포트와 OS 가 점유 중인 포트를 모두 건너뛰고
 * 처음으로 비어 있는 포트를 고른다. 무한 루프를 막기 위해 탐색 범위를 제한하고,
 * 끝까지 못 찾으면 used 만 회피한 값으로 폴백한다(프로브 자체가 실패하는 환경 대비).
 */
export async function findFreePort(used: Set<number>, start = BASE_DEV_PORT): Promise<number> {
  const LIMIT = 1000
  for (let port = start; port < start + LIMIT; port++) {
    if (used.has(port)) continue
    if (await isPortFree(port)) return port
  }
  // 프로브가 모두 실패하는 비정상 환경 — state 충돌만 피한 값이라도 돌려준다.
  let port = start
  while (used.has(port)) port++
  return port
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 포트가 timeoutMs 안에 비워지는지 폴링한다. dev 서버를 재시작할 때, 방금 종료시킨 이 워크스페이스
 * 자신의 이전 프로세스가 포트를 놓을 때까지 잠깐 기다리는 용도다 — 그래야 자기 포트를 "외부 점유"로
 * 오인해 매 재시작마다 포트를 바꾸는 일이 없다. 시간 안에 비면 true, 끝까지 점유면 false(=외부 점유).
 */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await isPortFree(port)) return true
    if (Date.now() - start >= timeoutMs) return false
    await delay(100)
  }
}
