import type { ToolSummary } from './types'

export type { ToolSummary }

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`

/** 요약 → 접힌 상태에서 보여 줄 문구. 문구는 Claude Code 의 결과 렌더러를 따랐다. */
export function formatToolSummary(summary: ToolSummary): string {
  switch (summary.kind) {
    case 'read': {
      const of =
        summary.total != null && summary.total !== summary.lines ? ` of ${summary.total}` : ''
      return `Read ${summary.path} (${plural(summary.lines, 'line')}${of}${summary.truncated ? ', truncated' : ''})`
    }
    case 'view':
      return `Viewed ${summary.path}`
    case 'write':
      return `Wrote ${plural(summary.lines, 'line')} to ${summary.path}`
    case 'patch':
      return `Updated ${summary.path} (+${summary.added} −${summary.removed})`
    case 'files':
      return summary.paths.length === 1
        ? `Updated ${summary.paths[0]}`
        : `Updated ${plural(summary.paths.length, 'file')}`
    case 'found':
      return `Found ${plural(summary.count, summary.unit)}${summary.across != null ? ` across ${plural(summary.across, 'file')}` : ''}${summary.truncated ? ' (truncated)' : ''}`
    case 'output':
      if (summary.background) return 'Running in the background'
      if (summary.interrupted) return 'Interrupted'
      return summary.empty ? '(No output)' : 'Done'
    case 'fetch':
      return `Fetched ${summary.url} (${summary.code}, ${plural(summary.bytes, 'byte')})`
    case 'todos':
      return `${summary.done}/${summary.total} tasks completed`
    case 'agent':
      return plural(summary.toolUses, 'tool use')
  }
}
