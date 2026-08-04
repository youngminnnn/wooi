import { join } from 'node:path'
import type { AgentBackendId } from '@shared/types'
import type { CodexMcpServer } from '../codex/protocol'
import { BRIDGE_ENV } from './protocol'

/**
 * codex 스레드에 붙일 위임 MCP 서버의 실행 설정.
 *
 * 별도 node 를 배포하지 않으므로 **Electron 바이너리를 node 모드로** 띄운다
 * (`ELECTRON_RUN_AS_NODE=1`). 이건 Electron 앱이 자기 번들 스크립트를 자식 프로세스로 돌릴 때
 * 쓰는 표준 방법이고, 이 경로에서는 GUI 도 Chromium 도 필요 없다.
 */
export function delegateServerConfig(args: {
  socketPath: string
  workspaceId: string
  backends: AgentBackendId[]
}): CodexMcpServer {
  return {
    command: process.execPath,
    args: [delegateServerScript()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      [BRIDGE_ENV.socket]: args.socketPath,
      [BRIDGE_ENV.workspaceId]: args.workspaceId,
      [BRIDGE_ENV.backends]: args.backends.join(',')
    }
  }
}

/**
 * 번들된 delegateServer 스크립트의 절대 경로.
 *
 * electron-vite 는 main 의 모든 엔트리를 같은 디렉터리에 낸다. 그래서 host 를
 * `utilityProcess.fork` 로 띄우는 곳과 **같은 규칙**(이 모듈 기준 상대 경로)으로 찾는다 —
 * 패키징 여부에 따라 갈리는 경로 계산을 새로 만들지 않는다.
 */
function delegateServerScript(): string {
  return join(import.meta.dirname, 'delegateServer.js')
}
