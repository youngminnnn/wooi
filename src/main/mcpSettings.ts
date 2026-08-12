import { CODEX_MCP_SERVERS_ENV, isValidMcpServerName, mcpSettingsOf } from '@shared/types'
import type { CodexStdioServer, McpSettings, WooiMcpServer } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'

/**
 * Wooi 스코프 MCP 설정을 읽는다. **메인 프로세스 전용** — store 를 거치므로 electron `app` 에
 * 매여 있다.
 *
 * codex-host 는 유틸리티 프로세스라 이 파일을 import 하면 안 된다. `import { app } from
 * 'electron'` 은 거기서 **로드 시점에 throw** 하고(logger.ts 의 같은 주석 참고), 호스트는 로그
 * 한 줄 없이 exit 1 로 죽는다 — 겉으로는 "Codex host crashed" 로만 보여 원인을 찾기 어렵다.
 * 그래서 codex 쪽에는 결과 테이블을 env 로 내려 준다(codexMcpServerEnv).
 *
 * 어느 쪽도 "설정을 못 읽었다" 는 이유로 세션 생성을 멈추면 안 되므로, 실패는 빈 목록으로
 * 떨어뜨리고 경고만 남긴다(스토어가 아직 없는 유닛 테스트 경로 포함).
 */
export function wooiMcpSettings(): McpSettings {
  try {
    return mcpSettingsOf(getStore().getState().settings)
  } catch (err) {
    log.warn('mcp: could not read Wooi MCP settings — treating the list as empty', err)
    return { servers: [], disabledInherited: [] }
  }
}

/**
 * 이름·활성 상태가 온전한 Wooi 스코프 서버만 추린다.
 *
 * 이름 규칙(영숫자·`_`·`-`)은 UI 가 강제하지만 여기서도 한 번 거른다 — 저장 파일을 손으로
 * 고칠 수 있고, 이름이 곧 도구 접두사이자 Codex 의 TOML 점 표기 키라서 이상한 이름은 조용한
 * 오작동이 아니라 파싱 오류로 번진다.
 */
export function enabledWooiMcpServers(): WooiMcpServer[] {
  return wooiMcpSettings().servers.filter(
    (server) => server.enabled && isValidMcpServerName(server.name)
  )
}

/**
 * Wooi 스코프 MCP 서버를 codex 가 이해하는 테이블로 옮긴다.
 *
 * **stdio 만** 옮긴다. codex 의 원격(HTTP/SSE) MCP 지원은 실험 플래그
 * (`experimental_use_rmcp_client`) 뒤에 있고 스키마도 Claude 쪽과 다르다 — 조용히 어긋난
 * 설정을 밀어 넣느니 목록에서 빼고 UI 에서 "Claude Code 에만 주입됨" 으로 알리는 편이 낫다.
 */
export function codexMcpServerTable(): Record<string, CodexStdioServer> {
  const table: Record<string, CodexStdioServer> = {}
  const skipped: string[] = []
  for (const server of enabledWooiMcpServers()) {
    if (server.transport !== 'stdio') {
      skipped.push(server.name.trim())
      continue
    }
    table[server.name.trim()] = { command: server.command, args: server.args, env: server.env }
  }
  if (skipped.length) {
    log.warn(
      `codex: Wooi-managed HTTP/SSE MCP server(s) [${skipped.join(', ')}] are not injected — ` +
        `codex only takes stdio servers from Wooi`
    )
  }
  return table
}

/** codex-host fork 에 실을 env 조각. 호스트는 이 값만 보고 store 를 건드리지 않는다. */
export function codexMcpServerEnv(): Record<string, string> {
  return { [CODEX_MCP_SERVERS_ENV]: JSON.stringify(codexMcpServerTable()) }
}
