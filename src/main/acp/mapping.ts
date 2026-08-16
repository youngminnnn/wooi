import type * as acp from '@agentclientprotocol/sdk'
import type { AgentBackendId, ChatEvent, ChatItem, SlashCommandInfo } from '@shared/types'
import { unknownItemId } from '@shared/types'

/** ACP 계획 스냅샷을 기존 체크리스트 렌더러로 보내는 가상 도구 이름. */
export const ACP_PLAN_SNAPSHOT_TOOL = 'TaskSnapshot'

export interface AcpMapped {
  events: ChatEvent[]
  persist: ChatItem[]
  /** 입력창 자동완성 목록을 교체하는 제어 업데이트. */
  commands?: SlashCommandInfo[]
  /** 세션이 실제로 적용한 ACP mode id. */
  currentModeId?: string
}

export interface AcpMapperState {
  /** toolCallId → 부분 업데이트에 빠진 앞선 필드. */
  tools: Map<string, AcpToolSnapshot>
  /** 같은 모르는 업데이트를 한 대화에 한 장만 올리기 위한 키. */
  warned: Set<string>
}

interface AcpToolSnapshot {
  title?: string
  name?: string
  kind?: acp.ToolKind
  rawInput?: unknown
  content?: acp.ToolCallContent[]
  locations?: acp.ToolCallLocation[]
}

const NOTHING: AcpMapped = { events: [], persist: [] }

export function createAcpMapperState(): AcpMapperState {
  return { tools: new Map(), warned: new Set() }
}

/**
 * ACP `session/update` 하나를 Wooi 대화·제어 이벤트로 옮긴다.
 *
 * 백엔드 식별자는 호출부가 넘긴다. 이 계층은 어떤 제품이 연결됐는지 알지 못하며, 모르는 종류도
 * 해당 식별자로 만든 고정 id 한 장에만 합친다([[shared/types]] unknownItemId).
 */
export function mapSessionUpdate(
  update: acp.SessionUpdate,
  backend: AgentBackendId,
  state: AcpMapperState,
  ts = Date.now()
): AcpMapped {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text' || !update.content.text) return NOTHING
      const type = update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'assistant'
      return {
        events: [
          {
            type: 'delta',
            id: `${backend}:${type}:${update.messageId ?? 'current'}`,
            itemType: type,
            text: update.content.text
          }
        ],
        persist: []
      }
    }

    case 'tool_call': {
      const snapshot = snapshotFrom(update)
      state.tools.set(update.toolCallId, snapshot)
      return itemResult(toolUseItem(backend, update.toolCallId, snapshot, ts))
    }

    case 'tool_call_update': {
      const snapshot = mergeSnapshot(state.tools.get(update.toolCallId), update)
      state.tools.set(update.toolCallId, snapshot)
      if (update.status !== 'completed' && update.status !== 'failed') {
        return itemResult(toolUseItem(backend, update.toolCallId, snapshot, ts))
      }
      const item: ChatItem = {
        id: `${backend}:toolres:${update.toolCallId}`,
        type: 'tool_result',
        toolId: update.toolCallId,
        text: toolOutputText(update, snapshot),
        isError: update.status === 'failed',
        ts
      }
      state.tools.delete(update.toolCallId)
      return itemResult(item)
    }

    case 'plan': {
      if (!update.entries.length) return NOTHING
      const id = `${backend}:plan`
      const item: ChatItem = {
        id,
        type: 'tool_use',
        toolId: id,
        name: ACP_PLAN_SNAPSHOT_TOOL,
        input: {
          tasks: update.entries.map((entry) => ({
            subject: entry.content,
            status: entry.status,
            priority: entry.priority
          }))
        },
        ts
      }
      return itemResult(item)
    }

    case 'available_commands_update':
      return { ...NOTHING, commands: commandsFrom(update) }

    case 'current_mode_update':
      return { ...NOTHING, currentModeId: update.currentModeId }

    // 사용자 입력은 Wooi 가 낙관적으로 이미 표시한다. 나머지는 이 버전의 공통 UI가 소비하지 않는
    // 안정 ACP 제어 업데이트라 대화에 구멍을 만들지 않는다.
    case 'user_message_chunk':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'plan_update':
    case 'plan_removed':
      return NOTHING

    default:
      return unknownUpdate(update, backend, state, ts)
  }
}

