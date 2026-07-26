/**
 * 선택 가능한 Claude 모델 목록 (정확한 모델 ID). Claude Code CLI 가 그대로 수용하는 값들이며,
 * `[1m]` 접미사는 1M 컨텍스트 변형이다. "Default" 항목은 두지 않는다.
 */
export interface ModelOption {
  id: string
  label: string
}

/**
 * 2026-07-25 기준 라인업. 라벨의 컨텍스트 크기는 추정이 아니라 Claude Code 가 각 ID 에 대해
 * 실제로 잡는 윈도다(Agent SDK 의 getContextUsage().maxTokens 로 확인).
 *
 * 주의: `[1m]` 접미사가 필요한지는 모델마다 다르다.
 * - opus-4-8 / opus-4-7 / fable-5 : 접미사 없이도 1M (접미사를 붙여도 동일)
 * - **opus-5 : 접미사가 없으면 200K** — 1M 을 쓰려면 `claude-opus-5[1m]` 이어야 한다.
 * 잘못 고르면 컨텍스트 예산이 5 배 좁아져 대화가 그만큼 빨리 압축되므로, 라벨을 실제 값에 맞춘다.
 */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5 (1M context)' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  { id: 'claude-opus-5', label: 'Opus 5 (200K context)' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (1M context)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (1M context)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (1M context)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (200K context)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (200K context)' }
]

const LABEL_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m.label]))

/** 모델 ID 를 친근한 라벨로. 목록에 없으면 ID 를 그대로 보여준다. */
export function modelLabel(id: string | null): string {
  if (!id) return MODEL_OPTIONS[0].label
  return LABEL_BY_ID.get(id) ?? id
}
