/**
 * 사용자 설치 CLI 는 Wooi 가 버전을 고정하지 못하므로 새 이벤트와 새 step_type 이 먼저 들어올 수
 * 있다. codex 매핑의 "모르는 것은 조용히 무시한다" 원칙처럼, 알 수 없는 값도 데이터로 흘려보내
 * 소비자가 default 분기에서 무시할 수 있게 한다.
 */

export interface AntigravityUsage {
  input_tokens: number
  output_tokens: number
  thinking_tokens: number
  cache_read_tokens: number
  total_tokens: number
}

export interface AntigravityInitEvent {
  event: 'init'
  init: {
    cwd: string
    tools: string[]
    permission_mode: string
    model?: string
    agent?: string
    json_schema?: object
  }
  conversation_id: string
}

export type AntigravityStepType =
  'user_input' | 'agent_response' | 'tool' | 'checkpoint' | (string & {})

export interface AntigravityStepUpdateEvent {
  event: 'step_update'
  step_update: {
    conversation_id: string
    step_index: number
    state: 'ACTIVE' | 'DONE'
    step_type: AntigravityStepType
    tool_name?: string
    text_delta?: string
    duration_seconds?: number
    usage?: AntigravityUsage
    tool_info?: {
      name: string
      parameters?: unknown
      output?: string
      error?: { type: string; message: string }
    }
    subagent_info?: object
  }
}

export interface AntigravityResultEvent {
  event: 'result'
  result: {
    conversation_id: string
    status: 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'INVALID' | 'WAITING' | 'RUNNING'
    response: string
    duration_seconds: number
    num_turns: number
    structured_output?: object
    json_schema?: object
    usage?: AntigravityUsage
  }
}

export interface AntigravityUnknownEvent {
  event: string
  [key: string]: unknown
}

export type AntigravityEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | AntigravityUnknownEvent

export function isAntigravityInitEvent(event: AntigravityEvent): event is AntigravityInitEvent {
  return event.event === 'init' && 'init' in event
}

export function isAntigravityStepUpdateEvent(
  event: AntigravityEvent
): event is AntigravityStepUpdateEvent {
  return event.event === 'step_update' && 'step_update' in event
}

export function isAntigravityResultEvent(event: AntigravityEvent): event is AntigravityResultEvent {
  return event.event === 'result' && 'result' in event
}
