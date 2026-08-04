import type { AgentBackendId } from '@shared/types'

/**
 * 위임 브리지 프로토콜 — 번들된 MCP 서버(delegateServer.ts) ↔ 메인.
 *
 * ## 왜 소켓이 필요한가
 *
 * Claude 는 SDK 의 in-process MCP 서버를 세션에 그대로 꽂을 수 있지만(claude/delegate.ts),
 * Codex 에는 그런 것이 없다. `thread/start` 의 `config.mcp_servers` 로 **stdio 서버 실행 명령**을
 * 넘기는 것이 유일한 경로이고(실측 확인), 그러면 그 서버는 codex app-server 의 자식 프로세스로
 * 뜬다 — 우리 메인 프로세스 밖이다.
 *
 * 그런데 위임을 실제로 돌리는 데 필요한 것들(워크스페이스 설정·권한 라우팅·"실행 중 에이전트"
 * 갱신·중단)은 전부 메인이 소유한다. 그래서 MCP 서버는 **판단하지 않고** 이 소켓으로 요청을
 * 넘기기만 하고, 메인이 runSubAgent 를 돌려 결과를 돌려준다.
 *
 * 줄바꿈으로 구분된 JSON 한 줄씩 주고받는다. MCP 자체가 같은 프레이밍이라 서버 쪽 코드가
 * 두 프로토콜을 같은 방식으로 다룰 수 있다.
 */

/** MCP 서버 → 메인. */
export type BridgeRequest = {
  type: 'delegate'
  /** 이 요청의 식별자(서버가 발급). 응답을 짝지을 때만 쓴다. */
  id: string
  /** 어느 워크스페이스가 부른 것인지. 서버 프로세스는 스레드 하나에 매여 있으므로 고정값이다. */
  workspaceId: string
  backend: AgentBackendId
  description: string
  prompt: string
}

/** 메인 → MCP 서버. */
export type BridgeResponse = {
  type: 'result'
  id: string
  /** 서브에이전트의 최종 답변. 실패면 비어 있을 수 있다. */
  text?: string
  /** 실패 사유. 있으면 MCP 도구 결과를 isError 로 돌려준다. */
  error?: string
}

/**
 * MCP 서버 프로세스가 자기 정체를 받는 환경변수.
 *
 * 인자가 아니라 환경변수인 이유: codex 가 `mcp_servers.<name>.env` 를 그대로 자식에게 넘겨
 * 준다는 것을 실측으로 확인했고(codex/probe 참고), 소켓 경로가 명령줄에 남아 `ps` 에 노출되는
 * 것보다 낫기 때문이다.
 */
export const BRIDGE_ENV = {
  socket: 'WOOI_DELEGATE_SOCKET',
  workspaceId: 'WOOI_DELEGATE_WORKSPACE',
  /** 이 워크스페이스에서 띄울 수 있는 백엔드(쉼표 구분). 도구 스키마의 enum 이 된다. */
  backends: 'WOOI_DELEGATE_BACKENDS'
} as const
