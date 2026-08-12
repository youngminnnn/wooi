import { type AgentBackendId, type Workspace } from '@shared/types'
import { useAvailableBackends } from './backends'

/**
 * 멀티 에이전트 모드의 렌더러 쪽 해석.
 *
 * main 의 `delegateBackendsFor`(agent/multiAgent.ts)와 **같은 판단**을 되풀이한다. 왜 굳이
 * 되풀이하나: main 은 세션을 열 때 위임 도구를 실을지 정하고, 렌더러는 그 사실을 사용자에게
 * 보여 준다 — 두 쪽이 갈라지면 배지는 "멀티 에이전트" 라고 하는데 실제로는 위임이 안 되는,
 * 고치기 어려운 거짓말이 된다. 그래서 조건을 화면마다 흩지 않고 여기 한 곳에 둔다.
 */
export interface MultiAgentState {
  /**
   * 지금 **실제로** 팀인가. 화면은 이 값만 본다.
   *
   * "쓸 수 있는가" 를 따로 내주지 않는 것이 요점이다 — 켜는 UI 가 없기 때문이다. 켜는 것은
   * 대화가 맡고(switch_to_agent_team), 화면이 답할 질문은 "지금 팀인가" 하나뿐이다. 꺼진
   * 능력은 아무 데도 그리지 않는다.
   */
  active: boolean
  /**
   * 메인이 아닌, 이 워크스페이스에서 서브에이전트로 쓸 수 있는 종류들.
   *
   * 사이드바가 마크를 이어 붙이는 데 쓴다 — "여럿" 이라는 사실뿐 아니라 **무엇을** 쓸 수 있는지
   * 보여 주기 위해서다. 꺼져 있으면 빈 배열이다.
   */
  others: AgentBackendId[]
}

export function useMultiAgent(workspace: Workspace): MultiAgentState {
  const available = useAvailableBackends()
  // 위임 도구를 꽂을 경로가 있는 백엔드에서만(capabilities.delegate). 없으면 모드를 켜 봤자
  // 아무 일도 일어나지 않으므로 제안조차 하지 않는다.
  const canCoordinate = Boolean(
    available.find((b) => b.id === workspace.agentBackend)?.capabilities.delegate
  )
  // 에이전트가 하나뿐이면 팀이라고 말해 봐야 보여 줄 팀원이 없다 — 저장된 플래그가 켜져
  // 있어도(다른 머신에서 켰다거나, CLI 를 지웠다거나) 화면은 평범한 워크스페이스로 읽는다.
  const active = canCoordinate && available.length > 1 && workspace.multiAgent === true
  return {
    active,
    others: active ? available.filter((b) => b.id !== workspace.agentBackend).map((b) => b.id) : []
  }
}
