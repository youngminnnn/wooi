import { fastModeReasonText } from '@shared/types'
import type { FastModeDisabledReason, FastModeState } from '@shared/types'

/**
 * Claude Code 의 fast mode(터미널 CLI 의 `/fast`) 선택값 표시 도우미.
 *
 * 값은 3 가지다 — workspace 오버라이드 On/Off, 그리고 null(전역 설정을 따름).
 * fast mode 는 **같은 모델을 더 빠른 출력 속도로** 돌리는 옵션이라 품질이 내려가지 않지만,
 * 모델 레지스트리에서 fast_mode 를 지원하는 모델(Opus 5·4.8 계열)과 유료 플랜/크레딧이 필요하고
 * 전용 rate limit 이 따로 있다.
 *
 * **비용**: 속도만 바뀌는 게 아니라 단가가 오른다 — Opus 5 기준 표준 $5/$25 → fast $10/$50 로
 * 약 2 배다. 같은 작업을 해도 사용량이 두 배로 잡히므로, 원클릭 토글 옆에 반드시 표시한다.
 */
export const FAST_MODE_HINT = 'Same model, faster output · ~2× token cost · Opus 5 / 4.8, paid plan'

/** 설정값(On/Off/전역 따름)을 라벨로. */
export function fastModeLabel(fastMode: boolean | null): string {
  if (fastMode === null) return 'Default'
  return fastMode ? 'On' : 'Off'
}

/**
 * 상태줄에 보여 줄 텍스트. 설정이 아니라 **실제 상태**를 우선한다 — 켜 뒀어도 미지원 모델·플랜
 * 제한이면 표준 속도로 돌고, rate limit 을 넘기면 쿨다운 동안 잠시 꺼진다.
 * 아직 턴을 돌리지 않아 실제 상태를 모르면(null) 설정값을 그대로 보여 준다.
 */
export function fastModeStatus(
  enabled: boolean,
  state: FastModeState | null,
  reason: FastModeDisabledReason | null
): { text: string; active: boolean; title: string } {
  if (state === 'cooldown') {
    return {
      text: 'Fast (cooling down)',
      active: false,
      title: 'Fast mode hit its rate limit — running at standard speed until it resets'
    }
  }
  if (state === 'on') {
    return { text: 'Fast', active: true, title: 'Fast mode is on — same model, faster output' }
  }
  if (state === 'off' && enabled) {
    // CLI 가 이유를 알려 준 경우 그대로 쓰고, 없으면(모델 미지원이 대부분) 일반 안내를 쓴다.
    return { text: 'Fast (unavailable)', active: false, title: fastModeReasonText(reason) }
  }
  return enabled
    ? { text: 'Fast', active: true, title: `Fast mode: on — ${FAST_MODE_HINT}` }
    : { text: 'Standard', active: false, title: `Fast mode: off — ${FAST_MODE_HINT}` }
}
