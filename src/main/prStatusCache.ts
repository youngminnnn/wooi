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

/**
 * 조회 결과를 적어 둔다. 폰이 보는 값이 바뀌었으면 `true` — 부르는 쪽이 그때 상태를
 * 방송해 미러가 새 스냅샷을 올리게 한다.
 *
 * 비교는 **투영되는 필드만** 본다(mirror.ts 의 projectPr). url·needsBaseUpdate 는 폰에
 * 가지 않으므로 그것만 달라진 것으로 방송하면 아무것도 바꾸지 못하는 방송이 된다.
 * 제목이 비교에 들어 있는 것이 중요하다 — 사용자 지정 이름이 없는 워크스페이스에서는
 * PR 제목이 곧 표시 이름이라, 제목만 바뀌어도 폰의 이름이 낡는다.
 */
export function rememberPrStatus(workspaceId: string, status: PrStatus | null): boolean {
  const known = cache.has(workspaceId)
  const previous = cache.get(workspaceId) ?? null
  cache.set(workspaceId, status)
  return !known || !sameProjection(previous, status)
}

function sameProjection(a: PrStatus | null, b: PrStatus | null): boolean {
  if (a === null || b === null) return a === b
  return a.number === b.number && a.state === b.state && a.label === b.label && a.title === b.title
}

export function getCachedPrStatus(workspaceId: string): PrStatus | null | undefined {
  return cache.get(workspaceId)
}

export function forgetPrStatus(workspaceId: string): void {
  cache.delete(workspaceId)
}
