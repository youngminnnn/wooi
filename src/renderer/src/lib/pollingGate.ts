/**
 * 주기 폴링(git status·PR·리뷰·인증)을 지금 돌려야 하는지 판정한다.
 *
 * **왜 규칙을 여기 따로 두는가.** 예전 게이트는 스토어 안의 `windowFocused` 하나였고, 그래서
 * 창을 앞에 띄운 채 자리를 뜨면 아무 세션도 돌지 않는 밤새 15초마다 워크트리 전체에 git 을,
 * 45초마다 리포마다 `git fetch` 를 돌렸다. 배터리를 태우는 쪽은 렌더러의 CPU 가 아니라 이
 * 45초짜리 프로세스·라디오 깨우기였다.
 *
 * 판정을 스토어 밖으로 꺼낸 이유는 규칙이 세 신호의 논리곱이라 눈으로 읽어서는 틀리기 쉽기
 * 때문이다 — 여기 두면 세 신호의 조합을 표로 검증할 수 있다.
 */

/**
 * 이만큼 입력이 없으면 자리를 비운 것으로 본다.
 *
 * 5분은 "잠깐 화면을 읽는 중"과 "자리에 없음"을 가르는 값이다. 짧게 잡으면 긴 diff 를 읽는
 * 동안 배지가 굳고, 길게 잡으면 아낄 구간이 사라진다. 어느 쪽으로 틀려도 손해가 작다 —
 * 자리를 비운 것으로 잘못 판정해도 첫 입력에서 즉시 따라잡기 때문이다.
 */
export const USER_IDLE_AFTER_MS = 5 * 60_000

export interface PollingGateInput {
  /** main 의 focus/blur 로 갱신되는 권위 있는 포커스 상태. */
  focused: boolean
  /** `document.visibilityState === 'visible'`. 최소화·다른 Space·숨김이면 false. */
  visible: boolean
  /** 이 창에 마지막으로 입력이 들어온 시각(epoch ms). */
  lastUserActivityAt: number
  /** 판정 시각(epoch ms). */
  now: number
}

/**
 * 세 신호를 모두 본다. 어느 하나도 나머지를 대신하지 못한다:
 *
 * - `focused` — 다른 앱을 쓰는 중. 창이 보여도 사용자의 관심은 여기 없다.
 * - `visible` — 최소화·가려짐. 포커스는 그대로인데 화면에는 아무것도 안 그려진다.
 * - 입력 시각 — 창이 앞에 있고 보이는데 사람이 없는 경우. 앞의 둘로는 절대 잡히지 않는다.
 */
export function shouldPoll({
  focused,
  visible,
  lastUserActivityAt,
  now
}: PollingGateInput): boolean {
  return focused && visible && now - lastUserActivityAt < USER_IDLE_AFTER_MS
}

/** 자리를 비운 뒤 입력이 돌아왔는가 — 밀린 폴링을 한 번에 따라잡을 시점. */
export function returnedFromIdle(lastUserActivityAt: number, now: number): boolean {
  return now - lastUserActivityAt >= USER_IDLE_AFTER_MS
}
