import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { agentToolsFor, wooiMcpInstructions, WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import type { AgentBackendId } from '@shared/types'

/**
 * 에이전트에게 Wooi 자체를 노출하는 인프로세스 MCP 서버.
 *
 * 이 층은 **아무 일도 하지 않는다** — 카탈로그를 돌며 도구를 만들고, 호출을 그대로 메인으로
 * 넘긴다. 도구가 무엇을 하는지는 메인의 실행부만 안다([[agent/tools]]). 그래서 도구를 하나
 * 늘리는 비용은 카탈로그 한 항목 + 메인 핸들러 하나이고, 이 파일은 그대로다.
 *
 * `callTool` 을 인자로 받는 이유는 순환 import 를 피하기 위해서다 — 호스트가 이 함수를 부르고
 * 자기 왕복 함수를 넘긴다(host.ts callMain). 그래야 이 파일이 host 를 import 하지 않는다.
 */
export function createWooiMcpServer(
  callTool: (tool: string, args: unknown) => Promise<unknown>,
  /** 이 워크스페이스가 띄울 수 있는 서브에이전트 종류. 비어 있으면 위임 도구가 없다. */
  delegateBackends: AgentBackendId[] = [],
  /** Solo 일 때, 팀으로 바꿀 수 있는가. 안내 한 줄을 붙일지 가른다([[agent/tools/catalog]]). */
  canSwitchToAgentTeam = false
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: WOOI_MCP_SERVER_NAME,
    version: '1.0.0',
    instructions: wooiMcpInstructions(delegateBackends, canSwitchToAgentTeam),
    tools: agentToolsFor(delegateBackends).map((spec) =>
      tool(
        spec.name,
        spec.description,
        spec.inputSchema,
        async (args) => {
          // 실패는 던져 보낸다 — MCP 층이 도구 오류로 감싸 모델에게 주고, 모델은 그 문장을 읽고
          // 스스로 고쳐 다시 부를 수 있다(예: "커밋하고 다시 호출하라").
          const data = await callTool(spec.name, args)
          return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? null) }] }
        },
        {
          ...(spec.annotations ? { annotations: spec.annotations } : {}),
          ...(spec.alwaysLoad ? { alwaysLoad: spec.alwaysLoad } : {})
        }
      )
    )
  })
}
