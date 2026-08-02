import type { ModelOption } from '@shared/types'

/**
 * 모델 목록은 백엔드가 정한다 — Claude 는 검증된 정적 목록(main 의 agent/backend.ts),
 * Codex 는 app-server 의 `model/list` 응답이다. 렌더러는 store 의 `models` 슬라이스에서
 * 받아 쓰고, 이 모듈은 그 목록을 조회하는 헬퍼만 제공한다.
 */

export type { ModelOption }

/**
 * ID 로 목록 항목을 찾는다. `[1m]` 접미사만 다른 값은 같은 모델로 본다 — 저장된 값이나 init 이
 * 알려 준 실제 모델명이 접미사 유무에서 갈릴 수 있는데(둘 다 동작은 같다), 그때 목록에 없는
 * 커스텀 모델처럼 보이면 라벨·지원 여부가 엉뚱해진다.
 */
function findOption(models: ModelOption[], id: string): ModelOption | undefined {
  const bare = id.replace(/\[1m\]$/, '')
  return models.find((m) => m.id === id || m.id === bare || m.id === `${bare}[1m]`)
}

/** 모델 ID 를 친근한 라벨로. 목록에 없으면(카탈로그 조회 실패·구버전 저장값) ID 를 그대로. */
export function modelLabel(models: ModelOption[], id: string | null): string {
  if (!id) return 'Default'
  return findOption(models, id)?.label ?? id
}

/**
 * 이 모델에서 fast mode 가 켜질 수 있는지(목록 기준). 목록에 없는 커스텀 ID 는 판단하지 않고
 * true 로 둔다 — 확실하지 않은데 "지원 안 함" 경고를 띄우면 오히려 오해를 준다. 실제 상태는
 * 세션이 보고하는 fastModeState 가 알려 준다.
 */
export function modelSupportsFastMode(models: ModelOption[], id: string | null): boolean {
  // 오버라이드가 없으면 실제 모델은 에이전트가 고른다. 확정할 수 없으므로 UI 를 막지 않는다.
  if (!id) return true
  const opt = findOption(models, id)
  return opt ? opt.fastMode === true : true
}
