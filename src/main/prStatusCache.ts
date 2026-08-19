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
 * 비교는 **투영되는 필드 전부**를 본다(mirror.ts 의 projectPr). 예전에는 number·state·label·
 * title 만 봤는데, 그 사이 투영이 url·needsBaseUpdate 까지 싣도록 넓어졌다 — 그래서 base 가
 * 뒤처지거나(BEHIND) 그 상태가 풀려도 방송이 없어, 폰의 "Update branch" 표시가 무관한 다른
 * 변화가 생길 때까지 낡은 채로 남았다.
 *
 * 제목이 비교에 들어 있는 것도 중요하다 — 사용자 지정 이름이 없는 워크스페이스에서는
 * PR 제목이 곧 표시 이름이라, 제목만 바뀌어도 폰의 이름이 낡는다.
 *
 * 투영을 넓힐 때는 여기도 같이 넓혀야 한다. 반대로 좁힐 때도 마찬가지다 — 안 가는 값으로
 * 방송하면 아무것도 바꾸지 못하는 방송이 워크스페이스 수만큼 반복된다.
 */
export function rememberPrStatus(workspaceId: string, status: PrStatus | null): boolean {
  const known = cache.has(workspaceId)
  const previous = cache.get(workspaceId) ?? null
  cache.set(workspaceId, status)
  return !known || !sameProjection(previous, status)
}

function sameProjection(a: PrStatus | null, b: PrStatus | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.label === b.label &&
    a.title === b.title &&
    a.url === b.url &&
    a.needsBaseUpdate === b.needsBaseUpdate
  )
}

export function getCachedPrStatus(workspaceId: string): PrStatus | null | undefined {
  return cache.get(workspaceId)
}

export function forgetPrStatus(workspaceId: string): void {
  cache.delete(workspaceId)
}
