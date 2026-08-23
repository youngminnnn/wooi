import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from './asyncQueue'
import { resolveClaudeExecutable } from './executable'
import { MCP_SETTING_SOURCES, resolveUserMcpServers } from './mcp'
import { clearCommandsCache } from './commands'
import type { SessionConfig } from './protocol'
import { SESSION_RATE_LIMIT_LABEL } from '@shared/types'
import type {
  CommandPanelKind,
  CommandResult,
  ContextUsageInfo,
  McpAction,
  McpServerInfo,
  McpSettings,
  UsageInfo
} from '@shared/types'

/**
 * 인터랙티브(TUI 전용) 슬래시 명령을 Agent SDK 제어 메서드로 실행한다.
 *
 * /mcp·/context·/reload-plugins 같은 명령은 CLI TUI 에서 React 패널을 띄우는 local-jsx 타입이라
 * 일반 프롬프트로 보내면 동작하지 않는다. 대신 Query 객체의 제어 메서드(mcpServerStatus·
 * getContextUsage·reloadPlugins 등)를 호출해 데이터를 받아 카드로 보여 준다.
 *
 * 라이브 세션 쿼리가 있으면 그 위에서 실행한다(컨텍스트 사용량·플러그인 리로드가 "지금 돌고 있는"
 * 에이전트에 반영되도록). 없으면 자동완성 조회(commands.ts)와 같은 방식으로 단명 쿼리를 하나 열어
 * 데이터만 받고 닫는다.
 */

