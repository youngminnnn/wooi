import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendId,
  type EffortSetting,
  type PermissionMode,
  type RunningAgent
} from '@shared/types'
import { runSubAgent, type SubAgentPermission } from '../subagent/run'
import {
  DELEGATE_ARG_TEXT,
  DELEGATE_MCP_SERVER_NAME,
  delegateServerInstructions,
  delegateTools
} from '../subagent/catalog'
import { log } from '../logger'

/**
 * 위임 서브에이전트 도구(`mcp__wooi_agents__<backend>_subagent`)를 세션에 붙이는 in-process
 * MCP 서버 — 메인 에이전트가 **다른 종류의** 에이전트를 서브에이전트로 띄울 수 있게 한다.
 *
 * ## 왜 MCP 인가
 *
 * Claude 도 Codex 도 자기 서브에이전트는 자기 모델로만 돌린다(Claude 의 AgentDefinition.model 은
 * Claude 모델만 받는다). 두 제품이 공유하는 확장 지점은 MCP 하나뿐이라, 교차 백엔드 위임은
 * 여기를 통할 수밖에 없다. Claude 쪽은 SDK 가 in-process 서버를 지원하므로 프로세스가 늘지 않고,
 * agent-host 안에서 그대로 돈다.
 *
 * ## 왜 Task 를 막지 않나
 *
 * 사용자가 제품을 지목하지 않은 작업에는 네이티브 서브에이전트가 여전히 더 낫다(맥락 공유·비용).
 * 이 도구는 그것과 경쟁하는 것이 아니라 **제품을 지목했을 때** 쓰는 보완재다. 그 경계를 어떻게
 * 문구로 그었는지, 그리고 첫 판에서 왜 졌는지는 subagent/catalog.ts 에 적혀 있다.
 */

/** 위임 도구가 부모 세션에서 받아야 하는 것들. */
export interface DelegateDeps {
  /** 부모 워크스페이스의 worktree. 위임된 실행도 같은 체크아웃에서 돈다. */
  cwd: string
  repoPath: string | null
  /**
   * 띄울 수 있는 에이전트 종류. **종류마다 도구가 하나씩** 생기므로, 여기 없는 백엔드는 이름
   * 자체가 존재하지 않는다. 비어 있으면 서버를 만들지 않는다(호출부가 판단).
   */
  backends: AgentBackendId[]
  /**
   * 지금 이 순간의 부모 권한 모드. 세션 중에 바뀌므로 값이 아니라 함수로 받는다 —
   * 위임된 실행이 부모보다 넓은 권한을 갖는 일은 없어야 한다.
   */
  permissionMode: () => PermissionMode
  /** 백엔드별 모델·effort 기본값(워크스페이스/전역 설정에서 내려온 값). */
  defaults: (backend: AgentBackendId) => { model: string | null; effort: EffortSetting | null }
  /**
   * 도구 승인 콜백(부모 세션의 canUseTool). 위임 실행의 도구 호출이 부모와 같은 규칙·같은 UI 를
   * 타게 한다. Codex 위임은 이 값을 쓰지 않는다 — `codex exec` 에는 승인 채널이 없다.
   */
  canUseTool: SubAgentPermission
  /** 사이드바 "실행 중 에이전트" 목록에 넣거나 갱신한다. */
  upsertAgent: (agent: RunningAgent) => void
  /** 목록에서 뺀다(성공·실패·중단 모두). */
  removeAgent: (taskId: string) => void
}

export interface DelegateServer {
  /** query options.mcpServers 에 그대로 얹는 값. */
  config: McpSdkServerConfigWithInstance
  /**
   * 진행 중인 위임 실행을 전부 끊는다. 부모 턴이 인터럽트되거나 세션이 정리될 때 호출한다 —
   * 그러지 않으면 워크스페이스를 닫아도 `codex exec` 가 살아남는다.
   */
  abortAll: () => void
}

export function createDelegateServer(deps: DelegateDeps): DelegateServer {
  /** 진행 중인 위임 실행. 부모 턴이 끊길 때 함께 끊기 위해 들고 있는다. */
  const running = new Map<string, AbortController>()

  const backends = deps.backends

  /**
   * 도구 하나의 본체. 백엔드는 **이름에 박혀 있으므로** 인자가 아니라 클로저로 들어온다 —
   * 모델이 고를 수 있는 값이 아니어서 잘못된 백엔드가 올 수 없다.
   */
  const run = async (
    backend: AgentBackendId,
    description: string,
    prompt: string
  ): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
    const taskId = randomUUID()
    const abort = new AbortController()
    running.set(taskId, abort)

    const agent: RunningAgent = {
      taskId,
      backend,
      agentType: AGENT_BACKEND_LABELS[backend],
      description,
      startedAt: Date.now(),
      toolUses: 0
    }
    deps.upsertAgent(agent)

    const { model, effort } = deps.defaults(backend)
    try {
      const result = await runSubAgent({
        backend,
        cwd: deps.cwd,
        repoPath: deps.repoPath,
        model,
        effort,
        permissionMode: deps.permissionMode(),
        prompt,
        abort,
        onActivity: (activity) => {
          if (activity.kind === 'tool') {
            agent.toolUses = (agent.toolUses ?? 0) + 1
            agent.lastToolName = activity.toolName ?? activity.text
          }
          deps.upsertAgent(agent)
        },
        // Codex 서브런은 이 콜백을 무시한다(`codex exec` 가 비대화형이라 승인 채널이 없다).
        canUseTool: deps.canUseTool
      })

      if (result.error && !result.text) return errorResult(result.error)
      // 아무 말도 없이 끝나는 경우가 있다(중단되었거나 도구만 돌리고 끝난 실행). 빈 문자열을
      // 그대로 돌려주면 모델이 성공으로 오해하므로 사실대로 적는다.
      return textResult(
        result.text || `${AGENT_BACKEND_LABELS[backend]} finished without returning any text.`
      )
    } catch (err) {
      log.error('delegate: sub-agent run threw', err)
      return errorResult(err instanceof Error ? err.message : String(err))
    } finally {
      running.delete(taskId)
      deps.removeAgent(taskId)
    }
  }

  const tools = delegateTools(backends).map((spec) =>
    tool(
      spec.name,
      spec.description,
      {
        description: z.string().describe(DELEGATE_ARG_TEXT.description),
        prompt: z.string().describe(DELEGATE_ARG_TEXT.prompt)
      },
      (args) => run(spec.backend, args.description, args.prompt)
    )
  )

  return {
    config: createSdkMcpServer({
      name: DELEGATE_MCP_SERVER_NAME,
      version: '1.0.0',
      instructions: delegateServerInstructions(backends),
      tools,
      // 이 워크스페이스의 존재 이유인 도구들이므로 도구 검색 뒤로 미루지 않는다.
      alwaysLoad: true
    }),
    abortAll: () => {
      for (const abort of running.values()) abort.abort()
      running.clear()
    }
  }
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text: message }], isError: true }
}
