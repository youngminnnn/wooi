import { useStore } from '../store'

/**
 * gh(GitHub CLI) 연동 상태를 UI 에서 읽기 위한 헬퍼.
 *
 * gh 는 하드 게이트가 아니라 "필요할 때 요구하는" 선택 연동이다. 그래서 화면은 세 가지 상태를
 * 구분해야 한다 — 연결됨 / 확실히 미연결 / 아직 모름(인증 상태 로드 전).
 * "아직 모름"에서 미연결 UI 를 보이면 앱 기동 직후 버튼이 깜빡이므로, 그 동안에는 평소 UI 를
 * 그대로 두고 실제 클릭 시 requireGithub 가 판단하게 한다.
 */

/** gh 가 설치·로그인돼 PR·스택 기능을 바로 쓸 수 있는 상태. 로드 전에는 false. */
export function useGithubConnected(): boolean {
  return useStore((s) => !!s.authStatus?.github.installed && !!s.authStatus.github.loggedIn)
}

/**
 * gh 가 "확실히" 미연결인 상태(인증 상태를 받아 봤고, 설치 또는 로그인이 빠졌다).
 * PR 버튼·Check 탭 등을 "Connect GitHub" 로 바꿔 노출할지 판단할 때 쓴다.
 */
export function useGithubDisconnected(): boolean {
  return useStore(
    (s) => s.authStatus !== null && !(s.authStatus.github.installed && s.authStatus.github.loggedIn)
  )
}
