import type { ChatEvent, ChatItem } from '@shared/types'
import { unknownItemId } from '@shared/types'
import { clampInput, clampText } from '../claude/clamp'
import type { AntigravityEvent } from './protocol'
import {
  isAntigravityInitEvent,
  isAntigravityResultEvent,
  isAntigravityStepUpdateEvent
} from './protocol'

/**
 * `agy` stream-json 이벤트를 Wooi 대화 값으로 바꾸는 순수 계층.
 *
 * 사용자 설치 CLI 는 Wooi 가 버전을 고정하지 못한다. 새 이벤트가 와도 턴 전체를 중단하지 않도록
 * 모르는 것은 throw 하지 않고 unknown 카드와 로깅 훅으로 흘려보낸다.
 */

export interface Mapped {
  events: ChatEvent[]
  persist: ChatItem[]
}

const NOTHING: Mapped = { events: [], persist: [] }

export interface MapperState {
  /**
   * 이 실행(프로세스) 하나를 가리키는 접두사. **아이템 id 충돌을 막는 유일한 장치다.**
   *
   * 이 백엔드는 턴마다 프로세스를 새로 띄우고, `step_index` 는 그 프로세스 안에서 0 부터 다시
   * 센다. 그런데 Wooi 의 아이템은 id 기준 upsert 라(ChatEvent 의 `item` 주석), 접두사가 없으면
   * 2번째 턴의 step 0 이 1번째 턴의 step 0 을 **덮어써서 대화가 지워진다**. `result` 도 실행마다
   * 한 장씩 나오므로 같은 문제를 갖는다. 실행마다 다른 값을 넣는 것이 계약이다.
   */
  runId: string
  /** step_index → 지금까지 받은 assistant 조각. DONE 때 완성 아이템을 저장하는 데 쓴다. */
  assistantText: Map<number, string>
  /** ACTIVE 에만 있던 도구 이름과 인자를 DONE 때 다시 실어 영속하기 위한 스냅샷. */
  tools: Map<number, { name: string; input: unknown }>
  /** 로컬에 먼저 그린 사용자 입력과 CLI echo 를 한 번씩 짝짓기 위한 서명. */
  pendingUserEchoes: string[]
}

/** @param runId 이 프로세스 실행을 가리키는 값. 실행마다 반드시 달라야 한다(MapperState.runId). */
export function createMapperState(runId: string): MapperState {
  return { runId, assistantText: new Map(), tools: new Map(), pendingUserEchoes: [] }
}

export function rememberOptimisticUser(state: MapperState, text: string): void {
  state.pendingUserEchoes.push(userSignature(text))
}

export function mapEvent(
  event: AntigravityEvent,
  state: MapperState,
  onUnknown?: (what: string) => void
): Mapped {
  const ts = Date.now()

  if (!event || typeof event !== 'object')
    return unknown('event with invalid payload', ts, onUnknown)

  if (isAntigravityInitEvent(event)) {
    const sessionId = stringValue(event.conversation_id)
    if (!sessionId) return NOTHING
    const model = stringValue(event.init?.model)
    return {
      events: [{ type: 'session', sessionId, ...(model ? { model } : {}) }],
      persist: []
    }
  }

  if (isAntigravityStepUpdateEvent(event)) {
    const step = event.step_update
    if (!step || typeof step !== 'object') return NOTHING
    const index = numberValue(step.step_index)
    const stepType = stringValue(step.step_type)
    if (index === undefined || !stepType) return NOTHING

    // usage 에는 토큰 수만 있고 context-window 크기는 없다. 최대치를 지어내면 입력창 사용량 미터가
    // 거짓말하게 된다. ANTIGRAVITY_META 가 같은 이유로 `context` 명령을 노출하지 않으므로 생략한다.
    // subagent_info 필드는 존재하지만 스키마가 문서화되지 않았다. 추측한 시작/종료 필드를 REPLACE
    // 목록에 연결하면 종료를 놓쳐 스피너가 영구히 남을 수 있어 실제 CLI 모양을 관측할 때까지 미룬다.
    switch (stepType) {
      case 'agent_response':
        return mapAssistant(step, index, state, ts)
      case 'tool':
        return mapTool(step, index, state, ts)
      case 'user_input':
        return mapUser(step, index, state, ts)
      case 'checkpoint':
        // agy 내부 대화 체크포인트이며 Wooi 대응물이 없다. 해석 실패가 아니라 의도적으로 무시한
        // 것이므로, 해석하지 못한 데이터에만 쓰는 unknown 카드로 만들지 않는다.
        return NOTHING
      default:
        return unknown(`step type "${stepType}"`, ts, onUnknown)
    }
  }

  if (isAntigravityResultEvent(event)) {
    const result = event.result
    if (!result || typeof result !== 'object') return NOTHING
    const status = stringValue(result.status)
    if (!status) return NOTHING
    // result.error 는 실패의 유일한 설명일 수 있다(로그인 전 실행이 그렇다 — protocol.ts 참고).
    // 오류 카드를 따로 한 장 세워 이유를 보여 주고, result 카드는 턴의 마무리로 남긴다.
    const failure = stringValue(result.error)
    const item: ChatItem = {
      id: itemId(state, 'result'),
      type: 'result',
      subtype: status.toLowerCase(),
      isError: status === 'ERROR' || status === 'INVALID',
      durationMs: (numberValue(result.duration_seconds) ?? 0) * 1000,
      numTurns: numberValue(result.num_turns) ?? 0,
      // agy 는 비용을 보고하지 않는다. 0 을 넣지 않으면 UI 가 비용 필드를 올바르게 숨긴다.
      ts
    }
    if (!failure) return itemResult(item)
    const error: ChatItem = {
      id: itemId(state, 'result:error'),
      type: 'error',
      text: clampText(failure),
      ts
    }
    return {
      events: [
        { type: 'item', item: error },
        { type: 'item', item }
      ],
      persist: [error, item]
    }
  }

  return unknown(`event "${stringValue(event.event) ?? 'unknown'}"`, ts, onUnknown)
}

