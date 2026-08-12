import {
  AGENT_BACKEND_IDS,
  agentSettingsFor,
  type AgentBackendId,
  type AppSettings,
  type EffortSetting,
  type Workspace
} from '@shared/types'
import { backendMeta } from './backend'

/**
 * 멀티 에이전트 모드의 단일 해석 지점.
 *
 * 위임이 열리는 조건은 **워크스페이스 모드 × 메인 백엔드의 capability** 두 가지의 곱이다. 세션
 * 생성 경로마다 따로 적으면 어느 경로에서만 위임 도구가 실리거나 빠지는 식으로 갈라지므로 여기
 * 한 곳에 모은다.
 */

/**
 * 이 워크스페이스에서 위임할 수 있는 에이전트 종류. 빈 배열이면 위임 도구를 아예 노출하지 않는다.
 *
 * 멀티 에이전트 워크스페이스는 **모드**이지 백엔드 화이트리스트가 아니다 — 켜져 있으면 등록된
 * 모든 에이전트 종류를 쓸 수 있고, 어떤 종류로 띄울지는 대화에서 자연어로 정한다. 미리 목록을
 * 고르게 하면 "Codex 한테 시켜줘" 라고 말했는데 생성 시점에 체크를 안 했다는 이유로 안 되는,
 * 설명하기 어려운 실패가 생긴다.
 *
 * 메인 백엔드 자신도 뺴지 않는다. "Claude 서브에이전트 두 개 띄워줘" 도 자연스러운 요청이고,
 * 같은 종류일 때 네이티브 서브에이전트를 우선하라는 안내는 도구 설명이 맡는다(claude/delegate.ts).
 *
 * CLI 가 설치돼 있는지는 보지 않는다 — 확인이 비동기라 세션 설정 계산과 결이 맞지 않고, 없는
 * CLI 로 위임하면 서브런이 "The Codex CLI is not available." 라는 분명한 도구 결과로 끊는다.
 */
export function delegateBackendsFor(ws: Workspace): AgentBackendId[] {
  if (!ws.multiAgent) return []
  // capability 는 모드와 무관한 전제라 따로 물어본다 — 조율하는 쪽이 될 수 없는 백엔드(위임
  // 도구를 꽂을 경로가 없는 백엔드)에서는 모드가 켜져 있어도 아무것도 열지 않는다. UI 도 같은
  // capability 로 모드 자체를 제안하지 않는다.
  if (!canLeadAgentTeam(ws)) return []
  return [...AGENT_BACKEND_IDS]
}

/**
 * 이 워크스페이스를 에이전트 팀으로 **바꿀 수 있는가**.
 *
 * delegateBackendsFor 에서 모드(ws.multiAgent)만 뺀 나머지 조건이다. 두 곳이 이것을 물어본다 —
 * 전환 도구는 거절할지 정하려고([[agent/tools/agentTeam]]), 세션 설정은 셸로 새려는 시도에
 * 무엇을 안내할지 정하려고([[agent/delegateShell]]). 조건을 각자 적으면 한쪽만 낡는다.
 *
 * 지금은 등록된 백엔드가 모두 조율할 수 있어 늘 참이지만, 게이트 자체는 남겨 둔다 — 위임 도구를
 * 꽂을 경로가 없는 백엔드가 새로 들어오면 여기 한 줄로 걸러진다.
 */
export function canLeadAgentTeam(ws: Workspace): boolean {
  return backendMeta(ws.agentBackend).capabilities.delegate
}

/**
 * 백엔드별 모델·effort 기본값. 위임받은 실행은 워크스페이스 오버라이드가 없으므로(워크스페이스가
 * 아니다) 전역 백엔드 설정을 그대로 따른다 — 사용자가 "Codex 는 xhigh 로" 라고 정해 두었으면
 * 위임된 Codex 도 그 값으로 돈다.
 */
export function agentDefaultsFor(
  settings: AppSettings
): Partial<Record<AgentBackendId, { model: string | null; effort: EffortSetting | null }>> {
  const out: Partial<
    Record<AgentBackendId, { model: string | null; effort: EffortSetting | null }>
  > = {}
  for (const id of AGENT_BACKEND_IDS) {
    const agent = agentSettingsFor(settings, id)
    out[id] = { model: agent.model, effort: agent.effort }
  }
  return out
}
