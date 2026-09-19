import type { ToolSummary } from '@shared/toolSummary'
import { binaryContentPlaceholder } from '@shared/toolContent'
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

  // imageGeneration은 app-server가 결과 이미지를 savedPath로만 알려 준다. 경로를 보존하면
  // 사용자는 무엇이 만들어졌는지 확인할 수 있지만, 아직 ToolResultBody는 file-citation
  // directive를 해석하지 않으므로 여기서 directive를 만들면 원문 문법이 노출된다.
  if (item.type === 'imageGeneration' && item.savedPath) {
    return { text: `Generated image: ${item.savedPath}` }
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

/** 텍스트는 보존하되 바이너리·리소스 블록은 안전한 식별 정보로만 바꾼다. */
function textContent(content: unknown[]): string | null {
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw)
      continue
    }
    const block = record(raw)
    // resource 안의 blob은 binaryContentPlaceholder보다 풍부한 식별 정보를 줄 수 있다.
    if (block?.type === 'resource' || block?.type === 'embedded_resource') {
      parts.push(embeddedResourceDescription(block))
      continue
    }
    const binary = binaryContentPlaceholder(block)
    if (binary) {
      parts.push(binary)
      continue
    }
    if (!block) {
      parts.push('[Unsupported content omitted]')
      continue
    }
    if (block.type === 'resource_link' || block.type === 'resourceLink') {
      parts.push(resourceLinkDescription(block))
      continue
    }
    // 새 content type도 text 필드를 제공하면 텍스트라는 사실만 믿고 보존한다. 그렇지 않은
    // 모양은 기존 JSON 폴백으로 보내되, 아래 safeResultJson이 payload를 숨긴다.
    if (typeof block.text !== 'string') {
      parts.push('[Unsupported content omitted]')
      continue
    }
    parts.push(block.text)
  }
  return parts.join('\n')
}

function describeResult(result: unknown): string {
  if (result === undefined || result === null) return 'Done.'
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

/** MCP resource_link는 URL을 열거나 fetch하지 않고 표시용 메타데이터만 남긴다. */
function resourceLinkDescription(block: Record<string, unknown>): string {
  return resourceDescription('Resource link', block)
}

/** embedded resource의 text/blob 본문은 도구 출력에 복제하지 않는다. */
function embeddedResourceDescription(block: Record<string, unknown>): string {
  const resource = record(block.resource)
  return resourceDescription('Embedded resource', resource ?? block)
}

function resourceDescription(label: string, value: Record<string, unknown>): string {
  const uri = stringField(value.uri)
  const title = stringField(value.title) ?? stringField(value.name)
  const mime = stringField(value.mimeType) ?? stringField(value.mime_type)
  const identity = title ?? uri ?? 'unnamed resource'
  const details = [mime && `(${mime})`, uri && uri !== identity && `— ${uri}`]
    .filter((part): part is string => Boolean(part))
    .join(' ')
  return `[${label}: ${identity}${details ? ` ${details}` : ''}]`
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
