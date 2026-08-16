import type { ToolSummary } from '@shared/toolSummary'

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const string = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function patchStats(value: unknown): { added: number; removed: number } {
  if (!Array.isArray(value)) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const raw of value) {
    const patch = object(raw)
    const lines = patch?.lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  return { added, removed }
}

/**
 * SDK 가 주는 전체 출력에는 편집 전 파일처럼 매우 큰 값도 들어 있다. 화면과 트랜스크립트에
 * 필요한 작은 수치만 여기서 뽑고, 모르는 모양은 억지로 해석하지 않아 기존 text 경로로 보낸다.
 */
export function summarizeToolResult(toolName: string, structured: unknown): ToolSummary | null {
  const value = object(structured)
  if (!value) return null
  if (toolName === 'Read') {
    const file = object(value.file)
    const path = string(file?.filePath)
    const lines = number(file?.numLines)
    if (path == null || lines == null) return null
    return {
      kind: 'read',
      path,
      lines,
      ...(number(file?.totalLines) != null ? { total: number(file?.totalLines)! } : {}),
      ...(file?.truncatedByTokenCap === true ? { truncated: true } : {})
    }
  }
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const path = string(value.filePath)
    if (!path) return null
    return { kind: 'patch', path, ...patchStats(value.structuredPatch) }
  }
  if (toolName === 'Write') {
    const path = string(value.filePath)
    if (!path) return null
    const stats = patchStats(value.structuredPatch)
    // 새 파일이면 "몇 줄을 썼는가" 가 전부지만, 기존 파일을 덮어썼다면 무엇이 얼마나 바뀌었는지가
    // 알고 싶은 것이다 — 그때는 편집과 같은 +/− 로 보여 준다.
    if (value.type !== 'create') return { kind: 'patch', path, ...stats }
    return { kind: 'write', path, lines: stats.added, created: true }
  }
  if (toolName === 'Glob') {
    const count = number(value.numFiles)
    return count == null
      ? null
      : {
          kind: 'found',
          count,
          unit: 'file',
          ...(value.truncated === true ? { truncated: true } : {})
        }
  }
  if (toolName === 'Grep') {
    const count = number(value.numMatches) ?? number(value.numLines)
    if (count == null) return null
    const across = number(value.numFiles)
    return {
      kind: 'found',
      count,
      unit: 'match',
      ...(across != null ? { across } : {}),
      // appliedLimit 은 boolean 이 아니라 "몇 개에서 잘랐는가" 하는 숫자다.
      ...(number(value.appliedLimit) != null ? { truncated: true } : {})
    }
  }
  if (toolName === 'Bash') {
    const stdout = string(value.stdout)
    const stderr = string(value.stderr)
    if (stdout == null && stderr == null && value.backgroundTaskId == null) return null
    return {
      kind: 'output',
      empty: !(stdout || stderr),
      ...(value.backgroundTaskId ? { background: true } : {}),
      ...(value.interrupted === true ? { interrupted: true } : {})
    }
  }
  if (toolName === 'WebFetch') {
    const url = string(value.url),
      code = number(value.code),
      bytes = number(value.bytes)
    return url == null || code == null || bytes == null ? null : { kind: 'fetch', url, code, bytes }
  }
  if (toolName === 'TodoWrite') {
    if (!Array.isArray(value.newTodos)) return null
    const done = value.newTodos.filter((todo) => object(todo)?.status === 'completed').length
    return { kind: 'todos', done, total: value.newTodos.length }
  }
  if (toolName === 'Agent' || toolName === 'Task') {
    const uses =
      number(value.toolUses) ?? (Array.isArray(value.toolUses) ? value.toolUses.length : null)
    return uses == null ? null : { kind: 'agent', toolUses: uses }
  }
  return null
}
