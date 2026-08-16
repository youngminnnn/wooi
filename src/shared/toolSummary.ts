/**
 * 도구 결과를 한 줄로 줄인 것.
 *
 * 에이전트가 받은 원문(수천 줄일 수 있다)이 아니라 **화면에 필요한 수치만** 담는다. 트랜스크립트
 * (.jsonl)에 그대로 실려 나가므로 여기에 큰 문자열을 넣으면 기록이 부풀고, 대화를 다시 열 때마다
 * 그 값을 되읽게 된다. 원문이 필요하면 같은 항목의 `text` 를 펼쳐서 본다.
 */
export type ToolSummary =
  | { kind: 'read'; path: string; lines: number; total?: number; truncated?: boolean }
  | { kind: 'write'; path: string; lines: number; created: boolean }
  | { kind: 'patch'; path: string; added: number; removed: number }
  | { kind: 'files'; paths: string[] }
  | { kind: 'found'; count: number; unit: 'file' | 'match'; across?: number; truncated?: boolean }
  | { kind: 'output'; empty: boolean; background?: boolean; interrupted?: boolean }
  | { kind: 'fetch'; url: string; code: number; bytes: number }
  | { kind: 'todos'; done: number; total: number }
  | { kind: 'agent'; toolUses: number }

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`

/** 요약 → 접힌 상태에서 보여 줄 문구. 문구는 Claude Code 의 결과 렌더러를 따랐다. */
export function formatToolSummary(summary: ToolSummary): string {
  switch (summary.kind) {
    case 'read': {
      const of =
        summary.total != null && summary.total !== summary.lines ? ` of ${summary.total}` : ''
      return `Read ${summary.path} (${plural(summary.lines, 'line')}${of}${summary.truncated ? ', truncated' : ''})`
    }
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
