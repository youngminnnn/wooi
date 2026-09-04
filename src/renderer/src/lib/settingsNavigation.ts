export type SettingsPage =
  | 'general'
  | 'agents'
  | 'notifications'
  | 'integrations'
  | 'mcp'
  | 'plugins'
  | 'repositories'
  | 'about'

/**
 * 설정 페이지 목록 — 라벨과 검색 키워드.
 *
 * 설정 모달의 좌측 목록과 그 검색창이 쓰던 것을 여기로 올렸다. ⌘K 팔레트가 설정 항목까지
 * 찾아 주려면 같은 목록을 봐야 하는데, 컴포넌트 안의 module-private 상수는 밖에서 읽을 수
 * 없어 베껴 쓰게 된다 — 그러면 키워드가 두 벌이 되고 한쪽만 늙는다.
 *
 * 아이콘은 여기 두지 않는다. 그건 그리는 쪽의 사정이고, 이 파일을 lucide 에 묶으면 순수 함수
 * 테스트에서 React 아이콘까지 끌려온다.
 */
export const SETTINGS_PAGES: { id: SettingsPage; label: string; keywords: string }[] = [
  {
    id: 'general',
    label: 'General',
    keywords:
      'theme appearance panel sidebar workspace order activity recent sort pin creation sleep awake power display confirmation confirm ask again archive density summary verbose transcript conversation'
  },
  {
    id: 'agents',
    label: 'Agents',
    keywords: 'model permission reasoning effort fast compact claude codex'
  },
  {
    id: 'notifications',
    label: 'Notifications',
    keywords: 'notification sound badge completed error input'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: 'login account github claude codex connect'
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    keywords: 'mcp model context protocol server tool stdio http sse claude.json'
  },
  {
    id: 'plugins',
    label: 'Plugins',
    keywords: 'plugin marketplace codex agent skill hook extension install'
  },
  {
    id: 'repositories',
    label: 'Repositories',
    keywords: 'repo setup dev archive carry worktree'
  },
  { id: 'about', label: 'About', keywords: 'version update tour help' }
]

export const SETTINGS_PAGE_KEY = 'settings.lastPage'
export const OPEN_SETTINGS_EVENT = 'wooi:open-settings'

/** 설정 모달을 특정 페이지로 연다. 이미 있는 페이지가 명령 UX의 정본일 때 사용한다. */
export function openSettings(page: SettingsPage): void {
  localStorage.setItem(SETTINGS_PAGE_KEY, page)
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
}
