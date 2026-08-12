import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { isValidMcpServerName } from '@shared/types'
import type { InheritedMcpServer, McpInventory, McpSettings, WooiMcpServer } from '@shared/types'
import { log } from '../logger'

/**
 * **이 모듈은 agent-host(유틸리티 프로세스)에서도 로드된다** — session.ts·control.ts 가 쓴다.
 * 그러니 electron `app` 이나 store 에 매인 것을 import 하면 안 된다(logger.ts 의 같은 주석 참고).
 * 한때 `wooiMcpSettings()` 를 직접 불렀다가 store → `import { app } from 'electron'` 이 딸려
 * 들어와 호스트가 로그 한 줄 없이 죽었다(#280). Wooi 스코프 설정은 메인이 읽어 인자로 넘긴다.
 * scripts/check-host-imports.mjs 가 이 규칙을 지킨다.
 */

/**
 * SDK 가 파일시스템 설정(settings.json · CLAUDE.md · 프로젝트 .mcp.json)을 `claude` CLI 와
 * 동일하게 로드하도록 모든 스코프를 명시한다. 0.3.160 에서는 생략 시 기본값도 "전체 로드"지만,
 * 의도를 분명히 하고(특히 CLAUDE.md 로드를 위해 'project' 필수) SDK 버전 기본값 변화에
 * 흔들리지 않도록 고정한다. 이 설정만으로는 user 스코프 ~/.claude.json 서버가 보장되지
 * 않으므로 resolveUserMcpServers 의 명시 주입과 함께 쓴다.
 */
export const MCP_SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local']

/** claude CLI 와 동일한 규칙으로 ~/.claude.json 위치를 정한다(CLAUDE_CONFIG_DIR 우선). */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || homedir()
  return join(dir, '.claude.json')
}

type ClaudeJson = {
  mcpServers?: Record<string, McpServerConfig>
  projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>
}

/** ~/.claude.json 을 읽는다. 없거나 깨졌으면 빈 객체 — 세션 생성을 막지 않는다. */
function readClaudeJson(): ClaudeJson {
  try {
    const path = claudeConfigPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeJson
  } catch (err) {
    log.warn('mcp: failed to read ~/.claude.json; no user MCP servers injected', err)
    return {}
  }
}

/** Wooi 스코프 항목을 SDK 가 받는 형태로 옮긴다. 이름은 호출 측이 키로 쓴다. */
function toSdkConfig(server: WooiMcpServer): McpServerConfig {
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      command: server.command,
      args: server.args,
      // 빈 객체를 넘겨도 SDK 는 부모 환경을 그대로 물려주므로 굳이 걸러내지 않는다.
      env: server.env
    }
  }
  return { type: server.transport, url: server.url, headers: server.headers }
}

/**
 * 사용자가 `claude` CLI 용으로 등록해 둔 MCP 서버 + Wooi 스코프 서버를 세션에 주입할 형태로 합친다.
 *
 * 왜 ~/.claude.json 을 직접 읽나: wooi 는 worktree 경로를 cwd 로 주는데, SDK 는 그 cwd 기준으로만
 * project/local 스코프 MCP 를 찾는다 — 새로 만든 worktree 경로는 ~/.claude.json 의 projects 에
 * 없으니 사용자가 원본 repo 에 등록한 서버가 통째로 누락된다(그래서 "CLI 에선 되는데 wooi 에선
 * 안 됨"). 원본 repo 경로(repoPath)의 project/local 스코프 서버를 직접 읽어 user 스코프와 합쳐
 * mcpServers 옵션으로 명시 주입하면, 스코프와 무관하게 동일하게 동작한다. stdio·http·sse 정의가
 * 모두 McpServerConfig 와 같은 형태라 변환 없이 그대로 넘긴다. claude.ai 커넥터처럼 계정에
 * 묶여 파일에 없는 서버는 settingSources(user)+동일 바이너리+동일 HOME 으로 SDK 가 로드한다.
 *
 * 우선순위 — 이름이 겹칠 때:
 *  1. project/local(`projects[repoPath]`)이 user 를 덮는다 — claude CLI 와 같은 규칙.
 *  2. **~/.claude.json 이 Wooi 스코프를 이긴다.** 사용자가 CLI 로 등록해 둔 설정이 앱 설정
 *     때문에 조용히 다른 서버로 바뀌는 편보다, 앱 쪽이 물러서고 UI 에서 "가려짐" 을 알리는 편이
 *     예측 가능하다. 다만 그 승계 항목을 설정에서 꺼 두면(disabledInherited) 이름이 비므로,
 *     같은 이름의 Wooi 서버가 그 자리를 대신한다 — 그게 "덮어쓰기" 의 명시적 경로다.
 *
 * mcp 인자는 Wooi 스코프 설정이다. 호스트에는 store 가 없으므로 메인이 읽어 넘긴다
 * (`wooiMcpSettings()` 또는 SessionConfig.mcpSettings).
 */
