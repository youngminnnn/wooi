export const OPEN_NEW_WORKSPACE_MENU_EVENT = 'wooi:open-new-workspace-menu'

/** 포커스된 리포의 사이드바 + 버튼 메뉴를 키보드 단축키에서도 같은 경로로 연다. */
export function openNewWorkspaceMenu(repoId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_NEW_WORKSPACE_MENU_EVENT, { detail: repoId }))
}
