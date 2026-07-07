import type { BrowserWindow } from 'electron'
import type { AgentBackendId } from '@shared/types'
import { SessionManager } from '../claude/manager'
import { CLAUDE_META, type AgentBackend, type AgentBackendMeta } from './backend'

/** main → renderer 채널 방송 함수. 각 백엔드가 이벤트를 렌더러로 흘려보낼 때 쓴다. */
export type Dispatch = (channel: string, payload: unknown) => void

/** 백엔드 구현이 메인으로부터 받는 의존성(이벤트 방송 + 활성 창 접근). */
export interface BackendDeps {
  dispatch: Dispatch
  getWindow: () => BrowserWindow | null
}

/** 식별자별 백엔드 메타데이터 카탈로그. 새 백엔드는 여기에 메타와 createBackend 분기를 추가한다. */
export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendMeta> = {
  claude: CLAUDE_META
}

/** 알 수 없는/누락 식별자의 폴백 백엔드. */
export const DEFAULT_BACKEND_ID: AgentBackendId = 'claude'

/** 식별자에 해당하는 백엔드 메타를 돌려준다(없으면 기본 백엔드). */
export function backendMeta(id: AgentBackendId): AgentBackendMeta {
  return AGENT_BACKENDS[id] ?? AGENT_BACKENDS[DEFAULT_BACKEND_ID]
}

/**
 * 식별자에 해당하는 백엔드 인스턴스를 생성한다. 이 함수가 구체 구현(Claude SDK 등)을 아는
 * 유일한 지점이라, 새 백엔드 추가 시 분기 하나만 늘리면 된다.
 */
export function createBackend(id: AgentBackendId, deps: BackendDeps): AgentBackend {
  switch (id) {
    case 'claude':
    default:
      return new SessionManager(deps.dispatch, deps.getWindow)
  }
}
