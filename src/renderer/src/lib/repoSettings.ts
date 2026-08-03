/**
 * "리포 설정 모달을 열어라" 를 앱 어디서든 요청하기 위한 얇은 이벤트 배선.
 *
 * 모달의 열림 상태(configRepoId)는 App 이 소유하는데, 이걸 열고 싶은 곳은 App 의 자식이
 * 아닌 데가 많다 — zustand 스토어의 토스트 액션, 사이드바 깊은 곳, 스크립트 패널 등.
 * 그 전부에 콜백을 프롭으로 꿰는 대신, 이미 앱이 쓰고 있는 커스텀 이벤트 패턴
 * (`wooi:open-shortcuts`, `wooi:archive-workspace` …)을 그대로 따른다.
 */

import { isPaneWindow } from './paneWindow'

export const OPEN_REPO_SETTINGS_EVENT = 'wooi:open-repo-settings'

/**
 * 해당 리포의 설정 모달을 연다. App 의 리스너가 받아 모달을 띄운다.
 *
 * 분리한 패널 창([[paneWindow]])에는 그 모달이 없으므로 요청을 메인 창으로 넘긴다 — 보조
 * 모니터에서 누른 버튼이 아무 반응도 없는 것처럼 보이지 않도록.
 */
export function openRepoSettings(repoId: string): void {
  if (isPaneWindow) {
    void window.api.pane.openRepoSettings(repoId)
    return
  }
  window.dispatchEvent(new CustomEvent(OPEN_REPO_SETTINGS_EVENT, { detail: repoId }))
}
