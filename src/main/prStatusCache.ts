import type { PrStatus } from '@shared/types'

/**
 * 워크스페이스별 PR 상태의 마지막 조회 결과.
 *
 * PR 상태는 `gh` 를 거쳐야 알 수 있어 **비동기이고 비싸다**. 렌더러는 이미 주기적으로
 * 조회하며 사이드바 점 색을 칠하고 있는데, 그 결과가 main 에는 남지 않아 원격 미러가
 * 같은 정보를 폰에 보낼 방법이 없었다.
 *
 * 미러는 dispatch 마다 **동기로** 도는 투영이라 여기서 gh 를 부를 수 없다. 그래서 조회를
 * 새로 하는 대신, 렌더러가 이미 시킨 조회의 답을 지나가는 길에 적어 둔다 — 네트워크 비용이
 * 0 이고, 렌더러의 폴링 주기가 곧 신선도가 된다.
 *
 * 값이 없는 것과 `null`(PR 이 없음)은 다르다. 전자는 "아직 모른다" 이고, 그때 폰은 PR 색을
 * 칠하지 않는다 — 모르는 것을 "PR 없음"으로 단정하면 색이 깜빡인다.
 */
const cache = new Map<string, PrStatus | null>()

export function rememberPrStatus(workspaceId: string, status: PrStatus | null): void {
  cache.set(workspaceId, status)
}

export function getCachedPrStatus(workspaceId: string): PrStatus | null | undefined {
  return cache.get(workspaceId)
}

export function forgetPrStatus(workspaceId: string): void {
  cache.delete(workspaceId)
}
