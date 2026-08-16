import type { ToolSummary } from '@shared/toolSummary'
import type { ThreadItem } from './wire'

export interface CodexToolResult {
  text: string
  summary?: ToolSummary
}

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Codex app-server의 구조화 결과를 화면용 텍스트와 작은 요약으로 줄인다.
 *
 * MCP structuredContent는 도구마다 뜻이 달라 수치를 추측할 수 없다. 대신 표준 content의 텍스트
 * 블록만 포장 객체에서 꺼내고, 해석할 수 없는 모양은 원래 JSON 폴백을 보존한다.
 */
export function codexToolResult(item: ThreadItem): CodexToolResult {
  if (item.type === 'imageView' && item.path) {
    return { text: 'Done.', summary: { kind: 'view', path: item.path } }
  }

  if (item.type === 'mcpToolCall') {
    const result = record(item.result)
    const content = result?.content
    if (Array.isArray(content)) {
      const text = textContent(content)
      if (text != null) {
        return {
          text,
          ...(content.length === 0 ? { summary: { kind: 'output', empty: true } as const } : {})
        }
      }
    }
  }

  if (item.type === 'dynamicToolCall' && Array.isArray(item.contentItems)) {
    const text = textContent(item.contentItems)
    if (text != null) {
      return {
        text,
        ...(item.contentItems.length === 0
          ? { summary: { kind: 'output', empty: true } as const }
          : {})
      }
    }
  }

  return { text: describeResult(item.result) }
}

/** 전부 텍스트 블록일 때만 벗긴다. 이미지·리소스가 섞이면 JSON 폴백이 정보를 보존한다. */
function textContent(content: unknown[]): string | null {
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw)
      continue
    }
    const block = record(raw)
    if (block?.type !== 'text' && block?.type !== 'inputText') return null
    if (typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return parts.join('\n')
}

function describeResult(result: unknown): string {
  if (result === undefined || result === null) return 'Done.'
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}
