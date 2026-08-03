import {
  AGENT_BACKEND_IDS,
  agentSettingsFor,
  experimentsOf,
  type AgentBackendId,
  type AppSettings,
  type EffortSetting,
  type MultiAgentConfig,
  type Workspace
} from '@shared/types'

/**
 * 멀티 에이전트 위임 설정의 단일 해석 지점.
 *
 * 위임을 켤지 말지는 **워크스페이스 설정과 실험 스위치의 곱**이다. 두 조건을 세션 생성 경로마다
 * 따로 적으면, 실험을 껐는데 어느 백엔드에서만 위임 도구가 계속 실리는 식으로 갈라진다.
 */

/**
 * 이 워크스페이스가 지금 실제로 쓸 위임 설정. 쓸 수 없으면 null 이고, 그때 세션은 위임 도구를
 * 아예 노출하지 않는다.
 *
 * 실험 스위치를 여기서 보는 것이 요점이다 — 사용자가 실험을 끄면 이미 만들어 둔 멀티 에이전트
 * 워크스페이스도 다음 세션부터 평범한 단일 에이전트 워크스페이스로 돌아간다(설정은 남아 있으므로
 * 다시 켜면 그대로 살아난다).
 */
export function multiAgentFor(ws: Workspace, settings: AppSettings): MultiAgentConfig | null {
  if (!experimentsOf(settings).multiAgent) return null
  const configured = ws.multiAgent?.subBackends ?? []
  // 저장된 값에 모르는 백엔드가 섞여 있을 수 있다(다운그레이드·손편집). 모르는 값을 그대로
  // 도구 스키마의 enum 에 실으면 모델이 고를 수 있는 존재하지 않는 선택지가 된다.
  const subBackends = configured.filter((id) => AGENT_BACKEND_IDS.includes(id))
  return subBackends.length ? { subBackends } : null
}

/**
 * 워크스페이스 생성 인자의 위임 백엔드 목록을 저장할 설정으로 좁힌다. 쓸 것이 없으면 null 을
 * 돌려주고, 그러면 워크스페이스는 필드 자체가 없는 평범한 단일 에이전트 워크스페이스가 된다.
 *
 * **메인 백엔드 자신은 뺀다.** 같은 백엔드 작업은 네이티브 서브에이전트(Task·collab)가 맥락 공유·
 * 비용·속도 어느 쪽으로도 낫고, 위임 도구에 그 선택지를 남기면 모델이 둘 사이에서 헷갈린다.
 */
export function multiAgentConfigFrom(
  subBackends: AgentBackendId[] | undefined,
  mainBackend: AgentBackendId
): MultiAgentConfig | null {
  const picked = (subBackends ?? []).filter(
    (id) => id !== mainBackend && AGENT_BACKEND_IDS.includes(id)
  )
  // 같은 값을 두 번 넣어도(UI 실수·손편집) 도구 스키마의 enum 이 중복되지 않게 한다.
  const unique = [...new Set(picked)]
  return unique.length ? { subBackends: unique } : null
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
