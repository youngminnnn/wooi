import type { RunningAgent } from '@shared/types'

/**
 * 워크스페이스별 백그라운드 셸 수.
 *
 * 이 값은 AppState 에 없다 — 세션이 `agents` 이벤트로 방송하는 휘발성 값이라 렌더러 스토어에만
 * 쌓인다. 내장 도구는 AppState 만 보므로 그대로는 부모 에이전트에게 알려 줄 수 없다.
 *
 * 그래서 contextUsageCache 와 같은 수법을 쓴다 — 렌더러로 나가는 방송이 지나가는 길에 개수만
 * 적어 두고, 도구가 워크스페이스 상태를 설명할 때 동기로 읽는다. 비용은 Map 쓰기 하나다.
 */
const backgroundShells = new Map<string, number>()

export function rememberRunningAgents(workspaceId: string, agents: RunningAgent[]): void {
  // 렌더러의 backgroundTaskCount 와 같은 판단이어야 화면과 도구 결과가 갈리지 않는다.
  const count = agents.reduce((n, agent) => n + (typeof agent.taskType === 'string' ? 1 : 0), 0)
  if (count === 0) backgroundShells.delete(workspaceId)
  else backgroundShells.set(workspaceId, count)
}

export function backgroundShellCount(workspaceId: string): number {
  return backgroundShells.get(workspaceId) ?? 0
}

export function forgetRunningAgents(workspaceId: string): void {
  backgroundShells.delete(workspaceId)
}
