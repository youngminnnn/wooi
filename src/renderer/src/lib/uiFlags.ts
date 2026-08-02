/**
 * "한 번 보여 주고, 닫으면 다시 안 뜨는" 류의 순수 화면 플래그를 실행 간에 기억한다.
 *
 * 권위 있는 설정(AppSettings)에 넣지 않는 이유: 이건 기기별 UI 기억일 뿐이고, main 프로세스가
 * 알아야 할 도메인 상태가 아니다(우측 패널 상태·테마 캐시와 같은 계층). 그래서 IPC 왕복도 없다.
 * localStorage 접근 실패(private 모드 등)는 무시한다 — 기억은 편의 기능일 뿐, 없으면 힌트가
 * 한 번 더 보이는 정도의 비용이다.
 */

/** 사이드바 ⌘K 힌트를 사용자가 닫았는지. */
export const QUICK_SWITCH_HINT_DISMISSED = 'quickSwitchHintDismissed'

/**
 * 이 리포의 설정 모달을 한 번이라도 열어 봤는지.
 *
 * "설정이 비어 있음"이 아니라 "아직 열어 본 적 없음"을 기준으로 안내 점을 띄우기 위한 것.
 * 스크립트를 일부러 비워 둔 리포에까지 상시 배지를 다는 건 잔소리가 된다 — 한 번 보고 나면
 * 사용자가 내린 결정이므로 다시 채근하지 않는다.
 */
export const repoSettingsSeenFlag = (repoId: string): string => `repoSettingsSeen.${repoId}`

/**
 * 이 리포에 "전달 목록이 비었는데 후보가 있다"는 제안을 이미 띄웠는지.
 *
 * 워크스페이스를 만들 때마다 반복하면 잔소리가 되므로 리포당 한 번만 띄운다. 제안을 수락하면
 * carryItems 가 차서 조건 자체가 사라지고, 무시하더라도 기능의 존재는 이미 전달됐다
 * (이후로는 설정 모달에서 언제든 직접 켤 수 있다).
 */
export const carrySuggestShownFlag = (repoId: string): string => `carrySuggestShown.${repoId}`

const key = (name: string): string => `wooi.${name}`

export function readUiFlag(name: string): boolean {
  try {
    return localStorage.getItem(key(name)) === 'true'
  } catch {
    return false
  }
}

export function setUiFlag(name: string, value: boolean): void {
  try {
    localStorage.setItem(key(name), String(value))
  } catch {
    /* 무시 */
  }
}
