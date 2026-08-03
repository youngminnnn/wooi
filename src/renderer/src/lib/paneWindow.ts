import { PANE_KINDS } from '@shared/types'
import type { PaneKind } from '@shared/types'

/**
 * 이 창이 "분리한 패널 창" 인지 판별한다.
 *
 * 렌더러 번들은 하나이고, 창의 역할은 main 이 붙여 주는 URL 쿼리(`?pane=work&ws=…`)로만
 * 구분한다([[paneWindows]]). 모듈 로드 시 한 번 읽어 고정한다 — 창의 역할은 수명 내내 변하지 않는다.
 */
// DOM 이 없는 곳(유닛 테스트의 node 환경)에서도 import 체인에 딸려 들어오므로 window 를 가정하지 않는다.
const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const kind = params.get('pane')

/** 이 창이 그려야 할 패널. 메인 창이면 null. */
export const paneKind: PaneKind | null = PANE_KINDS.includes(kind as PaneKind)
  ? (kind as PaneKind)
  : null

/** 창이 열릴 때 지정된 워크스페이스(이후로는 메인 창의 선택을 따라간다). */
export const paneWorkspaceId: string | null = params.get('ws')

/** 메인 창 전용 로직(알림·배지·폴링·선택 전파)을 건너뛰기 위한 플래그. */
export const isPaneWindow = paneKind !== null
