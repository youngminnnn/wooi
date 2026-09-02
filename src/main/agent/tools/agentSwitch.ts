import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'
import type { AgentToolHandler } from './registry'
import { callerWorkspace } from './target'
import { ensureToolApproved } from './permission'

/** 현재 턴을 안전하게 마친 뒤 이 워크스페이스의 메인 에이전트를 교체한다. */
export const switchWorkspaceAgent: AgentToolHandler = async (deps, workspaceId, args) => {
  const workspace = callerWorkspace(workspaceId)
  const target = args.agentBackend as AgentBackendId
  if (workspace.agentBackend === target) {
    return {
      changed: false,
      agentBackend: target,
      note: `This workspace already runs on ${AGENT_BACKEND_LABELS[target] ?? target}.`
    }
  }

  const backends = await deps.listBackends()
  const backend = backends.find((item) => item.id === target)
  if (!backend) throw new Error(`Unknown agent backend: ${String(target)}`)
  if (!backend.available) {
    throw new Error(backend.unavailableReason ?? `${backend.label} is not available.`)
  }

  // 이 도구만은 fullAccess/auto 에서도 반드시 묻는다. 전송 계층에서 물으면 Claude/Codex의
  // 승인 정책이 갈리므로 핸들러가 한 번만 소유한다.
  await ensureToolApproved(workspace, 'switch_workspace_agent', args, { always: true })

  deps.sessions.switchAgentAfterTurn(workspaceId, target)
  return {
    changed: true,
    from: workspace.agentBackend,
    to: target,
    next:
      `End this turn now. After your tool result returns, Wooi will close this session and open ` +
      `${backend.label} automatically with a compact workspace checkpoint. Do not ask the user ` +
      'to reply or repeat the task.'
  }
}