/** 제어 응답이 지연돼도 카드가 멈추지 않도록 둔 상한(자동완성 조회와 동일 성격). */
const CONTROL_TIMEOUT_MS = 15000

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out`)), CONTROL_TIMEOUT_MS)
  )
  return Promise.race([p, timeout])
}

/** 주어진 라이브 Query 위에서 인터랙티브 명령을 실행하고 표시용 결과로 변환한다. */
export async function runCommandOn(
  kind: CommandPanelKind,
  q: Query,
  opts: { live?: boolean } = {}
): Promise<CommandResult> {
  // 이 함수는 원래 살아 있는 쿼리 위에서 실행하는 경로다. 단명 쿼리만 명시적으로 false 를 넘겨,
  // 세션 비용과 변경 줄 수가 실제 세션에서 온 값인지 결과에 남긴다.
  const live = opts.live ?? true
  switch (kind) {
    case 'mcp': {
      const servers = await withTimeout(q.mcpServerStatus(), 'mcpServerStatus')
      return { kind, servers: servers.map(mapServer) }
    }
    case 'agents': {
      const agents = await withTimeout(q.supportedAgents(), 'supportedAgents')
      return {
        kind,
        agents: agents.map((a) => ({ name: a.name, description: a.description, model: a.model }))
      }
    }
    case 'context': {
      const ctx = await withTimeout(q.getContextUsage(), 'getContextUsage')
      return { kind, context: mapContext(ctx) }
    }
    case 'usage': {
      const usage = await withTimeout(
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        'usage'
      )
      return { kind, usage: mapUsage(usage, live) }
    }
    case 'reloadPlugins': {
      const r = await withTimeout(q.reloadPlugins(), 'reloadPlugins')
      // 리로드로 명령/스킬 집합이 바뀌므로 자동완성 캐시를 비워 다음 입력에서 새로 받게 한다.
      return {
        kind,
        reload: {
          pluginCount: r.plugins.length,
          commandCount: r.commands.length,
          agentCount: r.agents.length,
          mcpServerCount: r.mcpServers.length,
          errorCount: r.error_count
        }
      }
    }
    case 'reloadSkills': {
      const r = await withTimeout(q.reloadSkills(), 'reloadSkills')
      return { kind, reload: { skillCount: r.skills.length } }
    }
    case 'rewind':
    case 'permissions':
      // 이 둘은 라이브 Query 가 아니라 세션 상태(체크포인트)·설정 파일을 읽어야 하므로
      // host 에서 직접 처리한다(여기로 오면 라우팅이 잘못된 것).
      throw new Error(`${kind} is handled in the host, not runCommandOn`)
  }
}

/** MCP 서버가 붙을 때까지 기다리는 상한과 재조회 간격(단명 쿼리 전용). */
const MCP_SETTLE_TIMEOUT_MS = 3000
const MCP_SETTLE_INTERVAL_MS = 250

/**
 * 갓 띄운 단명 쿼리에서 MCP 서버 목록을 읽는다. 0ms 에 물어보면 서버가 아직 붙는 중이라,
 * 실측에서 2개 중 1개만 그것도 `pending` 으로 돌아왔다 — 카드가 "0 connected" 로 굳어 보인다.
 * 목록이 더 늘지 않고 pending 도 없을 때까지(또는 상한까지) 짧게 다시 묻는다. 상한을 넘겨도
 * 마지막으로 본 목록을 그대로 돌려주므로, 정말 연결 중인 서버는 카드에 'connecting…' 으로 남는다.
 */
export async function readMcpServersSettled(
  q: Pick<Query, 'mcpServerStatus'>,
  opts: {
    timeoutMs?: number
    intervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<McpServerInfo[]> {
  const timeoutMs = opts.timeoutMs ?? MCP_SETTLE_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? MCP_SETTLE_INTERVAL_MS
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  let last = await withTimeout(q.mcpServerStatus(), 'mcpServerStatus')
  while (now() - started < timeoutMs) {
    // 서버가 하나도 안 보이는 것도 "아직 못 붙었다" 에 해당한다(목록 자체가 늦게 찬다).
    const settled = last.length > 0 && !last.some((s) => s.status === 'pending')
    if (settled) break
    await sleep(intervalMs)
    last = await withTimeout(q.mcpServerStatus(), 'mcpServerStatus')
  }
  return last.map(mapServer)
}

/**
 * /permissions 가 읽는 settings 파일들을 **읽는 순서대로**(유저 → 프로젝트 → 로컬 오버라이드)
 * 나열한다. 카드는 규칙을 합집합으로 보여 주므로 이 순서가 우선순위를 뜻하지는 않는다 —
 * 실제로는 맨 앞의 관리형 정책이 나머지 전부를 이긴다.
 *
 * 관리형 정책(managed-settings.json)은 조직이 배포하는 파일이고 사용자 설정으로 덮을 수 없다.
 * 목록에서 빠져 있으면 카드가 "실제로 걸려 있는 deny 규칙" 을 통째로 놓치므로 반드시 포함한다.
 * 경로는 Claude Code 가 쓰는 것과 같다(플랫폼별로 다르다).
 *
 * 이 목록이 권한 규칙의 전부는 아니다 — 플러그인이 싣는 규칙과 Wooi 가 query 에 주입하는 인라인
 * settings 레이어는 파일로 존재하지 않고, SDK 의 initializationResult() 응답에도 권한 필드가 없다.
 * 그래서 카드는 실제로 읽은 파일 목록(sources)을 그대로 보여 주고 전부가 아닐 수 있다고 말한다.
 */
export function permissionSettingsFiles(
  cwd: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const managed =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : platform === 'win32'
        ? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
        : '/etc/claude-code/managed-settings.json'
  return [
    managed,
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json')
  ]
}

/** 주어진 settings 파일들에서 allow/ask/deny 를 모아 현재 모드와 함께 돌려준다(없는 파일은 건너뛴다). */
export function collectPermissions(
  files: string[],
  mode: SessionConfig['permissionMode']
): CommandResult {
  const allow = new Set<string>()
  const ask = new Set<string>()
  const deny = new Set<string>()
  const sources: string[] = []
  for (const file of files) {
    let json: { permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } } | null
    try {
      json = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      continue // 파일이 없거나 손상 → 건너뛴다.
    }
    const perms = json?.permissions
    if (!perms) continue
    sources.push(file)
    for (const r of perms.allow ?? []) allow.add(r)
    for (const r of perms.ask ?? []) ask.add(r)
    for (const r of perms.deny ?? []) deny.add(r)
  }
  return {
    kind: 'permissions',
    permissions: {
      mode,
      allow: [...allow],
      ask: [...ask],
      deny: [...deny],
      sources
    }
  }
}

/** /permissions — settings.json 들에서 권한 규칙(allow/ask/deny)을 모아 현재 모드와 함께 돌려준다. */
export function readPermissions(config: SessionConfig): CommandResult {
  return collectPermissions(permissionSettingsFiles(config.cwd), config.permissionMode)
}

/**
 * 단명 쿼리로는 **의미 있는 답을 만들 수 없는** 명령. 사용자 메시지가 하나도 없는 빈 query 의
 * 컨텍스트는 시스템 프롬프트와 도구 정의뿐이라 Messages 카테고리가 통째로 없고, 모델 옵션도
 * 워크스페이스가 아닌 CLI 기본값을 따른다 — 500k 짜리 대화 중에도 "26k / 2%" 라고 말하게 된다.
 * 조용히 틀린 숫자를 보여 주느니 세션이 없다는 사실을 그대로 말한다.
 */
export const LIVE_ONLY_COMMANDS: CommandPanelKind[] = ['context']

/** 라이브 세션이 없어 실행할 수 없을 때 카드에 그대로 보여 줄 안내. */
export function noLiveSessionError(kind: CommandPanelKind): Error {
  return new Error(
    `No live session in this workspace yet. Send a message first — /${kind} reads the running session.`
  )
}

/**
 * 라이브 쿼리가 없을 때 쓰는 단명 제어 쿼리. 사용자 메시지를 넣지 않으므로 에이전트 턴이 돌지 않고,
 * 세션 옵션(mcpServers 주입·settingSources·실행 파일 경로)은 session.ts 와 동일하게 맞춘다.
 */
export async function runCommandShortLived(
  kind: CommandPanelKind,
  cwd: string,
  repoPath: string | null,
  mcpSettings: McpSettings
): Promise<CommandResult> {
  const input = new AsyncQueue<SDKUserMessage>()
  const claudeExecutable = resolveClaudeExecutable()
  const mcpServers = resolveUserMcpServers(repoPath, mcpSettings)
  const q = query({
    prompt: input,
    options: {
      cwd,
      settingSources: MCP_SETTING_SOURCES,
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {})
    }
  })
  try {
    // MCP 는 방금 띄운 쿼리에서 서버가 붙는 데 시간이 걸린다 — 정착을 짧게 기다린 뒤 읽는다.
    if (kind === 'mcp') return { kind, servers: await readMcpServersSettled(q) }
    return await runCommandOn(kind, q, { live: false })
  } finally {
    input.close()
    void q.interrupt().catch(() => {})
  }
}

/**
 * /mcp 패널의 서버별 동작(재연결·활성/비활성)을 살아 있는 query 위에서 실행하고,
 * 갱신된 서버 목록을 돌려준다. 동작과 재조회를 같은 제어 채널에서 처리해, 패널이
 * 항상 방금 적용된 상태를 그대로 비추게 한다.
 *
 * reconnect 는 SDK 의 reconnectMcpServer, enable/disable 는 toggleMcpServer 로 매핑된다.
 * 둘 다 스트리밍 입력(살아 있는 세션) 위에서만 동작하는 제어 요청이라, 호출 측(manager)이
 * 라이브 query 를 보장(필요 시 warm up)한 뒤 넘겨야 한다.
 */
export async function runMcpAction(
  action: McpAction,
  serverName: string,
  q: Query
): Promise<McpServerInfo[]> {
  if (action === 'reconnect') {
    await withTimeout(q.reconnectMcpServer(serverName), 'reconnectMcpServer')
  } else {
    await withTimeout(q.toggleMcpServer(serverName, action === 'enable'), 'toggleMcpServer')
  }
  const servers = await withTimeout(q.mcpServerStatus(), 'mcpServerStatus')
  return servers.map(mapServer)
}

/** 리로드 결과 처리 후 자동완성 캐시를 무효화해 새 명령 목록이 반영되게 한다. */
export function invalidateAfterReload(kind: CommandPanelKind, cwd: string): void {
  if (kind === 'reloadPlugins' || kind === 'reloadSkills') clearCommandsCache(cwd)
}

// ── 매퍼: SDK 응답 → 표시용 경량 타입 ───────────────────────────────────────

type SdkServer = Awaited<ReturnType<Query['mcpServerStatus']>>[number]
type SdkContext = Awaited<ReturnType<Query['getContextUsage']>>
type SdkUsage = Awaited<
  ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>
>

function mapServer(s: SdkServer): McpServerInfo {
  const { transport, endpoint } = describeTransport(s.config)
  return {
    name: s.name,
    status: s.status,
    scope: s.scope,
    toolCount: s.tools?.length,
    error: s.error,
    version: s.serverInfo?.version,
    transport,
    endpoint,
    tools: s.tools?.map((t) => ({ name: t.name, description: t.description }))
  }
}

/** 서버 config 에서 전송 방식과 사람이 읽을 엔드포인트(URL 또는 실행 명령)를 추린다. */
function describeTransport(config: SdkServer['config']): { transport?: string; endpoint?: string } {
  if (!config) return {}
  const c = config as { type?: string; url?: string; command?: string; args?: string[] }
  if (typeof c.url === 'string') {
    return { transport: c.type ?? 'http', endpoint: c.url }
  }
  if (typeof c.command === 'string') {
    const args = Array.isArray(c.args) ? c.args : []
    return { transport: c.type ?? 'stdio', endpoint: [c.command, ...args].join(' ') }
  }
  return { transport: c.type }
}

function mapContext(c: SdkContext): ContextUsageInfo {
  const categories = c.categories
    .filter((cat) => cat.tokens > 0)
    .map((cat) => ({ name: cat.name, tokens: cat.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
  return {
    totalTokens: c.totalTokens,
    maxTokens: c.maxTokens,
    percentage: c.percentage,
    model: c.model,
    categories
  }
}

function mapUsage(u: SdkUsage, sessionDataAvailable: boolean): UsageInfo {
  const limits: UsageInfo['rateLimits'] = []
  const rl = u.rate_limits
  if (rl) {
    // 레거시 seven_day_opus/sonnet 과 신형 model_scoped 는 같은 모델 창을 가리킬 수 있다.
    // 라벨이 곧 renderer 의 React key 이므로 먼저 들어온 쪽만 남겨 중복 행을 막는다.
    const push = (
      label: string,
      w?: { utilization: number | null; resets_at: string | null } | null
    ): void => {
      if (!w) return
      if (limits.some((l) => l.label === label)) return
      limits.push({ label, utilization: w.utilization, resetsAt: w.resets_at })
    }
    push(SESSION_RATE_LIMIT_LABEL, rl.five_hour)
    push('7-day', rl.seven_day)
    push('7-day (Opus)', rl.seven_day_opus)
    push('7-day (Sonnet)', rl.seven_day_sonnet)
    // 요즘 계정은 모델별 주간 창이 seven_day_* 대신 서버가 채우는 model_scoped[] 로 온다.
    // 여기를 빼면 Opus/Fable 창이 통째로 사라져 최대 사용률 롤업이 실제보다 낮게 나온다.
    for (const m of rl.model_scoped ?? []) {
      push(`7-day (${m.display_name})`, { utilization: m.utilization, resets_at: m.resets_at })
    }
  }
  const extra = rl?.extra_usage
  return {
    sessionDataAvailable,
    totalCostUsd: u.session.total_cost_usd,
    linesAdded: u.session.total_lines_added,
    linesRemoved: u.session.total_lines_removed,
    subscriptionType: u.subscription_type,
    rateLimitsAvailable: u.rate_limits_available,
    rateLimits: limits,
    extraUsage: extra
      ? {
          utilization: extra.utilization,
          usedCredits: extra.used_credits,
          monthlyLimit: extra.monthly_limit,
          currency: extra.currency ?? null,
          isEnabled: extra.is_enabled
        }
      : null
  }
}
