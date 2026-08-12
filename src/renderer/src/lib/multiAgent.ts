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
   * 이 워크스페이스에서 모드를 **쓸 수 있는가**. 에이전트가 둘 이상 있고, 메인 백엔드가 조율하는
   * 쪽이 될 수 있을 때만 참이다. 켜고 끄는 UI 를 노출할지 가른다.
   */
  canUse: boolean
  /** 지금 **실제로** 켜져 있는가. 배지·표시는 이 값만 본다. */
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
  const canUse = canCoordinate && available.length > 1
  const active = canUse && workspace.multiAgent === true
  return {
    canUse,
    active,
    others: active ? available.filter((b) => b.id !== workspace.agentBackend).map((b) => b.id) : []
  }
}
