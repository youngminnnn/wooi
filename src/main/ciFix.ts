/**
 * CI 가 실패했을 때 에이전트에게 턴을 하나 열지 말지 정하는 조건을, 테스트할 수 있는 순수
 * 함수 하나에 모은다. [[conflictResolve]] 의 `pickAutoResolveStep` 과 같은 자리다 —
 * 토큰을 쓰는 결정은 전부 이런 경계를 지나게 한다.
 */

import type { PrCheck, PrChecks } from '@shared/types'
import { CI_FIX_MAX_ATTEMPTS } from '@shared/types'

// 상한은 화면에도 적어야 해서 shared 에 산다. 판정은 여기서만 하지만 값은 한 곳에서 온다.
export { CI_FIX_MAX_ATTEMPTS }

/** 워크스페이스 하나의 auto-fix 진행 상태. 워크스페이스 레코드에 영속된다. */
export interface CiFixState {
  /** 이 상태가 가리키는 PR. 달라지면 처음부터 다시 센다. */
  prNumber: number
  /** 이 PR 에서 자동으로 연 턴의 수. */
  attempts: number
  /**
   * 지금 실패를 보고 턴을 열어도 되는가.
   *
   * 한 번 열면 잠근다. CI 결과는 새로 밀기 전까지 계속 "실패" 로 남아 있으므로, 이 잠금이
   * 없으면 45 초 폴링마다 같은 실패를 새 사건으로 읽고 턴을 다시 연다. 다시 열리는 것은
   * 체크가 **새로 도는 것**(pending)을 본 다음이다 — 그게 곧 "에이전트가 뭔가 밀었다" 는
   * 신호이고, 우리가 다음 판정을 내려도 되는 유일한 근거다.
   */
  armed: boolean
  /** 상한에 닿아 멈췄다고 이미 알렸는가. 같은 말을 폴링마다 반복하지 않는다. */
  notifiedStop: boolean
}

export type CiFixDecision =
  /** 아무것도 하지 않는다. `state` 는 그대로 영속한다(null 이면 지운다). */
  | { kind: 'idle'; state: CiFixState | null }
  /** 턴을 연다. */
  | { kind: 'fix'; state: CiFixState; failed: PrCheck[] }
  /** 상한에 닿았다 — 사용자에게 알리고 멈춘다. */
  | { kind: 'stop'; state: CiFixState; failed: PrCheck[] }

/** 롤업이 **끝났는가**. 하나라도 돌고 있으면 아직 판정할 때가 아니다. */
export function checksSettled(checks: PrChecks): boolean {
  return !checks.checks.some((check) => check.state === 'pending')
}

/** 실패로 확정된 체크들. 취소(neutral)·건너뜀은 실패가 아니다([[github]] 의 mapCheckRun). */
export function failedChecks(checks: PrChecks): PrCheck[] {
  return checks.checks.filter((check) => check.state === 'failure')
}

function fresh(prNumber: number): CiFixState {
  return { prNumber, attempts: 0, armed: true, notifiedStop: false }
}

/**
 * 지금 auto-fix 턴을 열지 정한다.
 *
 * 부작용이 없다 — 부르는 쪽이 결과를 보고 보내고, 돌려받은 `state` 를 영속한다. 그래서
 * "몇 번 만에 멈추는가" 를 gh 도 세션도 없이 테스트할 수 있다.
 */
