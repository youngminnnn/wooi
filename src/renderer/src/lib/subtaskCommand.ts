import type { AgentBackendId } from '@shared/types'
import { delegateWooiCommands, expandWooiCommand } from '@shared/wooiCommands'

/** `/subtask <task>` 의 인자. 명령이 아니면 null. 인자가 비어 있으면 빈 문자열이 든 객체다. */
export function parseSubtaskCommand(text: string): { task: string } | null {
  const m = /^\/subtask(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { task: (m[1] ?? '').trim() } : null
}

/**
 * solo 워크스페이스에서 /subtask 를 막는 이유. 위임 도구는 팀 모드에만 있으므로 Solo 에서 프롬프트를
 * 확장해 보내면 에이전트가 존재하지 않는 도구를 찾다가 실패한다. 쓸 수 있으면 null.
 */
export function subtaskUnavailableReason(opts: {
  multiAgent: boolean
  canDelegate: boolean
}): string | null {
  if (!opts.canDelegate) {
    return 'This agent cannot run subagents, so /subtask is not available here.'
  }
  if (!opts.multiAgent) {
    return 'This workspace is Solo. Turn it into an agent team with /wooi:team, then /subtask delegates the work to a subagent.'
  }
  return null
}

/** 이 백엔드의 위임 커맨드(`/wooi:claude`·`/wooi:codex`)와 똑같은 프롬프트. */
export function subtaskPrompt(backend: AgentBackendId, task: string): string {
  return expandWooiCommand(delegateWooiCommands([backend])[0], task)
}