type Step = Record<string, unknown> & {
  state?: unknown
  text_delta?: unknown
  tool_name?: unknown
  tool_info?: unknown
}

function mapAssistant(step: Step, index: number, state: MapperState, ts: number): Mapped {
  const text = stringValue(step.text_delta) ?? ''
  const accumulated = (state.assistantText.get(index) ?? '') + text
  if (text) state.assistantText.set(index, accumulated)

  const events: ChatEvent[] = text
    ? [{ type: 'delta', id: stepItemId(state, index), itemType: 'assistant', text }]
    : []
  if (step.state !== 'DONE') return { events, persist: [] }

  state.assistantText.delete(index)
  if (!accumulated) return { events, persist: [] }
  const item: ChatItem = { id: stepItemId(state, index), type: 'assistant', text: accumulated, ts }
  return { events, persist: [item] }
}

function mapTool(step: Step, index: number, state: MapperState, ts: number): Mapped {
  const info = objectValue(step.tool_info)
  const remembered = state.tools.get(index)
  const name = stringValue(info?.name) ?? stringValue(step.tool_name) ?? remembered?.name ?? 'Tool'
  const input = info?.parameters ?? remembered?.input ?? {}
  if (step.state === 'ACTIVE') state.tools.set(index, { name, input })

  if (isShellTool(name)) return mapShell(step, info, index, input, state, ts)

  const id = stepItemId(state, index)
  const use: ChatItem = {
    id,
    type: 'tool_use',
    toolId: id,
    name,
    input: clampInput(input),
    ts
  }
  if (step.state !== 'DONE') return { events: [{ type: 'item', item: use }], persist: [] }

  state.tools.delete(index)
  const error = objectValue(info?.error)
  const isError = Boolean(error)
  const text = isError
    ? (stringValue(error?.message) ?? safeString(error) ?? 'Failed.')
    : (stringValue(info?.output) ?? 'Done.')
  const result: ChatItem = {
    id: `${id}:result`,
    type: 'tool_result',
    toolId: id,
    text: clampText(text),
    isError,
    ts
  }
  const events: ChatEvent[] = [
    { type: 'item', item: use },
    { type: 'item', item: result }
  ]
  if (isFileWritingTool(name)) {
    /**
     * agy 에는 Codex `turn/diff/updated` 대응물이 없고 의미 있는 diff 는 쓰기 전에 잡아야 한다.
     * Changes 패널은 git 을 정본으로 삼으므로 추측 diff 대신 "지금 git 을 다시 읽어라"라는 정확한
     * workingTreeChanged 신호만 보낸다.
     */
    events.push({ type: 'workingTreeChanged' })
  }
  return { events, persist: [use, result] }
}

