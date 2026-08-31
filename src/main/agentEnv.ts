import { agentSettingsFor, sanitizeAgentEnv } from '@shared/types'
import type { AgentBackendId } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'

/**
 * 백엔드별 기본 환경 변수를 읽어 주입할 수 있는 모양으로 돌려준다. **메인 프로세스 전용** —
 * store 를 거치므로 electron `app` 에 매여 있고, 유틸리티 프로세스(agent-host·codex-host)에서
 * import 하면 로드 시점에 죽는다([[main/mcpSettings]] 의 같은 주석, #280).
 *
 * 값은 API 키·토큰일 수 있다. 그래서 이 파일은 **키 이름만** 로그에 남기고 값은 절대 찍지
 * 않는다 — 로그는 사용자가 진단용으로 통째로 붙여 넣는 물건이다([[codex/config]]
 * redactDebugConfig 가 `env` 아래를 전부 가리는 것과 같은 이유).
 *
 * 설정을 못 읽었다는 이유로 세션 생성을 멈추면 안 되므로, 실패는 빈 맵으로 떨어뜨린다
 * (스토어가 아직 없는 유닛 테스트 경로 포함).
 */
export function agentDefaultEnv(backend: AgentBackendId): Record<string, string> {
  let raw: Record<string, string> | undefined
  try {
    raw = agentSettingsFor(getStore().getState().settings, backend).env
  } catch (err) {
    log.warn(`agent env: could not read defaults for ${backend} — injecting nothing`, err)
    return {}
  }

  const { env, blocked } = sanitizeAgentEnv(raw)
  const names = Object.keys(env)
  if (names.length) {
    log.info(`agent env: injecting ${names.length} var(s) for ${backend}: ${names.join(', ')}`)
  }
  if (blocked.length) {
    log.warn(
      `agent env: dropped reserved or malformed var(s) for ${backend}: ${blocked.join(', ')}`
    )
  }
  return env
}
