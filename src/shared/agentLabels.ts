import type { AgentBackendMeta, EffortSetting, ModelOption } from './types'

/**
 * 모델·effort 값을 사람이 읽는 라벨로 바꾸는 순수 함수들.
 *
 * renderer 에만 두었던 것을 shared 로 올렸다 — 폰에 보내는 상태줄 라벨도 **랩탑이** 만들기
 * 때문이다(main/remote/mirror.ts). 폰은 모델 카탈로그도 전역 기본값도 모르므로 같은 문구를
 * 스스로 지어낼 수 없고, 지어내게 두면 두 화면이 갈린다.
 */

/**
 * ID 로 목록 항목을 찾는다. `[1m]` 접미사만 다른 값은 같은 모델로 본다 — 저장된 값이나 init 이
 * 알려 준 실제 모델명이 접미사 유무에서 갈릴 수 있는데(둘 다 동작은 같다), 그때 목록에 없는
 * 커스텀 모델처럼 보이면 라벨·지원 여부가 엉뚱해진다.
 */
export function findModelOption(models: ModelOption[], id: string): ModelOption | undefined {
  const bare = id.replace(/\[1m\]$/, '')
  return models.find((m) => m.id === id || m.id === bare || m.id === `${bare}[1m]`)
}

/** 모델 ID 를 친근한 라벨로. 목록에 없으면(카탈로그 조회 실패·구버전 저장값) ID 를 그대로. */
export function modelLabel(models: ModelOption[], id: string | null): string {
  if (!id) return 'Default'
  return findModelOption(models, id)?.label ?? id
}

/** effort 값을 친근한 라벨로. null(미지정)이면 "Model default". 목록에 없으면 ID 를 그대로. */
export function effortLabel(
  meta: AgentBackendMeta | undefined,
  effort: EffortSetting | null
): string {
  if (!effort) return 'Model default'
  return meta?.efforts.find((e) => e.id === effort)?.label ?? effort
}