export function commandsFrom(update: acp.AvailableCommandsUpdate): SlashCommandInfo[] {
  return update.availableCommands.map((command) => {
    const hint = command.input && 'hint' in command.input ? command.input.hint : undefined
    return {
      name: command.name,
      description: command.description ?? '',
      ...(hint ? { argumentHint: hint } : {})
    }
  })
}

function itemResult(item: ChatItem): AcpMapped {
  return { events: [{ type: 'item', item }], persist: [item] }
}

function toolUseItem(
  backend: AgentBackendId,
  toolCallId: string,
  snapshot: AcpToolSnapshot,
  ts: number
): ChatItem {
  const diff = diffFromToolContent(snapshot.content)
  const locations = snapshot.locations?.map((location) => location.path) ?? []
  const input = isRecord(snapshot.rawInput) ? snapshot.rawInput : {}
  return {
    id: `${backend}:tool:${toolCallId}`,
    type: 'tool_use',
    toolId: toolCallId,
    name: snapshot.name || snapshot.title || describeToolKind(snapshot.kind),
    input: locations.length ? { ...input, locations } : input,
    ...(diff ? { diff } : {}),
    ts
  }
}

function toolOutputText(update: acp.ToolCallUpdate, snapshot: AcpToolSnapshot): string {
  const content = update.content ?? snapshot.content ?? []
  const text = content
    .map((part) =>
      part.type === 'content' && part.content.type === 'text' ? part.content.text : ''
    )
    .filter(Boolean)
    .join('\n')
  if (text) return text
  const raw = update.rawOutput
  if (isRecord(raw) && typeof raw.content === 'string') return raw.content
  return ''
}

/** ACP diff 블록을 렌더러가 받는 통합 diff 모양으로 만든다. */
export function diffFromToolContent(content: acp.ToolCallContent[] | undefined): string | null {
  const diffs = (content ?? [])
    .filter((part): part is acp.Diff & { type: 'diff' } => part.type === 'diff')
    .map((part) => {
      const lines = [`--- a/${part.path}`, `+++ b/${part.path}`, '@@ proposed change @@']
      for (const line of splitLines(part.oldText ?? '')) lines.push(`-${line}`)
      for (const line of splitLines(part.newText)) lines.push(`+${line}`)
      return lines.join('\n')
    })
  return diffs.length ? diffs.join('\n') : null
}

function snapshotFrom(update: acp.ToolCall): AcpToolSnapshot {
  return {
    title: update.title,
    ...(update.name ? { name: update.name } : {}),
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.content ? { content: update.content } : {}),
    ...(update.locations ? { locations: update.locations } : {})
  }
}

function mergeSnapshot(
  previous: AcpToolSnapshot | undefined,
  update: acp.ToolCallUpdate
): AcpToolSnapshot {
  return {
    ...previous,
    ...(update.title ? { title: update.title } : {}),
    ...(update.name ? { name: update.name } : {}),
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.content ? { content: update.content } : {}),
    ...(update.locations ? { locations: update.locations } : {})
  }
}

function unknownUpdate(
  update: never,
  backend: AgentBackendId,
  state: AcpMapperState,
  ts: number
): AcpMapped {
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate
  const what = `session update "${typeof kind === 'string' ? kind : 'unknown'}"`
  if (state.warned.has(what)) return NOTHING
  state.warned.add(what)
  const item: ChatItem = {
    id: unknownItemId(backend, what),
    type: 'unknown',
    backend,
    what,
    ts
  }
  return itemResult(item)
}

function describeToolKind(kind: acp.ToolKind | undefined): string {
  return kind && kind !== 'other' ? kind : 'ACP tool'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function splitLines(text: string): string[] {
  return text ? text.replace(/\n$/, '').split('\n') : []
}
