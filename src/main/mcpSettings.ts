import { isValidMcpServerName, mcpSettingsOf } from '@shared/types'
import type { McpSettings, WooiMcpServer } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'

/**
 * Wooi 스코프 MCP 설정을 읽는 공용 진입점.
 *
 * 백엔드 두 곳(claude/mcp.ts · codex/appServer.ts)이 같은 목록을 봐야 해서 여기 모았다.
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
