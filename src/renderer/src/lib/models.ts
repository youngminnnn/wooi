import { findModelOption } from '@shared/agentLabels'
import type { ModelOption } from '@shared/types'

/**
 * 모델 목록은 백엔드가 정한다 — Claude 는 검증된 정적 목록(main 의 agent/backend.ts),
 * Codex 는 app-server 의 `model/list` 응답이다. 렌더러는 store 의 `models` 슬라이스에서
 * 받아 쓰고, 이 모듈은 그 목록을 조회하는 헬퍼만 제공한다.
 *
 * 라벨 함수는 shared 에 있다(`@shared/agentLabels`) — 폰에 보내는 상태줄도 같은 문구를
 * 써야 해서 main 쪽 미러가 함께 쓴다. 여기서는 그대로 다시 내보낸다.
 */

export type { ModelOption }
export { compactModelLabel, modelLabel } from '@shared/agentLabels'

/**
 * 이 모델에서 fast mode 가 켜질 수 있는지(목록 기준). 목록에 없는 커스텀 ID 는 판단하지 않고
 * true 로 둔다 — 확실하지 않은데 "지원 안 함" 경고를 띄우면 오히려 오해를 준다. 실제 상태는
 * 세션이 보고하는 fastModeState 가 알려 준다.
 */
export function modelSupportsFastMode(models: ModelOption[], id: string | null): boolean {
  // 오버라이드가 없으면 실제 모델은 에이전트가 고른다. 확정할 수 없으므로 UI 를 막지 않는다.
  if (!id) return true
  const opt = findModelOption(models, id)
  return opt ? opt.fastMode === true : true
}
