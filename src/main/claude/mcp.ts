import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../logger'

/**
 * SDK 가 파일시스템 설정(settings.json · CLAUDE.md · 프로젝트 .mcp.json)을 `claude` CLI 와
 * 동일하게 로드하도록 모든 스코프를 명시한다. 0.3.160 에서는 생략 시 기본값도 "전체 로드"지만,
 * 의도를 분명히 하고(특히 CLAUDE.md 로드를 위해 'project' 필수) SDK 버전 기본값 변화에
 * 흔들리지 않도록 고정한다. 이 설정만으로는 user 스코프 ~/.claude.json 서버가 보장되지
 * 않으므로 resolveUserMcpServers 의 명시 주입과 함께 쓴다.
 */
export const MCP_SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local']

/** claude CLI 와 동일한 규칙으로 ~/.claude.json 위치를 정한다(CLAUDE_CONFIG_DIR 우선). */
function configPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || homedir()
  return join(dir, '.claude.json')
}

type ClaudeJson = {
  mcpServers?: Record<string, McpServerConfig>
  projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>
}

/**
 * 사용자가 `claude` CLI 용으로 등록해 둔 MCP 서버를 SDK 로 그대로 흘려보내기 위해
 * ~/.claude.json 에서 추려 병합한다.
 *
 * 왜 직접 읽나: ditto 는 worktree 경로를 cwd 로 주는데, SDK 는 그 cwd 기준으로만 project/local
 * 스코프 MCP 를 찾는다 — 새로 만든 worktree 경로는 ~/.claude.json 의 projects 에 없으니
 * 사용자가 원본 repo 에 등록한 서버가 통째로 누락된다(그래서 "CLI 에선 되는데 ditto 에선 안 됨").
 * 원본 repo 경로(repoPath)의 project/local 스코프 서버를 직접 읽어 user 스코프와 합쳐
 * mcpServers 옵션으로 명시 주입하면, 스코프와 무관하게 동일하게 동작한다. stdio·http·sse 정의가
 * 모두 McpServerConfig 와 같은 형태라 변환 없이 그대로 넘긴다. claude.ai 커넥터처럼 계정에
 * 묶여 파일에 없는 서버는 settingSources(user)+동일 바이너리+동일 HOME 으로 SDK 가 로드한다.
 *
 * 이름이 겹치면 더 좁은 스코프(project/local)가 user 를 덮는다 — claude CLI 우선순위와 동일.
 * 파일이 없거나 파싱에 실패해도 빈 객체를 돌려 세션 생성을 막지 않는다.
 */
export function resolveUserMcpServers(repoPath: string | null): Record<string, McpServerConfig> {
  try {
    const path = configPath()
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ClaudeJson
    const user = raw.mcpServers ?? {}
    const project = (repoPath && raw.projects?.[repoPath]?.mcpServers) || {}
    const merged = { ...user, ...project }
    const names = Object.keys(merged)
    if (names.length) {
      log.info(`mcp: injected ${names.length} user-config server(s) [${names.join(', ')}]`)
    }
    return merged
  } catch (err) {
    log.warn('mcp: failed to read ~/.claude.json; no user MCP servers injected', err)
    return {}
  }
}
