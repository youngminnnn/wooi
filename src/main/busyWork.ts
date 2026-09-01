import { getStore } from './store'

/**
 * "끝나기를 기다려야 하는 일" 의 개수. 업데이트 예약 재시작([[main/updater]])과 종료 가드
 * ([[main/backgroundMode]])가 **같은 판정**을 본다.
 *
 * 판정을 하나로 모으는 이유는 [[main/sleepBlocker]] 헤더와 같다 — 두 곳이 따로 세면
 * "일이 남았다" 와 "다 끝났다" 가 동시에 참인 상태가 생기고, 그때 앱이 어떻게 행동할지는
 * 아무도 설명할 수 없다.
 *
 * 세는 것: 진행 중인 에이전트 턴(workspace.status === 'running')과 진행 중인 PR 리뷰.
 * 세지 않는 것: 스크립트(dev 서버)와 터미널. 사용자가 직접 띄운 장기 실행 프로세스라 끝날 일이
 * 없고, 이것까지 기다리면 예약도 백그라운드 모드도 영원히 풀리지 않는다.
 */

/**
 * 이 시간 동안 아무 흔적도 남기지 않은 'running' 은 굳은 것으로 보고 세지 않는다.
 *
 * [[main/sleepBlocker]] 의 STALE_AFTER_MS 와 같은 값·같은 이유다. 다만 여기서는 대가가 더
 * 크다 — 수면 방지는 굳은 워크스페이스 하나가 맥을 깨워 둘 뿐이지만, 이 판정에는 "앱을 언제
 * 꺼도 되는가" 가 걸려 있어서 상한이 없으면 **앱이 영영 종료되지 않는다.**
 *
 * 상한을 넘겨 세지 않게 된 턴이 사실은 살아 있었더라도 일을 잃지는 않는다 — 종료 경로가
 * captureRunningTurns 로 기록하고 다음 실행이 이어받는다([[main/shutdownResume]]).
 */
export const BUSY_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export function busyWorkCount(now: number = Date.now()): number {
  const state = getStore().getState()
  const turns = state.workspaces.filter(
    (w) => !w.archived && w.status === 'running' && now - w.lastActiveAt <= BUSY_STALE_AFTER_MS
  ).length
  const reviews = state.reviews.filter(
    (r) => r.status === 'running' || r.status === 'preparing'
  ).length
  return turns + reviews
}
