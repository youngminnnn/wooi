/**
 * "Conductor·Orca 에서 옮겨오기 모달을 열어라" 를 앱 어디서든 요청하기 위한 얇은 이벤트 배선.
 * 모달의 열림 상태는 App 이 소유하는데 여는 자리는 사이드바·설정 등 App 의 자식이 아닌 곳이라,
 * 리포 설정 모달과 같은 커스텀 이벤트 패턴을 따른다([[repoSettings]]).
 */

import { isPaneWindow } from './paneWindow'

export const OPEN_MIGRATE_EVENT = 'wooi:open-migrate'

export function openMigrate(): void {
  // 분리한 패널 창에는 이 모달이 없다. 설정에서 열리는 흐름이라 그쪽에서 다시 열게 두면 된다.
  if (isPaneWindow) return
  window.dispatchEvent(new CustomEvent(OPEN_MIGRATE_EVENT))
}
