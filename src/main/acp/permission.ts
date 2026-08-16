import type * as acp from '@agentclientprotocol/sdk'

/**
 * ACP 승인 요청에 돌려줄 선택지를 고른다.
 *
 * ACP 는 결정을 boolean 이 아니라 **에이전트가 제시한 선택지 중 하나**로 받는다. 그래서 "허용"
 * 하나에도 에이전트마다 다른 optionId 가 온다. 이 모듈이 그 번역을 맡는다.
 *
 * 요점은 **어떤 kind 도 있다고 가정하지 않는 것**이다. `PermissionOptionKind` 네 가지가 스펙에는
 * 있지만 실제로 넷을 다 보내는 에이전트만 있는 게 아니다(실측: GitHub Copilot CLI 는
 * `reject_always` 를 아예 보내지 않는다). 없는 kind 를 찾아 `undefined!` 를 되돌리면 그 턴이
 * 조용히 멈춘다 — 에이전트는 답을 기다리는데 우리가 보낸 optionId 가 목록에 없기 때문이다.
 *
 * 그래서 세 단계로 내려간다: 정확한 kind → 같은 방향(허용/거절)의 다른 kind → 취소.
 * **마지막 단계가 `cancelled` 인 것이 중요하다.** 취소는 스펙이 정의한 정상 응답이라 에이전트가
 * 턴을 접을 수 있다. 아무 선택지나 찍어 보내는 것보다 훨씬 낫다 — 거절하려던 사용자의 뜻이
 * 허용으로 뒤집히는 일은 없어야 한다.
 */

/** 사용자가 고른 방향. `always` 는 같은 도구를 이 세션 동안 다시 묻지 않는다는 뜻이다. */
export type AcpPermissionChoice = 'allow' | 'allowAlways' | 'reject' | 'rejectAlways'

/** 각 선택 방향이 받아들일 kind 를, 선호하는 순서대로. */
const PREFERRED: Record<AcpPermissionChoice, acp.PermissionOptionKind[]> = {
  // 넓히는 방향(always)은 좁은 쪽(once)으로 **강등**될 수 있다 — 한 번 더 묻게 될 뿐 안전하다.
  allowAlways: ['allow_always', 'allow_once'],
  allow: ['allow_once', 'allow_always'],
  // 거절은 반대로 좁은 쪽을 먼저 본다. 사용자가 "이번만 거절"을 골랐는데 영구 거절로
  // 넓히면 나중에 조용히 막히는 도구가 생긴다.
  reject: ['reject_once', 'reject_always'],
  rejectAlways: ['reject_always', 'reject_once']
}

/**
 * 선택 방향에 맞는 optionId 를 찾는다. 못 찾으면 null — 호출부는 `cancelled` 로 답해야 한다.
 *
 * kind 를 아예 안 채우거나 비표준 값을 채우는 에이전트를 위해, kind 로 못 찾으면 optionId
 * 문자열도 훑는다(`allow`·`reject`/`deny` 접두 관용). 그래도 없으면 포기한다 — 여기서
 * "아무거나 첫 번째"를 고르면 거절이 허용으로 뒤집힐 수 있다.
 */
export function pickPermissionOptionId(
  options: readonly acp.PermissionOption[],
  choice: AcpPermissionChoice
): string | null {
  for (const kind of PREFERRED[choice]) {
    const match = options.find((option) => option.kind === kind)
    if (match) return match.optionId
  }

  const allowing = choice === 'allow' || choice === 'allowAlways'
  const byId = options.find((option) => {
    const id = option.optionId.toLowerCase()
    return allowing
      ? id.startsWith('allow') || id.startsWith('accept') || id.startsWith('approve')
      : id.startsWith('reject') || id.startsWith('deny') || id.startsWith('decline')
  })
  return byId?.optionId ?? null
}

/**
 * 승인 요청에 그대로 돌려줄 수 있는 응답을 만든다. 맞는 선택지가 없으면 `cancelled` 다.
 */
export function permissionOutcome(
  options: readonly acp.PermissionOption[],
  choice: AcpPermissionChoice
): acp.RequestPermissionResponse {
  const optionId = pickPermissionOptionId(options, choice)
  return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
}
