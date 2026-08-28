import type { AgentBackendId, ChatItem } from '@shared/types'
import { clampInput, clampText } from '../claude/clamp'

/**
 * CLI 가 남긴 대화 기록을 Wooi 의 트랜스크립트 항목으로 옮긴다.
 *
 * 세션 id 만 이어받으면 에이전트는 지난 맥락을 전부 기억하는데 화면은 비어 있다. 그 어긋남을
 * 없애려면 지난 대화를 눈에도 보이게 해야 하고, 그러려면 **남의 앱 내부 형식**을 읽어야 한다.
 * 이 파일이 그 위험을 한곳에 가둔다 — 순수 변환만 하고, 모르는 줄·모양은 전부 조용히 버린다.
 * 여기서 아무것도 못 건져도 들여오기 자체는 성공해야 한다(세션은 여전히 이어진다).
 *
 * 두 형식 모두 JSONL 이고 시간순이라, 파일 순서를 그대로 화면 순서로 쓴다.
 */

/** 한 워크스페이스로 옮길 항목 수 상한. 넘으면 **최근 것부터** 남긴다. */
const MAX_ITEMS = 1000

export interface ConvertedTranscript {
  items: ChatItem[]
  /** 상한을 넘겨 버린 앞부분 항목 수. 0 이면 전부 옮겼다. */
  dropped: number
}

type Row = Record<string, unknown>

