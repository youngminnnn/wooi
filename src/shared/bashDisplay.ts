/** Codex CLI 0.146.0의 exec cell 출력 행 상한. */
export const BASH_FOLD = {
  /** 모델이 실행한 명령. codex-rs/tui의 TOOL_CALL_MAX_LINES. */
  agent: 5,
  /** 사용자가 `!`로 직접 실행한 명령. USER_SHELL_TOOL_CALL_MAX_LINES. */
  user: 50
} as const

/** 앞·뒤 문맥을 남기고 가운데를 접는다. 생략 행 자체도 max 한 줄을 차지한다. */
export function foldBashOutput(text: string, max: number): { text: string; omitted: number } {
  if (!text || max <= 0) return { text: '', omitted: text ? text.split('\n').length : 0 }
  const lines = text.split('\n')
  if (lines.length <= max) return { text, omitted: 0 }

  if (max === 1) return { text: `… +${lines.length} lines`, omitted: lines.length }
  if (max === 2) {
    return { text: `${lines[0]}\n… +${lines.length - 1} lines`, omitted: lines.length - 1 }
  }

  const visible = max - 1
  const head = Math.ceil(visible / 2)
  const tail = Math.floor(visible / 2)
  const omitted = lines.length - head - tail
  return {
    text: `${lines.slice(0, head).join('\n')}\n… +${omitted} lines\n${lines.slice(-tail).join('\n')}`,
    omitted
  }
}