function mapShell(
  step: Step,
  info: Record<string, unknown> | undefined,
  index: number,
  input: unknown,
  state: MapperState,
  ts: number
): Mapped {
  const parameters = objectValue(input)
  /**
   * 실측 문서 예시는 run_command + 대문자 `CommandLine` 하나뿐이다. `command`·`cmd`는 다른 버전의
   * 가능성에 대비한 방어적 후보일 뿐 검증된 스키마로 읽으면 안 된다.
   */
  const command =
    stringValue(parameters?.CommandLine) ??
    stringValue(parameters?.command) ??
    stringValue(parameters?.cmd) ??
    ''
  const done = step.state === 'DONE'
  const error = objectValue(info?.error)
  const output = error
    ? (stringValue(error.message) ?? safeString(error) ?? '')
    : (stringValue(info?.output) ?? '')
  const item: ChatItem = {
    id: stepItemId(state, index),
    type: 'bash',
    agent: true,
    command,
    output: clampText(output),
    // 문서화된 출력에 종료 코드가 없으므로 성공처럼 보이는 값을 만들지 않는다.
    exitCode: null,
    running: !done,
    ts
  }
  if (done) state.tools.delete(index)
  return { events: [{ type: 'item', item }], persist: done ? [item] : [] }
}

function mapUser(step: Step, index: number, state: MapperState, ts: number): Mapped {
  const text = stringValue(step.text_delta)
  if (!text || step.state !== 'DONE') return NOTHING
  const signature = userSignature(text)
  const echoIndex = state.pendingUserEchoes.indexOf(signature)
  if (echoIndex >= 0) {
    state.pendingUserEchoes.splice(echoIndex, 1)
    return NOTHING
  }
  const item: ChatItem = { id: stepItemId(state, index), type: 'user', text, ts }
  return itemResult(item)
}

/** 프로세스 stderr 를 종료 결과와 함께 사용자에게 보일 확정 아이템으로 바꾼다. */
export function mapExitStderr(
  stderr: string,
  exitCode: number | null,
  aborted: boolean,
  ts = Date.now()
): Mapped {
  if (aborted) return NOTHING
  const text = stderr.trim()
  if (!text) return NOTHING

  if (exitCode !== 0) {
    const item: ChatItem = {
      id: `antigravity:exit-error:${ts}`,
      type: 'error',
      text: clampText(text),
      ts
    }
    return itemResult(item)
  }

  const autoDenied = /auto-denied|permissions\.allow/i.test(text)
  const guidance = autoDenied
    ? 'A tool was blocked by Antigravity permissions. Switch this workspace’s permission mode to Full access, then try again.\n\n'
    : ''
  const item: ChatItem = {
    id: `antigravity:stderr:${ts}`,
    type: 'system',
    text: clampText(guidance + text),
    ts
  }
  return itemResult(item)
}

function unknown(what: string, ts: number, onUnknown?: (what: string) => void): Mapped {
  onUnknown?.(what)
  const item: ChatItem = {
    id: unknownItemId('antigravity', what),
    type: 'unknown',
    backend: 'antigravity',
    what,
    ts
  }
  return itemResult(item)
}

function itemResult(item: ChatItem): Mapped {
  return { events: [{ type: 'item', item }], persist: [item] }
}

function itemId(state: MapperState, kind: string): string {
  return `antigravity:${state.runId}:${kind}`
}

function stepItemId(state: MapperState, index: number): string {
  return itemId(state, `step:${index}`)
}

function userSignature(text: string): string {
  return JSON.stringify([text, []])
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeString(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function isShellTool(name: string): boolean {
  // run_command 만 문서 예시로 확인됐다. 나머지는 버전 차이에 대비한 미검증 방어 목록이다.
  return ['run_command', 'shell', 'bash', 'execute_command'].includes(name.toLowerCase())
}

function isFileWritingTool(name: string): boolean {
  // agy 가 이름 목록을 문서화하지 않아 모두 미검증 후보다. 오탐은 git 재조회 한 번으로만 끝난다.
  return [
    'write_file',
    'write_to_file',
    'edit_file',
    'create_file',
    'delete_file',
    'apply_patch',
    'multi_edit',
    'replace_file_content',
    'multi_replace_file_content',
    'notebook_edit'
  ].includes(name.toLowerCase())
}
