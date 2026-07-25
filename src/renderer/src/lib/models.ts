/**
 * 선택 가능한 Claude 모델 목록 (정확한 모델 ID). Claude Code CLI 가 그대로 수용하는 값들이며,
 * `[1m]` 접미사는 1M 컨텍스트 변형이다. "Default" 항목은 두지 않는다.
 */
export interface ModelOption {
  id: string
  label: string
}

// 2026-07-25 기준 라인업. Fable 5 는 최상위 모델, Opus 5 는 에이전트/코딩용 권장 모델(둘 다 1M 컨텍스트 기본).
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5 (1M context)' },
  { id: 'claude-opus-5', label: 'Opus 5 (1M context)' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

const LABEL_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m.label]))

/** 모델 ID 를 친근한 라벨로. 목록에 없으면 ID 를 그대로 보여준다. */
export function modelLabel(id: string | null): string {
  if (!id) return MODEL_OPTIONS[0].label
  return LABEL_BY_ID.get(id) ?? id
}