export function resolveUserMcpServers(
  repoPath: string | null,
  mcp: McpSettings
): Record<string, McpServerConfig> {
  const raw = readClaudeJson()
  const disabled = new Set(mcp.disabledInherited)

  const inherited = {
    ...(raw.mcpServers ?? {}),
    ...((repoPath && raw.projects?.[repoPath]?.mcpServers) || {})
  }
  const merged: Record<string, McpServerConfig> = {}
  for (const [name, config] of Object.entries(inherited)) {
    if (disabled.has(name)) continue
    merged[name] = config
  }

  const shadowed: string[] = []
  for (const server of mcp.servers) {
    const name = server.name.trim()
    if (!server.enabled || !isValidMcpServerName(name)) continue
    if (merged[name]) {
      shadowed.push(name)
      continue
    }
    merged[name] = toSdkConfig(server)
  }
  if (shadowed.length) {
    log.warn(
      `mcp: Wooi-managed server(s) [${shadowed.join(', ')}] are shadowed by ~/.claude.json — ` +
        `disable the inherited entry in Settings → MCP servers to use yours instead`
    )
  }

  const names = Object.keys(merged)
  if (names.length) {
    log.info(`mcp: injected ${names.length} configured server(s) [${names.join(', ')}]`)
  }
  return merged
}

/** stdio/http/sse 판별 + 한 줄 요약. 형태를 모르는 항목도 목록에서 사라지지 않게 한다. */
function describeInherited(config: unknown): Pick<InheritedMcpServer, 'transport' | 'detail'> {
  const value = (config ?? {}) as Record<string, unknown>
  const type = typeof value.type === 'string' ? value.type : null
  if (typeof value.command === 'string' && (type === null || type === 'stdio')) {
    const args = Array.isArray(value.args) ? value.args.filter((a) => typeof a === 'string') : []
    return { transport: 'stdio', detail: [value.command, ...args].join(' ') }
  }
  if (typeof value.url === 'string' && (type === 'http' || type === 'sse')) {
    return { transport: type, detail: value.url }
  }
  if (typeof value.url === 'string') return { transport: 'http', detail: value.url }
  return { transport: 'unknown', detail: '' }
}

/**
 * 설정 화면이 그릴 승계 목록. user 스코프는 모든 세션에 들어가므로 그대로 싣고, project 스코프는
 * **Wooi 에 등록된 리포 경로만** 싣는다 — ~/.claude.json 의 projects 에는 CLI 를 한 번이라도 띄운
 * 모든 디렉터리가 쌓여 있어서, 거르지 않으면 이 앱에서 절대 주입되지 않는 항목이 목록을 덮는다.
 */
export function mcpInventory(repoPaths: string[]): McpInventory {
  const path = claudeConfigPath()
  const raw = readClaudeJson()
  const inherited: InheritedMcpServer[] = []

  for (const [name, config] of Object.entries(raw.mcpServers ?? {})) {
    inherited.push({ name, origin: 'user', ...describeInherited(config) })
  }
  for (const repoPath of repoPaths) {
    for (const [name, config] of Object.entries(raw.projects?.[repoPath]?.mcpServers ?? {})) {
      inherited.push({
        name,
        origin: 'project',
        projectPath: repoPath,
        ...describeInherited(config)
      })
    }
  }

  return { configPath: path, configExists: existsSync(path), inherited }
}
