import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * "다시 묻지 않기" 를 **도구 전체**가 아니라 이번 요청과 같은 종류로 좁히는 규칙.
 *
 * 왜 필요한가: 지금까지 Always allow 는 도구 이름 하나를 통째로 열어 줬다 —
 * `npm test` 한 번 허용하면 그 세션의 모든 Bash(=`rm -rf`, `curl | sh` 포함)가 무사통과였다.
 * 터미널 Claude Code 는 같은 자리에서 `Bash(npm test:*)` 처럼 좁은 규칙을 만들어 주고, 그 규칙을
 * 설정 파일에 저장해 다음 세션에서도 쓴다. 표기법도 그쪽과 맞춰 `/permissions` 목록과
 * settings.json 에 그대로 얹힐 수 있게 한다.
 *
 * 지원하는 규칙 모양:
 *   Bash(npm run:*)            — 접두 일치(같은 명령으로 시작하는 호출)
 *   Bash(git status)           — 정확 일치(셸 메타문자가 있어 접두로 열면 위험한 명령)
 *   Edit(src/main/**)          — 그 디렉토리 아래의 파일(cwd 기준 상대 경로)
 *   Edit(//Users/me/x/**)      — 같은 의미의 절대 경로
 *   WebFetch(domain:example.com)
 *   Grep                       — 인자 없는 규칙 = 그 도구 전체
 */

/** 경로 인자를 쓰는 파일 도구(규칙을 디렉토리 단위로 좁힌다). */
const PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read'])

/**
 * 접두 규칙을 포기하고 정확 일치로 떨어뜨릴 셸 메타문자.
 * `npm test && rm -rf /` 같은 결합을 `npm test:*` 가 삼키면 안 된다.
 */
const SHELL_META = /[|&;<>()$`\n]/

/** 접두에 넣을 최대 토큰 수. `git commit`·`npm run` 정도의 입도를 노린다. */
const MAX_PREFIX_TOKENS = 2

/** 이 요청을 다시 묻지 않게 할 때 저장할 규칙 문자열. */
export function ruleForRequest(toolName: string, input: unknown, cwd: string): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  if (toolName === 'Bash') {
    const command = typeof obj.command === 'string' ? obj.command.trim() : ''
    if (!command) return toolName
    const prefix = commandPrefix(command)
    return prefix ? `Bash(${prefix}:*)` : `Bash(${command})`
  }

  if (PATH_TOOLS.has(toolName)) {
    const path = pathArg(obj)
    if (!path) return toolName
    return `${toolName}(${dirPattern(dirname(path), cwd)})`
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const url = typeof obj.url === 'string' ? obj.url : ''
    const host = hostOf(url)
    return host ? `${toolName}(domain:${host})` : toolName
  }

  return toolName
}

/** 저장된 규칙이 이 요청을 덮는지. */
export function matchesRule(rule: string, toolName: string, input: unknown, cwd: string): boolean {
  const parsed = parseRule(rule)
  if (!parsed || parsed.name !== toolName) return false
  if (parsed.arg === null) return true // 인자 없는 규칙 = 도구 전체

  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  if (toolName === 'Bash') {
    const command = typeof obj.command === 'string' ? obj.command.trim() : ''
    if (!command) return false
    if (!parsed.arg.endsWith(':*')) return command === parsed.arg
    const prefix = parsed.arg.slice(0, -2)
    return command === prefix || command.startsWith(`${prefix} `)
  }

  if (PATH_TOOLS.has(toolName)) {
    const path = pathArg(obj)
    if (!path) return false
    return underPattern(path, parsed.arg, cwd)
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const host = hostOf(typeof obj.url === 'string' ? obj.url : '')
    return !!host && parsed.arg === `domain:${host}`
  }

  return false
}

/**
 * 규칙을 리포의 `.claude/settings.local.json` 의 permissions.allow 에 추가한다. 저장했으면 true.
 *
 * worktree 가 아니라 **원본 리포**에 쓴다 — worktree 는 작업이 끝나면 사라지므로 거기 저장한
 * 규칙은 다음 작업에 남지 않는다. settings.local.json 은 gitignore 대상이라 개인 설정으로 적합하고,
 * 터미널 Claude Code 의 "don't ask again" 이 쓰는 파일과 같다.
 */
export function saveAllowRule(repoRoot: string, rule: string): boolean {
  try {
    const dir = join(repoRoot, '.claude')
    const file = join(dir, 'settings.local.json')
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
    } catch {
      // 파일이 없거나 JSON 이 깨졌다 — 새로 쓴다. 깨진 파일을 덮는 건 CLI 도 읽지 못하던
      // 내용이라 잃을 게 없다.
    }
    const perms =
      json.permissions && typeof json.permissions === 'object'
        ? (json.permissions as Record<string, unknown>)
        : {}
    const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]).map(String) : []
    if (!allow.includes(rule)) allow.push(rule)
    json.permissions = { ...perms, allow }
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

// ── 내부 ────────────────────────────────────────────────────────────────────

/** `Tool(arg)` 를 이름과 인자로 가른다. 인자가 없으면 arg=null. */
function parseRule(rule: string): { name: string; arg: string | null } | null {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return null
  return { name: m[1], arg: m[2] ?? null }
}

/**
 * 접두 규칙으로 쓸 명령의 앞부분. 접두로 열면 위험한 명령(셸 메타문자 포함)은 null 을 돌려
 * 호출부가 정확 일치 규칙을 쓰게 한다.
 */
function commandPrefix(command: string): string | null {
  if (SHELL_META.test(command)) return null
  const tokens = command.split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  const prefix = [tokens[0]]
  // 두 번째 토큰은 `run`·`commit` 같은 하위 명령일 때만 포함한다(옵션·경로·인자는 제외).
  if (tokens.length > 1 && MAX_PREFIX_TOKENS > 1 && /^[a-z][\w-]*$/.test(tokens[1])) {
    prefix.push(tokens[1])
  }
  return prefix.join(' ')
}

function pathArg(obj: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/** 디렉토리를 규칙 인자로 표기한다: cwd 안이면 상대 경로, 밖이면 `//절대경로`. */
function dirPattern(dir: string, cwd: string): string {
  const abs = isAbsolute(dir) ? dir : resolve(cwd, dir)
  const rel = relative(cwd, abs)
  if (!rel) return '**'
  return rel.startsWith('..') ? `/${abs}/**` : `${rel}/**`
}

/** 파일 경로가 `src/**` / `//abs/**` 패턴이 가리키는 디렉토리 아래에 있는지. */
function underPattern(path: string, pattern: string, cwd: string): boolean {
  if (!pattern.endsWith('/**') && pattern !== '**') return false
  const body = pattern === '**' ? '' : pattern.slice(0, -3)
  // `//abs` 는 절대 경로 표기다(상대 경로와 구분하기 위한 접두 슬래시 하나를 뗀다).
  const dir = body.startsWith('/') ? body.slice(1) : resolve(cwd, body)
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const rel = relative(dir, abs)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}
