import { antigravityArgs } from '../antigravity/args'
import { execAntigravity } from '../antigravity/exec'
import { detectAntigravity } from '../antigravity/executable'
import { turnArgsFor } from '../antigravity/modes'
import {
  isAntigravityInitEvent,
  isAntigravityResultEvent,
  isAntigravityStepUpdateEvent
} from '../antigravity/protocol'
import { createAntigravityStream } from '../antigravity/stream'
import type { SubAgentRunDeps, SubAgentResult } from './run'

/**
 * Antigravity 로 위임 작업을 돌린다.
 *
 * headless `agy` 는 승인 요청 채널도 샌드박스도 없다. 부모가 default 모드면 `accept-edits` 로
 * worktree 편집은 허용하지만 셸 명령은 전부 자동 거절되고, fullAccess 면
 * `--dangerously-skip-permissions` 로 아무 격리 없이 실행된다. 그 사이 단계는 CLI 가 제공하지
 * 않으므로 이 비대칭을 위임 도구 설명에도 그대로 밝힌다.
 */
export async function runAntigravitySubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  const install = await detectAntigravity()
  if (!install.usable || !install.path) {
    return {
      text: '',
      sessionId: null,
      error: install.reason ?? 'The Antigravity CLI is not available.'
    }
  }

  const args = antigravityArgs({
    prompt: deps.prompt,
    // 서브런은 이어 붙이지 않는 일회성 프로세스이므로 이전 대화 ID가 항상 없다.
    conversationId: null,
    model: deps.model,
    effort: deps.effort,
    modeArgs: turnArgsFor(deps.permissionMode)
  })

  let text = ''
  let resultResponse = ''
  let sessionId: string | null = null
  const reportedTools = new Set<number>()
  const reader = createAntigravityStream((event) => {
    if (isAntigravityInitEvent(event)) {
      sessionId = event.conversation_id || null
      return
    }
    if (isAntigravityResultEvent(event)) {
      resultResponse = event.result.response ?? ''
      return
    }
    if (!isAntigravityStepUpdateEvent(event)) return

    const step = event.step_update
    if (step.step_type === 'agent_response' && step.text_delta) {
      text += step.text_delta
      deps.onActivity({ kind: 'text', text: step.text_delta })
      return
    }
    if (step.step_type === 'tool' && !reportedTools.has(step.step_index)) {
      reportedTools.add(step.step_index)
      const toolName = step.tool_info?.name ?? step.tool_name ?? 'Tool'
      deps.onActivity({ kind: 'tool', text: toolName, toolName })
    }
  })

  const outcome = await execAntigravity(
    install.path,
    args,
    { cwd: deps.cwd, abort: deps.abort },
    reader
  )
  const answer = (text || resultResponse).trim()

  // 중단은 부모 턴이 인터럽트된 결과이므로 실패로 바꾸지 않고 모은 텍스트를 보존한다.
  if (outcome.aborted) return { text: answer, sessionId, error: null }
  if (answer) return { text: answer, sessionId, error: null }

  // headless 권한 거절은 성공 종료하면서 stderr 에만 남으므로 종료 코드와 무관하게 포함한다.
  const stderr = outcome.stderr.trim()
  return {
    text: '',
    sessionId,
    error:
      [outcome.error, stderr]
        .filter((part, index, all) => part && all.indexOf(part) === index)
        .join('\n') || 'Antigravity finished without returning any text.'
  }
}
