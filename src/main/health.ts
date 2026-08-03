import { monitorEventLoopDelay } from 'node:perf_hooks'
import { app } from 'electron'
import { log } from './logger'

/**
 * 메인 프로세스의 건강 지표를 주기적으로 로그에 남긴다.
 *
 * 성능 문제는 재현한 기기에서만 보이는데, 그 기기의 개발자 도구를 열어 볼 수는 없다. 그래서
 * "무엇이 느린가"를 앱이 스스로 기록하게 한다 — 로그 파일 한 장이면 사후에 판정할 수 있다.
 *
 * 두 가지를 본다. 이 둘이 서로 다른 원인을 가리키기 때문이다:
 * - **이벤트 루프 지연** — 메인이 동기 작업(디스크 쓰기·직렬화)에 붙잡혀 있다는 뜻이다.
 *   여기가 높으면 IPC 와 창 이벤트가 밀려 앱 전체가 굼떠 보인다.
 * - **프로세스별 메모리와 살아 있는 세션 수** — 여기가 크면 원인은 블로킹이 아니라 메모리
 *   압박이고(스와핑), 루프 지연을 아무리 낮춰도 체감은 그대로다.
 */

/** 보고 주기. 사람이 로그를 훑어 추세를 볼 용도라 분 단위면 충분하다. */
const REPORT_INTERVAL_MS = 5 * 60_000

/** 히스토그램 해상도(ms). 촘촘히 잡을수록 오버헤드가 늘고, 20ms 면 체감 지연을 잡기에 충분하다. */
const RESOLUTION_MS = 20

/**
 * 계측을 시작한다. liveSessions 는 지금 살아 있는 에이전트 세션 수를 돌려주는 함수다 —
 * 세션 하나당 CLI 자식 프로세스가 붙으므로, 메모리 사용량을 읽을 때 가장 중요한 곁수치다.
 */
export function initHealthLogging(liveSessions: () => number): void {
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  loop.enable()

  const timer = setInterval(() => {
    // 백분위는 ns 로 나온다. 지난 주기의 값만 보도록 읽은 뒤 초기화한다.
    const p99 = Math.round(loop.percentile(99) / 1e6)
    const max = Math.round(loop.max / 1e6)
    loop.reset()

    let totalMb = 0
    const parts: string[] = []
    try {
      for (const m of app.getAppMetrics()) {
        const mb = Math.round((m.memory.workingSetSize ?? 0) / 1024)
        totalMb += mb
        parts.push(`${m.type}=${mb}`)
      }
    } catch {
      // 메트릭 조회 실패로 계측이 앱을 방해할 이유는 없다 — 루프 지연만이라도 남긴다.
    }

    // 에이전트 CLI 는 Electron 프로세스가 아니라 이 합계에 안 잡힌다. 세션 수가 그 몫의 대리 지표다.
    log.info(
      `health: loop p99=${p99}ms max=${max}ms | sessions=${liveSessions()} | ` +
        `electron ${totalMb}MB (${parts.join(' ')})`
    )
  }, REPORT_INTERVAL_MS)
  // 이 타이머 때문에 프로세스가 살아 있을 이유는 없다.
  timer.unref?.()
}
