import type { EffortSetting } from '@shared/types'

/**
 * 선택 가능한 reasoning effort 단계. Claude Code CLI 의 effort 선택기와 동일한 값들이며,
 * 낮을수록 빠르고 높을수록 깊게 추론한다. xhigh·max·ultracode 는 일부 최신 모델만 지원하고,
 * 지원하지 않는 모델에서는 CLI 가 조용히 낮춰서 적용한다.
 *
 * 'ultracode' 는 effort 레벨이 아니라 별도 모드(xhigh + 상시 동적 워크플로우 조율)지만,
 * CLI 처럼 effort 선택기의 'max' 다음 항목으로 함께 노출한다.
 */
export interface EffortOption {
  id: EffortSetting
  label: string
  /** 드롭다운 옵션의 보조 설명. */
  hint: string
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low', label: 'Low', hint: 'Fastest, minimal thinking' },
  { id: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { id: 'high', label: 'High', hint: 'Deep reasoning (model default)' },
  { id: 'xhigh', label: 'Extra high', hint: 'Deeper than high (newer models)' },
  { id: 'max', label: 'Max', hint: 'Maximum effort (select models)' },
  { id: 'ultracode', label: 'Ultracode', hint: 'xhigh + always-on workflow orchestration' }
]

const LABEL_BY_ID = new Map(EFFORT_OPTIONS.map((e) => [e.id, e.label]))

/** effort 값을 친근한 라벨로. null(미지정)이면 "Model default". 목록에 없으면 ID 를 그대로. */
export function effortLabel(effort: EffortSetting | null): string {
  if (!effort) return 'Model default'
  return LABEL_BY_ID.get(effort) ?? effort
}