function parseLines(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Row)
      }
    } catch {
      // 잘린 줄·형식이 바뀐 줄은 그 줄만 버린다.
    }
  }
  return rows
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timeOf(row: Row, fallback: number): number {
  const parsed = Date.parse(str(row.timestamp))
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 옮겨 온 항목의 id. `import-` 접두사를 붙이는 이유는 **앞으로 들어올 항목과 절대 겹치지 않게**
 * 하기 위해서다 — 트랜스크립트는 같은 id 를 마지막 것으로 덮어쓰므로(last-wins), 겹치면 이어서
 * 하는 대화가 옛 항목을 조용히 지운다.
 */
function idFor(index: number): string {
  return `import-${index}`
}

/** 상한을 적용하고 id 를 다시 매긴다(잘라 낸 뒤에도 id 가 촘촘하도록). */
function finish(items: ChatItem[]): ConvertedTranscript {
  const dropped = Math.max(0, items.length - MAX_ITEMS)
  const kept = dropped > 0 ? items.slice(dropped) : items
  return {
    items: kept.map((item, index) => ({ ...item, id: idFor(index) })),
    dropped
  }
}

// ── Claude Code ────────────────────────────────────────────────────────────

/**
 * 내용 블록을 화면에 쓸 평문으로 편다. 문자열이면 그대로다.
 *
 * 블록 이름은 두 CLI 가 서로 다르게 부른다(`text`·`input_text`·`output_text`). 이름을 나열해
 * 맞추는 대신 **텍스트를 들고 있으면 텍스트로 본다** — 새 이름이 하나 생겼다고 대화가
 * `[output_text_v2]` 같은 자리표시자로 뭉개지지 않게.
 */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (typeof block !== 'object' || block === null) return ''
      const part = block as Row
      if (typeof part.text === 'string') return part.text
      // 이미지 등 텍스트가 아닌 결과는 자리만 남긴다 — 원본 바이트를 옮길 이유가 없다.
      if (typeof part.type === 'string') return `[${part.type}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * `~/.claude/projects/<슬러그>/<id>.jsonl` 을 옮긴다.
 *
 * 사용자·어시스턴트 줄만 본다. 나머지(`custom-title`·`queue-operation`·`file-history-snapshot`
 * …)는 CLI 의 내부 살림이라 화면에 옮길 것이 없다. 서브에이전트 줄(`isSidechain`)도 건너뛴다 —
 * Wooi 는 서브에이전트를 도구 결과 안에 접어 보여 주므로, 펼쳐서 섞으면 대화가 두 번 나온다.
 */
export function convertClaudeTranscript(text: string): ConvertedTranscript {
  const items: ChatItem[] = []
  let ts = 0
  for (const row of parseLines(text)) {
    const type = str(row.type)
    if (type !== 'user' && type !== 'assistant') continue
    if (row.isSidechain === true) continue
    ts = timeOf(row, ts)

    const message = (row.message ?? {}) as Row
    const content = message.content
    if (typeof content === 'string') {
      if (content.trim()) items.push({ id: '', type: 'user', text: clampText(content), ts })
      continue
    }
    if (!Array.isArray(content)) continue

    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as Row
      switch (str(block.type)) {
        case 'text': {
          const value = str(block.text)
          if (!value.trim()) break
          items.push({
            id: '',
            type: type === 'assistant' ? 'assistant' : 'user',
            text: clampText(value),
            ts
          })
          break
        }
        case 'thinking': {
          // 서명만 남고 본문이 비어 있는(리댁트된) 사고는 보여 줄 것이 없다.
          const value = str(block.thinking)
          if (!value.trim()) break
          items.push({ id: '', type: 'thinking', text: clampText(value), ts })
          break
        }
        case 'tool_use': {
          const toolId = str(block.id)
          if (!toolId) break
          items.push({
            id: '',
            type: 'tool_use',
            toolId,
            name: str(block.name) || 'tool',
            input: clampInput(block.input),
            ts
          })
          break
        }
        case 'tool_result': {
          const toolId = str(block.tool_use_id)
          if (!toolId) break
          items.push({
            id: '',
            type: 'tool_result',
            toolId,
            text: clampText(blockText(block.content)),
            isError: block.is_error === true,
            ts
          })
          break
        }
        default:
          break
      }
    }
  }
  return finish(items)
}

// ── Codex ──────────────────────────────────────────────────────────────────

/** function_call 의 arguments 는 JSON 문자열이다. 못 읽으면 원문을 그대로 보여 준다. */
function parseArguments(value: unknown): unknown {
  const text = str(value)
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { arguments: text }
  }
}

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 을 옮긴다.
 *
 * 한 줄기가 두 번 적힌다는 것이 이 형식의 요점이다 — 사람이 볼 텍스트는 `event_msg` 로,
 * 모델에 보낸 원본은 `response_item` 으로 각각 남는다. 그래서 **텍스트는 event_msg 에서,
 * 도구 호출은 response_item 에서** 가져온다. 둘 다에서 텍스트를 받으면 같은 말이 두 번 나온다.
 *
 * event_msg 가 아예 없는 옛 기록(또는 형식이 바뀐 경우)에는 `response_item` 의 message 로
 * 폴백한다. 그때는 모델에게만 가는 developer 지시를 걸러야 대화가 사용자의 것으로 보인다.
 */
export function convertCodexTranscript(text: string): ConvertedTranscript {
  const rows = parseLines(text)
  const hasEvents = rows.some((row) => {
    if (str(row.type) !== 'event_msg') return false
    const payload = (row.payload ?? {}) as Row
    const kind = str(payload.type)
    return kind === 'user_message' || kind === 'agent_message'
  })

  const items: ChatItem[] = []
  let ts = 0
  for (const row of rows) {
    const kind = str(row.type)
    const payload = (row.payload ?? {}) as Row
    ts = timeOf(row, ts)

    if (kind === 'event_msg' && hasEvents) {
      const message = clampText(str(payload.message))
      switch (str(payload.type)) {
        case 'user_message':
          if (message.trim()) items.push({ id: '', type: 'user', text: message, ts })
          break
        case 'agent_message':
          if (message.trim()) items.push({ id: '', type: 'assistant', text: message, ts })
          break
        case 'agent_reasoning': {
          const reasoning = clampText(str(payload.text) || message)
          if (reasoning.trim()) items.push({ id: '', type: 'thinking', text: reasoning, ts })
          break
        }
        default:
          break
      }
      continue
    }

    if (kind !== 'response_item') continue
    const callId = str(payload.call_id)
    switch (str(payload.type)) {
      case 'message': {
        if (hasEvents) break // 텍스트는 event_msg 가 이미 실어 왔다
        const role = str(payload.role)
        if (role !== 'user' && role !== 'assistant') break
        const value = clampText(blockText(payload.content))
        if (value.trim()) items.push({ id: '', type: role, text: value, ts })
        break
      }
      case 'function_call':
        if (!callId) break
        items.push({
          id: '',
          type: 'tool_use',
          toolId: callId,
          name: str(payload.name) || 'tool',
          input: clampInput(parseArguments(payload.arguments)),
          ts
        })
        break
      case 'custom_tool_call':
        if (!callId) break
        items.push({
          id: '',
          type: 'tool_use',
          toolId: callId,
          name: str(payload.name) || 'tool',
          input: clampInput({ input: str(payload.input) }),
          ts
        })
        break
      case 'local_shell_call':
        if (!callId) break
        items.push({
          id: '',
          type: 'tool_use',
          toolId: callId,
          name: 'shell',
          input: clampInput(payload.action),
          ts
        })
        break
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        if (!callId) break
        const output = payload.output
        items.push({
          id: '',
          type: 'tool_result',
          toolId: callId,
          text: clampText(typeof output === 'string' ? output : blockText(output)),
          isError: false,
          ts
        })
        break
      }
      default:
        break
    }
  }
  return finish(items)
}

/** 백엔드에 맞는 변환기. 모르는 백엔드면 아무것도 옮기지 않는다. */
export function convertTranscript(backend: AgentBackendId, text: string): ConvertedTranscript {
  if (backend === 'claude') return convertClaudeTranscript(text)
  if (backend === 'codex') return convertCodexTranscript(text)
  return { items: [], dropped: 0 }
}
