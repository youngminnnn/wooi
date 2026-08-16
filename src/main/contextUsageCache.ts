/**
 * 워크스페이스별 컨텍스트 사용량과 압축 진행 상태.
 *
 * 이 값들은 AppState 에 없다 — 턴이 끝날 때마다 바뀌는 휘발성 값이라 디스크에 영속하지 않고,
 * 세션이 채팅 이벤트(`context`·`compacting`)로 방송하면 렌더러 스토어에만 쌓인다. 원격 미러는
 * AppState 만 보므로 그대로는 폰에 보낼 것이 없다.
 *
 * 그래서 prStatusCache 와 같은 수법을 쓴다 — 렌더러로 나가는 방송이 지나가는 길에 적어 두고,
 * 미러가 투영할 때 동기로 읽는다. 비용은 Map 쓰기 하나다.
 */
export interface CachedContextUsage {
  usedTokens: number
  maxTokens: number
  percentage: number
}

const usage = new Map<string, CachedContextUsage>()
const compacting = new Set<string>()

/**
 * 사용량을 적어 둔다. 폰이 보는 값이 바뀌었으면 `true` — 부르는 쪽이 그때만 상태를 방송해,
 * 같은 값을 다시 받은 것으로 미러를 깨우지 않는다.
 */
export function rememberContextUsage(workspaceId: string, next: CachedContextUsage): boolean {
  const previous = usage.get(workspaceId)
  usage.set(workspaceId, next)
  return (
    previous === undefined ||
    previous.usedTokens !== next.usedTokens ||
    previous.maxTokens !== next.maxTokens ||
    previous.percentage !== next.percentage
  )
}

/** 압축 진행 여부를 적어 둔다. 바뀌었으면 `true`. */
export function rememberCompacting(workspaceId: string, active: boolean): boolean {
  const previous = compacting.has(workspaceId)
  if (previous === active) return false
  if (active) compacting.add(workspaceId)
  else compacting.delete(workspaceId)
  return true
}

export function getCachedContextUsage(workspaceId: string): CachedContextUsage | undefined {
  return usage.get(workspaceId)
}

export function isCompacting(workspaceId: string): boolean {
  return compacting.has(workspaceId)
}

/**
 * 맥락이 처음부터 다시 시작할 때 지운다(대화 비우기·에이전트 교체). 지우지 않으면 새 세션이
 * 첫 사용량을 보고할 때까지 게이지가 옛 대화의 양을 가리킨다 — 데스크톱도 같은 자리에서
 * 스토어의 사용량을 지운다.
 */
export function forgetContextUsage(workspaceId: string): void {
  usage.delete(workspaceId)
  compacting.delete(workspaceId)
}
