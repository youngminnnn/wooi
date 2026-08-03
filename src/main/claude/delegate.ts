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
import { log } from '../logger'

/**
 * 위임 도구(`mcp__wooi_agents__delegate`) — 메인 에이전트가 **다른 종류의** 에이전트에게 작업 하나를
 * 넘길 수 있게 하는 in-process MCP 서버.
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
 * 같은 백엔드 작업에는 네이티브 서브에이전트가 여전히 더 낫다(맥락 공유·비용·속도 전부). 이
 * 도구는 그것과 경쟁하는 것이 아니라 **다른 제품에게 넘길 때만** 쓰는 보완재이고, 설명에 그
 * 경계를 적어 둔다. 그래서 위임이 잘 안 걸려도 손해가 없다 — 모델은 그냥 Task 를 쓴다.
 */

/** 위임 도구가 부모 세션에서 받아야 하는 것들. */
export interface DelegateDeps {
  /** 부모 워크스페이스의 worktree. 위임된 실행도 같은 체크아웃에서 돈다. */
  cwd: string
  repoPath: string | null
  /**
   * 위임할 수 있는 백엔드. 도구 스키마의 enum 이 되므로, 여기 없는 값은 모델이 아예 고를 수 없다.
   * 비어 있으면 서버를 만들지 않는다(호출부가 판단).
   */
  subBackends: AgentBackendId[]
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

/**
 * 위임 도구의 MCP 서버 이름. 도구는 모델에게 `mcp__wooi_agents__delegate` 로 보인다.
 *
 * Wooi 도구 서버(`wooi`)와 **따로** 두는 이유는 실행 위치와 수명이 다르기 때문이다: 그쪽 도구는
 * 메인으로 올려 "즉시 반환" 하는 규약이지만(claude/host.ts callMain), 위임은 agent-host 안에서
 * 부모 세션의 canUseTool 을 직접 쓰며 분 단위로 블로킹한다. 정의를 합치는 것과 실행을 합치는
 * 것은 다른 문제이고, 여기서는 아직 둘 다 하지 않았다.
 */
export const DELEGATE_MCP_SERVER_NAME = 'wooi_agents'

export function createDelegateServer(deps: DelegateDeps): DelegateServer {
  /** 진행 중인 위임 실행. 부모 턴이 끊길 때 함께 끊기 위해 들고 있는다. */
  const running = new Map<string, AbortController>()

  const backends = deps.subBackends
  // z.enum 은 비지 않은 튜플을 요구한다. 호출부가 빈 목록이면 서버를 만들지 않지만,
  // 타입 수준에서도 못 박아 두는 편이 안전하다.
  const backendEnum = z.enum(backends as [AgentBackendId, ...AgentBackendId[]])

  const delegateTool = tool(
    'delegate',
    describeTool(backends),
    {
      backend: backendEnum.describe('Which agent product should do the work.'),
      description: z
        .string()
        .describe('A 3-6 word label for this task, shown while it runs (e.g. "Audit auth flow").'),
      prompt: z
        .string()
        .describe(
          'The complete task brief. The delegated agent starts with a blank context and cannot ' +
            'see this conversation, so restate every fact it needs: files, constraints, and what ' +
            'to return. It reports back once, in text — it cannot ask you follow-up questions.'
        )
    },
    async (args) => {
      const backend = args.backend as AgentBackendId
      if (!backends.includes(backend)) {
        return errorResult(`This workspace cannot delegate to ${AGENT_BACKEND_LABELS[backend]}.`)
      }

      const taskId = randomUUID()
      const abort = new AbortController()
      running.set(taskId, abort)

      const agent: RunningAgent = {
        taskId,
        backend,
        agentType: AGENT_BACKEND_LABELS[backend],
        description: args.description,
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
          prompt: args.prompt,
          abort,
          onActivity: (activity) => {
            if (activity.kind === 'tool') {
              agent.toolUses = (agent.toolUses ?? 0) + 1
              agent.lastToolName = activity.toolName ?? activity.text
            }
            deps.upsertAgent(agent)
          },
          // Codex 경로는 이 콜백을 무시한다(`codex exec` 가 비대화형이라 승인 채널이 없다).
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
  )

  return {
    config: createSdkMcpServer({
      name: DELEGATE_MCP_SERVER_NAME,
      version: '1.0.0',
      tools: [delegateTool],
      // 도구가 하나뿐이고 이 워크스페이스의 존재 이유이므로, 도구 검색 뒤로 미루지 않는다.
      alwaysLoad: true
    }),
    abortAll: () => {
      for (const abort of running.values()) abort.abort()
      running.clear()
    }
  }
}

/**
 * 도구 설명 — 위임이 실제로 걸리느냐가 대부분 여기에 달려 있다.
 *
 * 세 가지를 분명히 한다: (1) 이것은 **다른 제품**에게 넘기는 것이고, (2) 같은 백엔드 병렬 작업은
 * 여전히 네이티브 서브에이전트가 맞으며, (3) 넘긴 뒤에는 되물을 수 없다.
 */
function describeTool(backends: AgentBackendId[]): string {
  const names = backends.map((b) => AGENT_BACKEND_LABELS[b]).join(' or ')
  return (
    `Hand one self-contained task to ${names} — a different coding agent — and wait for its answer. ` +
    'Use this when the user asked for that agent by name, when a second opinion from a different ' +
    'model family is worth having, or when that agent is genuinely better suited to the task. ' +
    'For ordinary parallel work in your own model family, use your built-in subagents instead — ' +
    'they share your context and are cheaper. ' +
    'The delegated agent runs in this same worktree with your permission mode, starts from an ' +
    'empty context, and reports back exactly once as text; it cannot ask you anything mid-run.'
  )
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
