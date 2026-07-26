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
