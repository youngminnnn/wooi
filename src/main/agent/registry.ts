import type { BrowserWindow } from 'electron'
import type { AgentBackendId } from '@shared/types'
import { SessionManager } from '../claude/manager'
import { CodexSessionManager } from '../codex/manager'
import { detectCodex } from '../codex/executable'
import { detectGrok } from '../grok/executable'
import { GrokSessionManager } from '../grok/manager'
import { isInstalled } from '../shell'
import { backendMeta, type AgentBackend, type TurnEndHook } from './backend'

/**
 * 백엔드 **구현**을 아는 유일한 모듈. 메타데이터 카탈로그(AGENT_BACKENDS·backendMeta)는 매니저를
 * 끌어오지 않는 backend.ts 에 있다 — 메타 하나 읽으려고 이 파일을 import 하면 매니저 그래프가
 * 통째로 딸려 오고 순환이 생기기 때문이다.
 */

/** main → renderer 채널 방송 함수. 각 백엔드가 이벤트를 렌더러로 흘려보낼 때 쓴다. */
export type Dispatch = (channel: string, payload: unknown) => void

/** 백엔드 구현이 메인으로부터 받는 의존성(이벤트 방송 + 활성 창 접근 + 턴 종료 통지). */
export interface BackendDeps {
  dispatch: Dispatch
  getWindow: () => BrowserWindow | null
  onTurnEnd?: TurnEndHook
}

/** 백엔드별 CLI 실행 파일 이름. 설치 감지의 단일 출처. */
export const BACKEND_CLI: Record<AgentBackendId, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok'
}

/**
 * 이 백엔드를 지금 쓸 수 있는지(구동 CLI 가 설치돼 있는지) 확인한다.
 *
 * 백엔드를 **인스턴스화하지 않고** 답해야 한다 — 아직 구현이 없거나 CLI 가 없는 백엔드도
 * 목록에는 나와야 하고(설치 안내를 띄우려면), 그걸 위해 프로세스를 띄울 수는 없기 때문이다.
 * 로그인 여부는 여기서 보지 않는다(그건 auth 계층의 몫). 여기는 "실행 가능한가"만 본다.
 */
export async function backendAvailability(
  id: AgentBackendId
): Promise<{ available: boolean; reason?: string }> {
  // Codex 는 설치 여부만으로 부족하다 — 너무 오래된 버전은 app-server 표면이 달라 붙지 않으므로,
  // 버전까지 보고 "업데이트하세요"라는 구체적인 안내를 돌려준다.
  if (id === 'codex') {
    const install = await detectCodex()
    return install.usable ? { available: true } : { available: false, reason: install.reason }
  }
  if (id === 'grok') {
    const install = await detectGrok()
    return install.usable ? { available: true } : { available: false, reason: install.reason }
  }

  const cli = BACKEND_CLI[id]
  if (!cli) return { available: false, reason: 'Unknown agent backend' }
  if (await isInstalled(cli)) return { available: true }
  return { available: false, reason: `${backendMeta(id).label} CLI (\`${cli}\`) is not installed` }
}

/**
 * 식별자에 해당하는 백엔드 인스턴스를 생성한다. 이 함수가 구체 구현(Claude SDK 등)을 아는
 * 유일한 지점이라, 새 백엔드 추가 시 분기 하나만 늘리면 된다.
 */
export function createBackend(id: AgentBackendId, deps: BackendDeps): AgentBackend {
  switch (id) {
    case 'grok':
      return new GrokSessionManager(deps.dispatch, deps.getWindow, deps.onTurnEnd)
    case 'codex':
      return new CodexSessionManager(deps.dispatch, deps.getWindow, deps.onTurnEnd)
    case 'claude':
    default:
      return new SessionManager(deps.dispatch, deps.getWindow, deps.onTurnEnd)
  }
}
