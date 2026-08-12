import { randomUUID } from 'node:crypto'
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendId,
  type RunningAgent,
  type Workspace
} from '@shared/types'
import { getStore } from '../../store'
import { log } from '../../logger'
import { runSubAgent } from '../../subagent/run'
import { agentDefaultsFor, delegateBackendsFor } from '../multiAgent'
import { askSubAgentPermission } from './permission'
import type { AgentToolDeps } from './registry'

/**
 * 위임 서브에이전트 도구의 실행부 — 다른 종류의 에이전트를 서브에이전트로 띄우고 결과를 기다린다.
 *
 * 다른 Wooi 도구와 같은 자리에서 돈다([[agent/tools/registry]]). 전송 계층(Claude 의 인프로세스
 * MCP 서버 · Codex 의 stdio shim)은 이름과 인자만 나르고, 실행은 메인이 하나로 소유한다.
 *
 * 메인에서 도는 것이 오히려 유리하다: 사이드바 갱신도 중단도 메인이 소유한 것들이라, 호스트를
 * 거치지 않고 직접 다룰 수 있다.
 *
 * ## 오래 걸리는 도구
 *
 * 이 도구는 분 단위로 블로킹한다. 소켓 계약은 이를 허용한다 — 타임아웃이 없고, 이미 사용자
 * 승인 카드를 기다리며 같은 시간만큼 붙잡는다([[agent/tools/socket]]).
 */

/** 진행 중인 위임 실행. 워크스페이스가 중단·정리될 때 함께 끊는다. */
const running = new Map<string, { workspaceId: string; abort: AbortController }>()

/** 워크스페이스별 실행 중 목록. 사이드바가 보는 `agents` 이벤트의 출처다. */
const agents = new Map<string, Map<string, RunningAgent>>()

/**
 * 이 워크스페이스의 위임 실행을 전부 끊는다.
 *
 * 서브런은 세션이 아니라 메인에서 도므로 세션 정리로는 끊기지 않는다 — 여기서 안 끊으면
 * 사용자가 멈췄는데도 위임받은 에이전트가 계속 파일을 고친다.
 */
export function abortSubAgents(workspaceId: string): void {
  for (const [taskId, entry] of running) {
    if (entry.workspaceId !== workspaceId) continue
    entry.abort.abort()
    running.delete(taskId)
  }
}

/** 앱 종료·백엔드 정리 경로. */
export function abortAllSubAgents(): void {
  for (const entry of running.values()) entry.abort.abort()
  running.clear()
  agents.clear()
}

function emitAgents(deps: AgentToolDeps, workspaceId: string): void {
  const list = [...(agents.get(workspaceId)?.values() ?? [])]
  deps.emitChatEvent(workspaceId, { type: 'agents', agents: list })
}

function upsertAgent(deps: AgentToolDeps, workspaceId: string, agent: RunningAgent): void {
  let byWorkspace = agents.get(workspaceId)
  if (!byWorkspace) {
    byWorkspace = new Map()
    agents.set(workspaceId, byWorkspace)
  }
  byWorkspace.set(agent.taskId, { ...agent })
  emitAgents(deps, workspaceId)
}

/**
 * 도구 1건. 백엔드는 **이름에 박혀 있으므로** 인자가 아니라 등록 시점에 정해진다 —
 * 모델이 고를 수 있는 값이 아니어서 잘못된 백엔드가 올 수 없다.
 */
export function runDelegateTool(backend: AgentBackendId) {
  return async (
    deps: AgentToolDeps,
    workspaceId: string,
    args: Record<string, unknown>
  ): Promise<unknown> => {
    const settings = getStore().getState().settings
    const ws = getStore()
      .getState()
      .workspaces.find((w) => w.id === workspaceId)
    if (!ws) throw new Error(`Unknown Wooi workspace: ${workspaceId}`)

    // 요청마다 다시 확인한다 — 도구 정의는 세션을 열 때 정해지지만, 그 사이 사용자가 멀티
    // 에이전트 모드를 껐을 수 있다.
    if (!delegateBackendsFor(ws).includes(backend)) {
      throw new Error(
        `This workspace is not set up to run ${AGENT_BACKEND_LABELS[backend]} subagents. ` +
          // 켜는 길을 함께 적는다 — 이 실패를 보는 모델은 위임하려던 참이고, 그 길이 있다는
          // 것을 모르면 사용자에게 "할 수 없다" 고 답하고 끝낸다(Codex 경로는 도구가 늘 보이므로
          // 모드가 꺼진 채로 여기까지 온다).
          'If the user asked for the work to be split across agents, call ' +
          '`switch_to_agent_team` first.'
      )
    }

    const description = String(args.description ?? 'Delegated task')
    const prompt = String(args.prompt ?? '')
    if (!prompt.trim()) throw new Error('The subagent needs a prompt describing its task.')

    const taskId = randomUUID()
    const abort = new AbortController()
    running.set(taskId, { workspaceId, abort })

    const agent: RunningAgent = {
      taskId,
      backend,
      agentType: AGENT_BACKEND_LABELS[backend],
      description,
      startedAt: Date.now(),
      toolUses: 0
    }
    upsertAgent(deps, workspaceId, agent)

    const { model, effort } = agentDefaultsFor(settings)[backend] ?? { model: null, effort: null }
    try {
      const result = await runSubAgent({
        backend,
        cwd: ws.worktreePath,
        repoPath: repoPathOf(ws),
        model,
        effort,
        // 위임된 실행이 부모보다 넓은 권한을 갖는 일은 없어야 한다.
        permissionMode: ws.permissionMode,
        prompt,
        abort,
        onActivity: (activity) => {
          if (activity.kind === 'tool') {
            agent.toolUses = (agent.toolUses ?? 0) + 1
            agent.lastToolName = activity.toolName ?? activity.text
          }
          upsertAgent(deps, workspaceId, agent)
        },
        // Codex 서브런은 이 콜백을 쓰지 않는다 — `codex exec` 가 비대화형이라 승인 채널이 없고,
        // 그 경로에서는 샌드박스가 유일한 방어선이다.
        canUseTool: (toolName, input) => askSubAgentPermission(ws, backend, toolName, input)
      })

      if (result.error && !result.text) throw new Error(result.error)
      // 아무 말도 없이 끝나는 경우가 있다(중단되었거나 도구만 돌리고 끝난 실행). 빈 문자열을
      // 그대로 돌려주면 모델이 성공으로 오해하므로 사실대로 적는다.
      return {
        text: result.text || `${AGENT_BACKEND_LABELS[backend]} finished without returning any text.`
      }
    } finally {
      running.delete(taskId)
      const byWorkspace = agents.get(workspaceId)
      if (byWorkspace?.delete(taskId)) emitAgents(deps, workspaceId)
    }
  }
}

function repoPathOf(ws: Workspace): string | null {
  return (
    getStore()
      .getState()
      .repos.find((r) => r.id === ws.repoId)?.path ?? null
  )
}

/** 이 워크스페이스에서 등록해야 할 위임 도구 이름들(카탈로그와 짝을 맞추기 위한 노출). */
export function delegateToolBackends(ws: Workspace): AgentBackendId[] {
  return delegateBackendsFor(ws)
}

/** 진단용 — 지금 도는 위임 실행 수. */
export function runningSubAgents(): number {
  return running.size
}

export function logSubAgentError(err: unknown): void {
  log.error('subagent tool: run failed', err)
}
