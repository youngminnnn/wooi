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
import type {
  CommandPanelKind,
  CommandResult,
  ContextUsageInfo,
  McpAction,
  McpServerInfo,
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
export async function runCommandOn(kind: CommandPanelKind, q: Query): Promise<CommandResult> {
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
      return { kind, usage: mapUsage(usage) }
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

/** /permissions — settings.json 들에서 권한 규칙(allow/ask/deny)을 모아 현재 모드와 함께 돌려준다. */
export function readPermissions(config: SessionConfig): CommandResult {
  // 우선순위가 낮은 것부터: 유저 → 프로젝트(worktree) → 로컬 오버라이드.
  const files = [
    join(homedir(), '.claude', 'settings.json'),
    join(config.cwd, '.claude', 'settings.json'),
    join(config.cwd, '.claude', 'settings.local.json')
  ]
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
      mode: config.permissionMode,
      allow: [...allow],
      ask: [...ask],
      deny: [...deny],
      sources
    }
  }
}

/**
 * 라이브 쿼리가 없을 때 쓰는 단명 제어 쿼리. 사용자 메시지를 넣지 않으므로 에이전트 턴이 돌지 않고,
 * 세션 옵션(mcpServers 주입·settingSources·실행 파일 경로)은 session.ts 와 동일하게 맞춘다.
 */
export async function runCommandShortLived(
  kind: CommandPanelKind,
  cwd: string,
  repoPath: string | null
): Promise<CommandResult> {
  const input = new AsyncQueue<SDKUserMessage>()
  const claudeExecutable = resolveClaudeExecutable()
  const mcpServers = resolveUserMcpServers(repoPath)
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
    return await runCommandOn(kind, q)
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

function mapUsage(u: SdkUsage): UsageInfo {
  const limits: UsageInfo['rateLimits'] = []
  const rl = u.rate_limits
  if (rl) {
    const push = (
      label: string,
      w?: { utilization: number | null; resets_at: string | null } | null
    ): void => {
      if (w) limits.push({ label, utilization: w.utilization, resetsAt: w.resets_at })
    }
    push('5-hour', rl.five_hour)
    push('7-day', rl.seven_day)
    push('7-day (Opus)', rl.seven_day_opus)
    push('7-day (Sonnet)', rl.seven_day_sonnet)
  }
  return {
    totalCostUsd: u.session.total_cost_usd,
    linesAdded: u.session.total_lines_added,
    linesRemoved: u.session.total_lines_removed,
    subscriptionType: u.subscription_type,
    rateLimitsAvailable: u.rate_limits_available,
    rateLimits: limits
  }
}
