/**
 * 선택 가능한 Claude 모델 목록 (정확한 모델 ID). Claude Code CLI 가 그대로 수용하는 값들이며,
 * `[1m]` 접미사는 1M 컨텍스트 변형이다. "Default" 항목은 두지 않는다.
 */
export interface ModelOption {
  id: string
  label: string
  /**
   * Claude Code 모델 레지스트리에서 `fast_mode` capability 를 가진 모델인지(= `/fast` 가 실제로
   * 켜지는 모델). 2.1.220 레지스트리 기준 opus-5·opus-4-8·opus-4-7 뿐이며, 나머지 모델에서
   * fast mode 를 켜 두면 CLI 가 조용히 표준 속도로 돌린다.
   */
  fastMode?: true
}

/**
 * 2026-07-29 기준 라인업. 라벨의 컨텍스트 크기는 추정이 아니라 Claude Code 가 각 ID 에 대해
 * 실제로 잡는 윈도다(모델 레지스트리 + 실측 modelUsage.contextWindow 로 확인).
 *
 * 라벨에는 **기본값과 다른 것만** 적는다 — 200K 는 모델의 기본 윈도라 굳이 표기하지 않고,
 * 1M 인 모델에만 `(1M context)` 를 붙인다.
 *
 * `[1m]` 접미사: 예전에는 opus-5 만 접미사가 없으면 200K 였지만(레지스트리에 미등재라 기본값을
 * 쓰던 시기), CLI 2.1.220 의 레지스트리부터 opus-5 도 `native_1m` 으로 등재돼 접미사 없이도 1M 이다
 * (`claude-opus-5` 실측 1,000,000). 두 ID 의 동작이 같아졌으므로 Opus 5 는 한 항목으로 합쳤고,
 * 이미 널리 퍼진 접미사 붙은 값(기본 모델·v9→v10 마이그레이션 결과)을 그대로 쓴다 — 반대로 합치면
 * 모든 사용자의 저장값을 다시 옮겨야 한다.
 */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5 (1M context)' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)', fastMode: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (1M context)', fastMode: true },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (1M context)', fastMode: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (1M context)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

const OPTION_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m]))

/**
 * ID 로 목록 항목을 찾는다. `[1m]` 접미사만 다른 값은 같은 모델로 본다 — 저장된 값이나 init 이
 * 알려 준 실제 모델명이 접미사 유무에서 갈릴 수 있는데(둘 다 동작은 같다), 그때 목록에 없는
 * 커스텀 모델처럼 보이면 라벨·지원 여부가 엉뚱해진다.
 */
function findOption(id: string): ModelOption | undefined {
  const bare = id.replace(/\[1m\]$/, '')
  return OPTION_BY_ID.get(id) ?? OPTION_BY_ID.get(bare) ?? OPTION_BY_ID.get(`${bare}[1m]`)
}

/**
 * 모델을 고르지 않았을 때(=오버라이드 없음) 쓰는 라벨. 터미널 `claude` 의 모델 선택기 첫 항목과
 * 같은 뜻이다 — CLI 가 계정 기본 모델과 사용량 인지 라우팅을 그대로 적용한다.
 */
export const DEFAULT_MODEL_LABEL = 'Default'

/** 위 항목의 설명. 선택 카드 hint 와 Settings 의 <option> 라벨이 같은 문구를 쓰도록 여기에 둔다. */
export const DEFAULT_MODEL_HINT = 'Your Claude account default — usage-aware routing'

/** 모델 ID 를 친근한 라벨로. null 은 "오버라이드 없음", 목록에 없으면 ID 를 그대로 보여준다. */
export function modelLabel(id: string | null): string {
  if (!id) return DEFAULT_MODEL_LABEL
  return findOption(id)?.label ?? id
}

/**
 * 이 모델에서 fast mode 가 켜질 수 있는지(목록 기준). 목록에 없는 커스텀 ID 는 판단하지 않고
 * true 로 둔다 — 확실하지 않은데 "지원 안 함" 경고를 띄우면 오히려 오해를 준다. 실제 상태는
 * 세션이 보고하는 fastModeState 가 알려 준다.
 *
 * null(오버라이드 없음)도 같은 이유로 true 다 — 어떤 모델로 돌지는 CLI 가 정하므로 여기서
 * 단정할 수 없다. 첫 턴이 끝나면 workspace.lastModel 이 실제 모델을 알려 주고, 그때부터는
 * 그 값으로 판단된다.
 */
export function modelSupportsFastMode(id: string | null): boolean {
  if (!id) return true
  const opt = findOption(id)
  return opt ? opt.fastMode === true : true
}