export function decideCiFix({
  enabled,
  running,
  checks,
  prev
}: {
  enabled: boolean
  /** 이 워크스페이스에서 이미 턴이 돌고 있는가. */
  running: boolean
  checks: PrChecks | null
  prev: CiFixState | null
}): CiFixDecision {
  // 꺼져 있으면 기록도 지운다. 다시 켜는 것은 명시적인 사용자 동작이니 그때는 처음부터 센다.
  if (!enabled) return { kind: 'idle', state: null }
  // 체크를 못 읽었으면(PR 없음·gh 실패) 아무 판단도 하지 않는다. 모르는 것을 성공으로도
  // 실패로도 읽지 않아야 시도 횟수가 엉뚱하게 리셋되거나 늘지 않는다.
  if (!checks || checks.checks.length === 0) return { kind: 'idle', state: prev }

  // PR 이 바뀌면 이전 PR 의 시도 횟수는 의미가 없다.
  const state = prev && prev.prNumber === checks.prNumber ? { ...prev } : fresh(checks.prNumber)

  if (!checksSettled(checks)) {
    // 체크가 돌고 있다 = 새로 민 것이 있다. 다음 실패는 새 사건이므로 다시 열 수 있게 한다.
    state.armed = true
    return { kind: 'idle', state }
  }

  const failed = failedChecks(checks)
  if (failed.length === 0) {
    // 초록으로 끝났다. 이 PR 에서 쌓인 시도 횟수를 여기서 푼다 — 이후에 새 실패가 나면
    // 그건 앞선 실패와 무관한 사건이고, 상한도 새로 받아야 한다.
    return { kind: 'idle', state: fresh(checks.prNumber) }
  }

  // 이미 이 실패로 턴을 열었다. 새 CI 실행을 보기 전까지는 같은 사건을 다시 세지 않는다.
  if (!state.armed) return { kind: 'idle', state }

  if (state.attempts >= CI_FIX_MAX_ATTEMPTS) {
    // 상한에 닿았다. 알림은 한 번만 — 폴링마다 같은 배너를 다시 띄우지 않는다.
    if (state.notifiedStop) return { kind: 'idle', state }
    return { kind: 'stop', state: { ...state, notifiedStop: true }, failed }
  }

  // 이미 도는 턴이 있으면 기다린다. armed 를 유지해 다음 폴링에서 다시 본다 — 지금 도는 턴이
  // 마침 그 실패를 고치는 중일 수도 있고, 그 위에 끼어들면 시도 횟수만 축낸다.
  if (running) return { kind: 'idle', state }

  return {
    kind: 'fix',
    state: { ...state, attempts: state.attempts + 1, armed: false },
    failed
  }
}

/** 프롬프트에 싣는 로그 한 덩어리. */
export interface CiFailureLog {
  checkName: string
  /** 실패한 잡 로그의 꼬리. 못 가져왔으면 없다. */
  text?: string
}

/**
 * auto-fix 턴의 본문.
 *
 * 왜 열렸는지를 첫 줄에 적는다 — 사용자가 치지 않은 턴이 대화에 나타나는 것이라, 이유와
 * 끄는 법을 모르면 앱이 제멋대로 구는 것으로 읽힌다. 몇 번째 시도이고 몇 번에서 멈추는지도
 * 함께 적는다. 에이전트가 "이번이 마지막" 임을 알면 무리한 추측 대신 보고를 택할 수 있다.
 */
export function buildCiFixPrompt(input: {
  prNumber: number
  prUrl: string
  failed: PrCheck[]
  logs: CiFailureLog[]
  attempt: number
  max: number
}): string {
  const names = input.failed.map((check) => `- ${check.name}`).join('\n')
  const logs = input.logs
    .filter((log) => log.text)
    .map((log) => `### ${log.checkName}\n\n\`\`\`\n${log.text}\n\`\`\``)
    .join('\n\n')

  return `Wooi started this turn automatically because "Fix failing checks with the agent" is on for this workspace; you can turn it off in the Checks panel. This is attempt ${input.attempt} of ${input.max} — after ${input.max}, Wooi stops and leaves it to a human.

CI is failing on pull request #${input.prNumber} (${input.prUrl}).

Failing checks:
${names}

${logs ? `Failure output:\n\n${logs}\n` : 'Wooi could not read the failure logs — inspect the checks yourself before changing anything.\n'}
Find the cause, fix it, and push to this branch so the checks run again.

Work only on what these failures point to. Do not refactor unrelated code, and do not touch other branches.

If the failure is not something the code in this branch can fix — a missing secret, an infrastructure outage, or a flaky test unrelated to this change — say so and stop instead of guessing. Stopping with an explanation is more useful than a speculative commit.`
}
