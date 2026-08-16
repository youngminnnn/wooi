import type * as acp from '@agentclientprotocol/sdk'
import { AcpConnection } from '../acp/session'
import { permissionOutcome } from '../acp/permission'
import { detectGrok } from '../grok/executable'
import { grokModeFor } from '../grok/modes'
import { log } from '../logger'
import type { SubAgentRunDeps, SubAgentResult } from './run'

/** Grok Build 로 위임 작업을 일회성 ACP 세션에서 돌린다. */
export async function runGrokSubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  const install = await detectGrok()
  if (!install.usable) {
    return {
      text: '',
      sessionId: null,
      error: install.reason ?? 'The Grok Build CLI is not available.'
    }
  }

  let text = ''
  let sessionId: string | null = null
  const mode = grokModeFor(deps.permissionMode)
  const connection = new AcpConnection({
    launch: { command: 'grok', args: ['agent', 'stdio'], env: process.env },
    clientName: 'wooi-grok-subagent',
    requestPermission: (request) => requestPermission(deps, request),
    onUpdate: (_sessionId, update) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        text += update.content.text
        if (update.content.text.trim()) {
          deps.onActivity({ kind: 'text', text: update.content.text.trim() })
        }
      } else if (update.sessionUpdate === 'tool_call') {
        deps.onActivity({
          kind: 'tool',
          toolName: update.title,
          text: update.title
        })
      }
    }
  })

  // 중단 신호는 도는 ACP 턴에 전달한다. 세션이 열리기 전 중단된 경우에는 아래에서 프롬프트를
  // 보내지 않고, 열린 뒤라면 session/cancel 로 블로킹 요청을 깨운다.
  const cancel = (): void => {
    if (sessionId) void connection.cancel(sessionId).catch(() => undefined)
  }
  deps.abort.signal.addEventListener('abort', cancel, { once: true })

  try {
    if (deps.abort.signal.aborted) return { text: '', sessionId: null, error: null }
    const opened = await connection.newSession({ cwd: deps.cwd, _meta: mode.meta })
    sessionId = opened.sessionId
    if (deps.abort.signal.aborted) {
      await connection.cancel(sessionId)
      return { text: text.trim(), sessionId, error: null }
    }
    await connection.setMode(sessionId, mode.modeId)
    if (deps.model) {
      await connection.ext('session/set_model', {
        sessionId,
        modelId: deps.model,
        ...(deps.effort ? { _meta: { reasoningEffort: deps.effort } } : {})
      })
    }
    if (deps.abort.signal.aborted) {
      await connection.cancel(sessionId)
    } else {
      await connection.prompt(sessionId, [{ type: 'text', text: deps.prompt }])
    }
    return { text: text.trim(), sessionId, error: null }
  } catch (error) {
    // 부모 턴 중단은 실패가 아니다. 그 전까지 받은 답만 결과로 남긴다.
    if (deps.abort.signal.aborted) return { text: text.trim(), sessionId, error: null }
    log.error('subagent: grok ACP run failed', error)
    return { text: text.trim(), sessionId, error: String(error) }
  } finally {
    deps.abort.signal.removeEventListener('abort', cancel)
    connection.dispose()
  }
}

/** ACP 선택지를 Claude SDK 모양의 서브런 승인 결과로 이어 붙인다. */
async function requestPermission(
  deps: SubAgentRunDeps,
  request: acp.RequestPermissionRequest
): Promise<acp.RequestPermissionResponse> {
  const input = isRecord(request.toolCall.rawInput) ? request.toolCall.rawInput : {}
  const title = request.toolCall.title || 'Grok tool'
  const decision = deps.canUseTool
    ? await deps.canUseTool(title, input, { title, displayName: title })
    : { behavior: 'allow' as const, updatedInput: input }
  return permissionOutcome(request.options, decision.behavior === 'allow' ? 'allow' : 'reject')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
