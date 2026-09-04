import type { ChatItem } from './types'

export type ToolKind =
  'read' | 'search' | 'list' | 'bash' | 'mcp' | 'agent' | 'other' | 'uncollapsible'

type ToolUse = Extract<ChatItem, { type: 'tool_use' }>

export interface ToolGroup {
  id: string
  uses: ToolUse[]
  counts: Record<Exclude<ToolKind, 'uncollapsible'>, number>
  latestHint?: string
  active: boolean
  mcpServerNames: string[]
  agentDescriptions: string[]
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Apply patch'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep'])
const READ_TOOLS = new Set(['Read', 'ViewImage'])
const LIST_TOOLS = new Set(['LS', 'ListDirectory'])
const AGENT_TOOLS = new Set([
  'Agent',
  'Task',
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
  // 구버전 app-server와 이미 저장된 테스트/대화의 표기.
  'spawn_agent',
  'send_input',
  'resume_agent',
  'close_agent'
])
const MCP_NAME = /^mcp__(.+?)__/

/**
 * 이 도구가 파일을 바꾸는가. 묶임 판정(아래)과 대화 밀도의 "실제로 바꾼 것" 판정이 같은 목록을
 * 봐야 하므로 집합을 여기 한 곳에 두고 내보낸다.
 */
export function isFileEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name)
}

/** 이 도구가 "조회하고 훑는 일" 인가. 묶임의 단일 판정 지점. */
export function toolKind(name: string, input: unknown): ToolKind {
  if (EDIT_TOOLS.has(name)) {
    // 파일 변경은 diff 자체가 대화의 내용이다. Claude Code처럼 합치면 Wooi의 인라인 diff가
    // 사라지므로 그룹 경계로 남긴다.
    return 'uncollapsible'
  }
  if (name === 'Bash') return 'bash'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (LIST_TOOLS.has(name)) return 'list'
  if (READ_TOOLS.has(name)) {
    const path = stringField(input, 'file_path', 'path')
    return path?.endsWith('/') ? 'list' : 'read'
  }
  if (MCP_NAME.test(name)) return 'mcp'
  if (AGENT_TOOLS.has(name)) return 'agent'
  // 결과 자체가 대화 내용일 수 있는 낯선 도구를 낙관적으로 숨기지 않는다.
  //
  // WebFetch·WebSearch 도 여기로 떨어진다 — 훑어보고 지나가는 조회가 아니라 가져온 내용이
  // 곧 답의 재료라, 파일 읽기와 같은 취급으로 "read N files" 안에 섞으면 문구도 틀리고
  // 사용자가 봐야 할 것이 사라진다. Claude Code 도 이 둘은 묶지 않는다.
  return 'uncollapsible'
}

export function buildToolGroups(
  items: readonly ChatItem[],
  excludedItemIds: ReadonlySet<string> = new Set()
): { groupByItemId: Map<string, ToolGroup>; hiddenItemIds: Set<string> } {
  const groupByItemId = new Map<string, ToolGroup>()
  const hiddenItemIds = new Set<string>()
  const results = new Set(
    items
      .filter(
        (item): item is Extract<ChatItem, { type: 'tool_result' }> => item.type === 'tool_result'
      )
      .map((item) => item.toolId)
  )
  const knownUses = new Set(
    items.filter((item): item is ToolUse => item.type === 'tool_use').map((item) => item.toolId)
  )
  let run: ToolUse[] = []

  const flush = (): void => {
    if (run.length >= 2) {
      const group = makeGroup(run, results)
      groupByItemId.set(group.id, group)
      for (const use of run.slice(1)) hiddenItemIds.add(use.id)
    }
    run = []
  }

  for (const item of items) {
    if (excludedItemIds.has(item.id)) {
      flush()
      continue
    }
    if (item.type === 'tool_result' && knownUses.has(item.toolId)) continue
    if (item.type !== 'tool_use' || toolKind(item.name, item.input) === 'uncollapsible') {
      flush()
      continue
    }
    run.push(item)
  }
  flush()
  return { groupByItemId, hiddenItemIds }
}

function makeGroup(uses: ToolUse[], results: ReadonlySet<string>): ToolGroup {
  const counts: ToolGroup['counts'] = {
    read: 0,
    search: 0,
    list: 0,
    bash: 0,
    mcp: 0,
    agent: 0,
    other: 0
  }
  const servers = new Set<string>()
  const agentDescriptions: string[] = []
  let latestHint: string | undefined
  for (const use of uses) {
    const kind = toolKind(use.name, use.input)
    if (kind === 'uncollapsible') continue
    counts[kind]++
    if (kind === 'read' || kind === 'list') {
      latestHint = stringField(use.input, 'file_path', 'path') ?? latestHint
    } else if (kind === 'search') {
      latestHint = stringField(use.input, 'pattern', 'query') ?? latestHint
    } else if (kind === 'mcp') {
      const server = MCP_NAME.exec(use.name)?.[1]
      if (server) servers.add(server)
    } else if (kind === 'agent') {
      const description = stringField(use.input, 'description')
      if (description) agentDescriptions.push(description)
    }
  }
  return {
    id: uses[0]!.id,
    uses,
    counts,
    latestHint,
    active: uses.some((use) => !results.has(use.toolId)),
    mcpServerNames: [...servers],
    agentDescriptions
  }
}

/** 그룹 한 줄의 문구. 진행 중이면 현재진행형. */
export function formatToolGroup(group: ToolGroup): string {
  const { counts, active } = group
  const parts: string[] = []
  add(parts, counts.search, active ? 'searching for' : 'searched for', 'pattern')
  add(parts, counts.read, active ? 'reading' : 'read', 'file')
  add(parts, counts.list, active ? 'listing' : 'listed', 'directory')
  add(parts, counts.bash, active ? 'running' : 'ran', 'shell command')
  if (counts.mcp) {
    const servers = group.mcpServerNames.join(', ') || 'MCP'
    parts.push(
      `${active ? 'calling' : 'called'} ${servers} ${counts.mcp} ${counts.mcp === 1 ? 'time' : 'times'}`
    )
  }
  if (counts.agent === 1 && group.agentDescriptions[0]) {
    parts.push(`${active ? 'running' : 'ran'} agent · ${group.agentDescriptions[0]}`)
  } else {
    add(parts, counts.agent, active ? 'running' : 'ran', 'agent')
  }
  add(parts, counts.other, active ? 'calling' : 'called', 'tool')
  const line = parts.join(', ')
  return line ? line[0]!.toUpperCase() + line.slice(1) : ''
}

function add(parts: string[], count: number, verb: string, noun: string): void {
  if (count) parts.push(`${verb} ${count} ${noun}${count === 1 ? '' : 's'}`)
}

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key]
  return undefined
}
