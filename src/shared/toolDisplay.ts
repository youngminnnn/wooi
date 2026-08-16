/**
 * 도구 로그의 **노출 정책**. 어떻게 생겼는지가 아니라 무엇을 얼마나 보여 줄지만 다룬다.
 *
 * 두 가지 외형(ToolCardWooi·ToolCardTerminal)이 이 파일 하나를 함께 쓴다 — 접는 줄 수와
 * 요약 문구가 스타일마다 다르면 "같은 대화를 다른 옷으로 본다"가 아니라 서로 다른 두 제품이
 * 된다. 껍데기는 갈라져도 판단은 여기 한곳에 모은다.
 */

/**
 * 접기 임계값. Claude Code CLI 2.1.233 이 쓰는 값을 그대로 옮겼다(번들에서 확인한 상수명 병기).
 * 우리가 새로 정한 숫자가 아니므로, 바꾸고 싶을 때는 CLI 쪽이 먼저 바뀌었는지 확인한다.
 */
export const FOLD = {
  /** xAt — 일반 출력에서 접기 전에 보여 주는 줄 수. */
  lines: 3,
  /** eQe — 파일 내용 미리보기 줄 수. */
  preview: 10,
  /** scr — 실패 메시지 줄 수. 원인을 읽으려면 세 줄로는 모자란다. */
  error: 10,
  /** j2m — 도구 헤더에 실을 셸 명령 줄 수. */
  commandLines: 2,
  /** w7n — 도구 헤더에 실을 셸 명령 최대 문자 수. */
  commandChars: 160
} as const

/** 접힌 결과를 한 번에 펼치는 단축키. 힌트 문구가 실제 바인딩과 어긋나지 않게 한곳에서만 쓴다. */
export const TOOL_VERBOSE_SHORTCUT = '⌃O'

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null

/** 도구 이름 → 사람이 읽을 이름. Claude Code 의 userFacingName() 이 내놓는 값을 따른다. */
const DISPLAY_NAMES: Record<string, string> = {
  Glob: 'Search',
  Grep: 'Search',
  NotebookEdit: 'Edit Notebook',
  WebSearch: 'Web Search',
  TaskOutput: 'Task Output',
  Agent: 'Task',
  Task: 'Task'
}

/**
 * MCP 도구 이름은 `mcp__<서버>__<도구>` 다.
 *
 * 서버 이름에 밑줄이 들어가는 경우가 흔하다(플러그인이 붙여 주는 `plugin_<플러그인>_<서버>`).
 * 그래서 첫 조각을 "밑줄 아닌 문자" 로 잡으면 안 되고, `__` 구분자를 최소로 먹는 방식이라야 한다.
 */
const MCP_NAME = /^mcp__(.+?)__(.+)$/

export function toolDisplayName(name: string): string {
  const mcp = MCP_NAME.exec(name)
  if (mcp) return `${mcp[2]!.replaceAll('_', ' ')} (${mcp[1]})`
  return DISPLAY_NAMES[name] ?? name
}

/** 셸 명령은 헤더에 통째로 실을 수 없다 — 앞 두 줄, 160자까지만. */
function commandSummary(command: string): string {
  const lines = command.split('\n').slice(0, FOLD.commandLines).join('\n')
  return lines.length > FOLD.commandChars ? `${lines.slice(0, FOLD.commandChars - 1)}…` : lines
}

/** 인자에서 헤더 괄호 안에 넣을 한 줄을 고른다. 없으면 빈 문자열(괄호 자체를 안 그린다). */
export function toolUseSummary(name: string, input: unknown): string {
  const obj = record(input)
  if (!obj) return ''
  if (name === 'Bash' && typeof obj.command === 'string') return commandSummary(obj.command)
  for (const key of ['file_path', 'path', 'pattern', 'query', 'url', 'skill', 'description']) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * 실행 중에 보여 줄 현재진행형 문구("Searching for foo").
 *
 * 스피너만 도는 것과 무엇을 하느라 도는지 아는 것은 기다리는 체감이 다르다. Claude Code 의
 * getActivityDescription() 과 같은 취지이며 동사도 그쪽을 따랐다.
 */
const ACTIVITY_VERBS: Record<string, string> = {
  Read: 'Reading',
  Glob: 'Searching for',
  Grep: 'Searching for',
  WebSearch: 'Searching for',
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing notebook',
  WebFetch: 'Fetching',
  Bash: 'Running'
}

export function toolActivity(name: string, input: unknown): string {
  const summary = toolUseSummary(name, input)
  const verb = ACTIVITY_VERBS[name] ?? 'Using'
  return summary ? `${verb} ${summary}` : `${verb}…`
}

/**
 * 앞 `max` 줄만 남기고 나머지 줄 수를 센다.
 *
 * 넘치는 줄이 **딱 한 줄이면 접지 않는다** — "… +1 line" 이 차지하는 자리가 그 한 줄과 같은데,
 * 접으면 내용 대신 접었다는 사실만 남는다. Claude Code 도 같은 예외를 둔다.
 */
export function fold(text: string, max: number = FOLD.lines): { head: string; remaining: number } {
  if (!text) return { head: '', remaining: 0 }
  const lines = text.split('\n')
  const remaining = lines.length - max
  if (remaining <= 1) return { head: text, remaining: 0 }
  return { head: lines.slice(0, max).join('\n'), remaining }
}
