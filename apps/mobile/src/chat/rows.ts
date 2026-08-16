import { buildToolGroups, type ToolGroup } from '@shared/toolGroups'
import { FOLD, fold, toolActivity, toolDisplayName, toolUseSummary } from '@shared/toolDisplay'
import { formatToolSummary } from '@shared/toolSummary'
import type { ChatItem } from '@shared/types'

type ToolUse = Extract<ChatItem, { type: 'tool_use' }>
type ToolResult = Extract<ChatItem, { type: 'tool_result' }>

export const RAW_OUTPUT_LINE_CAP = 200

export interface ToolCardModel {
  use?: ToolUse
  result?: ToolResult
  title: string
  subtitle?: string
  body?: string
  omittedLines: number
  error: boolean
}

export type ChatRowModel =
  | { id: string; kind: 'item'; item: Exclude<ChatItem, ToolUse | ToolResult> }
  | { id: string; kind: 'tool'; card: ToolCardModel }
  | { id: string; kind: 'tool-group'; group: ToolGroup; cards: ToolCardModel[] }

/**
 * 모바일 목록은 newest-first지만 공유 그룹 로직은 대화 순서를 전제로 한다. 계산만 뒤집어서 하고
 * 반환 순서는 다시 원래대로 유지해야 FlatList의 inverted 계약과 페이지 병합 순서가 흔들리지 않는다.
 */
export function buildChatRows(items: readonly ChatItem[]): ChatRowModel[] {
  const chronological = [...items].reverse()
  const results = new Map<string, ToolResult>()
  const uses = new Set<string>()
  for (const item of chronological) {
    if (item.type === 'tool_use') uses.add(item.toolId)
    else if (item.type === 'tool_result') results.set(item.toolId, item)
  }

  const { groupByItemId, hiddenItemIds } = buildToolGroups(chronological)
  const rows: ChatRowModel[] = []
  for (const item of items) {
    if (item.type === 'thinking' && !item.text.trim()) continue
    if (item.type === 'tool_result' && uses.has(item.toolId)) continue
    if (item.type === 'tool_use' && hiddenItemIds.has(item.id)) continue

    const group = groupByItemId.get(item.id)
    if (group) {
      rows.push({
        id: item.id,
        kind: 'tool-group',
        group,
        cards: group.uses.map((use) => makeToolCard(use, results.get(use.toolId)))
      })
    } else if (item.type === 'tool_use') {
      rows.push({ id: item.id, kind: 'tool', card: makeToolCard(item, results.get(item.toolId)) })
    } else if (item.type === 'tool_result') {
      rows.push({ id: item.id, kind: 'tool', card: makeToolCard(undefined, item) })
    } else {
      rows.push({ id: item.id, kind: 'item', item })
    }
  }
  return rows
}

function makeToolCard(use: ToolUse | undefined, result: ToolResult | undefined): ToolCardModel {
  const useHint = use ? toolUseSummary(use.name, use.input) : ''
  const title = use
    ? result
      ? `${toolDisplayName(use.name)}${useHint ? ` · ${useHint}` : ''}`
      : toolActivity(use.name, use.input)
    : result?.isError
      ? 'Tool error'
      : 'Tool result'
  const folded = result ? fold(result.text, result.isError ? FOLD.error : FOLD.lines) : undefined
  const subtitle = result
    ? !result.isError && result.summary
      ? formatToolSummary(result.summary)
      : folded?.head.split('\n')[0]
    : undefined
  // 본문이 없으면 body 를 두지 않는다 — 펼칠 것이 없는데 펼치는 시늉을 하는 카드를 만들지
  // 않기 위해서다. 데스크톱도 더 볼 것이 없으면 토글 자체를 그리지 않는다(ToolResultBody).
  const capped = result && result.text.trim() ? capRawOutput(result.text) : undefined
  return {
    use,
    result,
    title,
    subtitle: subtitle || undefined,
    body: capped?.text,
    omittedLines: capped?.omittedLines ?? 0,
    error: result?.isError ?? false
  }
}

export function capRawOutput(text: string): { text: string; omittedLines: number } {
  const lines = text.split('\n')
  // 200줄이면 긴 빌드 로그도 원인 주변을 충분히 보면서, 한 카드가 수천 줄로 대화를 밀어내지 않는다.
  if (lines.length <= RAW_OUTPUT_LINE_CAP) return { text, omittedLines: 0 }
  return {
    text: lines.slice(0, RAW_OUTPUT_LINE_CAP).join('\n'),
    omittedLines: lines.length - RAW_OUTPUT_LINE_CAP
  }
}
