import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'
import { resolveClaudeExecutable } from './executable'
import { MCP_SETTING_SOURCES } from './mcp'
import { INTERACTIVE_COMMANDS } from '@shared/types'
import type { SlashCommandInfo } from '@shared/types'

/**
 * worktree(cwd) 별 슬래시 명령/스킬 목록을 조회해 캐시한다(입력창 자동완성용).
 *
 * 명령 목록은 query 가 떠 있어야 얻을 수 있으므로(Query.supportedCommands),
 * 입력 큐를 비운 채 짧은 수명 query 를 하나 열어 목록만 받고 곧장 닫는다 — 사용자 메시지를
 * 넣지 않으므로 에이전트가 무언가 실행하지 않는다. cwd 마다 1회만 조회하고 결과를 캐시해
 * 자동완성을 빠르게 띄운다(프로젝트 스코프 명령/스킬은 cwd 에 따라 다를 수 있다).
 */
const cache = new Map<string, Promise<SlashCommandInfo[]>>()

/**
 * SDK supportedCommands() 가 돌려주지 않는 내장 명령을 자동완성에 보강한다.
 * /btw 와 /mcp·/context·/reload-plugins 등은 Claude Code TUI 전용(local-jsx · control-request)이라
 * SDK 목록에서 빠지지만, Ditto 는 이를 직접 처리하므로(sideQuestion.ts · control.ts) 입력창에서
 * 고를 수 있어야 한다.
 */
const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'btw',
    description: 'Ask a quick side question without interrupting the current task',
    argumentHint: '<question>'
  },
  // /model·/effort 는 Composer 가 로컬 선택 카드로 처리한다(백엔드 왕복 없음). 자동완성에만 보강.
  { name: 'model', description: 'Choose the model for this workspace' },
  { name: 'effort', description: 'Choose the reasoning effort for this workspace' },
  // 패스스루(메시지로 보내면 CLI 가 확장) — 자동완성에만 보강한다.
  {
    name: 'compact',
    description: 'Summarize the conversation so far to free up context',
    argumentHint: '[instructions]'
  },
  // Composer 가 로컬/메인에서 직접 처리하는 명령들(SDK 목록엔 없음).
  { name: 'clear', description: 'Clear the conversation and start a fresh session' },
  { name: 'diff', description: 'Open the changes (diff) view for this workspace' },
  { name: 'copy', description: "Copy the assistant's last response to the clipboard" },
  { name: 'help', description: 'List the slash commands available here' },
  { name: 'memory', description: 'Open this project’s CLAUDE.md in your editor' },
  // /mcp·/context·/usage(+cost·stats)·/rewind·/permissions 등 인터셉트 명령(SSOT: INTERACTIVE_COMMANDS).
  ...INTERACTIVE_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.aliases ? { aliases: c.aliases } : {})
  }))
]

/** 플러그인/스킬 리로드 후 자동완성 명령 목록을 다시 받도록 캐시를 비운다. */
export function clearCommandsCache(cwd?: string): void {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

export function listSlashCommands(cwd: string): Promise<SlashCommandInfo[]> {
  const cached = cache.get(cwd)
  if (cached) return cached

  const promise = fetchCommands(cwd).catch(() => [] as SlashCommandInfo[])
  cache.set(cwd, promise)
  // 빈 결과(미설치/로그아웃/실패)는 다음 호출에서 다시 시도하도록 캐시에서 비운다.
  void promise.then((cmds) => {
    if (cmds.length === 0) cache.delete(cwd)
  })
  return promise
}

/** CLI 기동/응답이 지연돼도 자동완성이 멈추지 않도록 둔 상한. */
const FETCH_TIMEOUT_MS = 8000

async function fetchCommands(cwd: string): Promise<SlashCommandInfo[]> {
  const input = new AsyncQueue<SDKUserMessage>()
  // session.ts 와 동일 — 패키징 빌드에서 app.asar 내부 경로로 CLI 를 spawn 해 ENOTDIR 로
  // 실패하면 명령 목록이 빈 채로 와 자동완성이 안 뜨므로, unpacked 바이너리 경로를 명시한다.
  const claudeExecutable = resolveClaudeExecutable()
  const q = query({
    prompt: input,
    options: {
      cwd,
      // 프로젝트/유저 스코프 슬래시 명령·스킬이 자동완성에 뜨도록 CLI 와 동일하게 설정을 로드.
      settingSources: MCP_SETTING_SOURCES,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {})
    }
  })
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('supportedCommands timed out')), FETCH_TIMEOUT_MS)
    )
    const commands = await Promise.race([q.supportedCommands(), timeout])
    const fromSdk = commands.map((c) => ({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint || undefined,
      // SDK 가 돌려주는 별칭(예: /cost·/stats → /usage)을 자동완성 매칭에 함께 싣는다.
      ...(c.aliases && c.aliases.length ? { aliases: c.aliases } : {})
    }))

    // 내장 명령을 앞에 보강하되, SDK 가 같은 이름을 이미 돌려줬다면 중복을 피한다.
    const present = new Set(fromSdk.map((c) => c.name))
    return [...BUILTIN_COMMANDS.filter((c) => !present.has(c.name)), ...fromSdk]
  } finally {
    // 정리는 fire-and-forget — 조회 결과 반환을 인터럽트 응답 대기로 막지 않는다.
    input.close()
    void q.interrupt().catch(() => {})
  }
}
