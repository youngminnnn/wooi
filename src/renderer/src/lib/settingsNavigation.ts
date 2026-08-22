export type SettingsPage =
  | 'general'
  | 'agents'
  | 'notifications'
  | 'integrations'
  | 'mcp'
  | 'plugins'
  | 'repositories'
  | 'about'

export const SETTINGS_PAGE_KEY = 'settings.lastPage'
export const OPEN_SETTINGS_EVENT = 'wooi:open-settings'

/** 설정 모달을 특정 페이지로 연다. 이미 있는 페이지가 명령 UX의 정본일 때 사용한다. */
export function openSettings(page: SettingsPage): void {
  localStorage.setItem(SETTINGS_PAGE_KEY, page)
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
}
