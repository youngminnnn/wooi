import type * as acp from '@agentclientprotocol/sdk'
import type { ChatItem } from '@shared/types'
import { mapSessionUpdate, type AcpMapped, type AcpMapperState } from '../acp/mapping'

const NOTHING: AcpMapped = { events: [], persist: [] }

/** 표준 ACP 업데이트는 공통 매퍼 하나만 통과시킨다. */
export function mapGrokSessionUpdate(
  update: acp.SessionUpdate,
  state: AcpMapperState,
  ts = Date.now()
): AcpMapped {
  return mapSessionUpdate(update, 'grok', state, ts)
}

/** Grok 고유 `x.ai/session_notification` 페이로드를 기존 대화 카드로 옮긴다. */
export function mapGrokNotification(payload: unknown, ts = Date.now()): AcpMapped {
  if (!isRecord(payload)) return NOTHING
  const update = isRecord(payload.update) ? payload.update : payload
  const kind = stringField(update, 'type', 'notificationType', 'event')

  if (kind === 'subagent_spawned' || kind === 'subagent_progress' || kind === 'subagent_finished') {
    const taskId =
      stringField(update, 'taskId', 'task_id', 'subagentId', 'subagent_id') ?? 'unknown'
    const failed = Boolean(update.failed) || update.status === 'failed'
    const item: ChatItem = {
      id: `grok:subagent:${taskId}`,
      type: 'task',
      taskId,
      name: stringField(update, 'agentType', 'agent_type', 'name') ?? 'subagent',
      description:
        stringField(update, 'description', 'prompt', 'message') ?? 'Grok subagent is working',
      status: kind === 'subagent_finished' ? (failed ? 'failed' : 'completed') : 'running',
      ...(stringField(update, 'summary', 'output')
        ? { summary: stringField(update, 'summary', 'output') }
        : {}),
      ...(numberField(update, 'totalTokens', 'total_tokens') !== undefined
        ? { totalTokens: numberField(update, 'totalTokens', 'total_tokens') }
        : {}),
      ...(numberField(update, 'toolUses', 'tool_uses') !== undefined
        ? { toolUses: numberField(update, 'toolUses', 'tool_uses') }
        : {}),
      ...(numberField(update, 'durationMs', 'duration_ms') !== undefined
        ? { durationMs: numberField(update, 'durationMs', 'duration_ms') }
        : {}),
      ts
    }
    return itemResult(item)
  }

  if (kind === 'exit_plan_mode' || kind === 'plan_approval') {
    const item: ChatItem = {
      id: `grok:plan-approval:${stringField(update, 'requestId', 'request_id') ?? ts}`,
      type: 'system',
      text:
        stringField(update, 'plan', 'planContent', 'message') ??
        'Grok is waiting for plan approval.',
      ts
    }
    return itemResult(item)
  }

  return NOTHING
}

/**
 * 이 역요청들은 권한 요청처럼 응답 전까지 턴을 막는다. piece 3 의 [[grok/manager]] 는 알림처럼
 * 흘려 버리지 말고 UI 응답 채널에 연결해야 한다.
 */
export function isBlockingGrokRequest(method: string): boolean {
  return method === 'x.ai/ask_user_question' || method === 'x.ai/exit_plan_mode'
}

function itemResult(item: ChatItem): AcpMapped {
  return { events: [{ type: 'item', item }], persist: [item] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string') return value[key]
  return undefined
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof value[key] === 'number') return value[key]
  return undefined
}
