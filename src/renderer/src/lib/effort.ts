import type { AgentBackendMeta, EffortOptionInfo, ModelOption } from '@shared/types'

export type { EffortOptionInfo as EffortOption }

/**
 * reasoning effort 선택지도 백엔드가 선언한다(main 의 agent 레지스트리 → IPC).
 * Codex 는 모델마다 지원 단계가 달라 `model/list` 가 모델별 목록을 주므로, 모델이 자기 목록을
 * 갖고 있으면 그쪽으로 좁힌다.
 */

/** 이 백엔드·모델에서 고를 수 있는 effort 목록. */
export function effortOptionsFor(
  meta: AgentBackendMeta | undefined,
  model?: ModelOption
): EffortOptionInfo[] {
  const all = meta?.efforts ?? []
  if (!model?.efforts?.length) return all
  const allowed = new Set(model.efforts)
  const narrowed = all.filter((e) => allowed.has(e.id))
  // 모델이 알려 준 단계를 백엔드 목록이 하나도 설명하지 못하면(카탈로그가 앞서간 경우)
  // 좁히지 않고 전체를 보여 준다 — 선택지가 통째로 사라지는 것보다 낫다.
  return narrowed.length ? narrowed : all
}

/**
 * effort 라벨은 shared 에 있다(`@shared/agentLabels`) — 폰에 보내는 상태줄도 같은 문구를
 * 써야 해서 main 쪽 미러가 함께 쓴다. 여기서는 그대로 다시 내보낸다.
 */
export { effortLabel } from '@shared/agentLabels'
