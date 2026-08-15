import type { PermissionMode } from '@shared/types'
import { COPILOT_SESSION_MODES } from './acp'

/**
 * Wooi 의 `PermissionMode` → Copilot 의 두 축.
 *
 * Copilot 은 권한을 **직교하는 두 축**으로 노출한다(실측: `session/new` 응답의 configOptions):
 *  - `mode`      — agent / plan / autopilot. 에이전트가 **무엇을 하려 하는지** 를 바꾼다.
 *  - `allow_all` — on / off. 승인 프롬프트를 **아예 끈다**.
 *
 * Claude 처럼 도구 프롬프트로 막는 것도, Codex 처럼 OS 샌드박스로 막는 것도 아니다. 그래서
 * 매핑은 둘의 조합이고, 아래 표의 근거는 전부 실측이다(CLI v1.0.80):
 *
 *  | Wooi         | Copilot                    | 실측한 동작                                    |
 *  |--------------|----------------------------|-----------------------------------------------|
 *  | `default`    | agent   + allow_all=off    | write 에 승인 요청(kind `edit`), read 는 자체 승인 |
 *  | `plan`       | plan                       | 워크스페이스 파일을 안 건드리고 세션 상태에만 계획을 쓴다 |
 *  | `fullAccess` | agent   + allow_all=on     | 승인 요청 없이 실행                              |
 *  | `auto`       | autopilot                  | 승인 없이 실행 + 완료까지 스스로 진행(experimental)   |
 *
 * **`readOnly`·`acceptEdits` 는 내보내지 않는다.** Copilot 에는 읽기 전용 강제가 없다 —
 * 흉내내려면 읽기 외 모든 도구를 클라이언트에서 거절해야 하는데, 그건 사용자가 기대하는
 * "묻는다"를 "조용히 거절한다"로 바꿔 버려 안 내놓느니만 못하다. `normalizePermissionMode` 가
 * 저장된 값을 `default` 로 떨어뜨리는데, 그 모드의 의미("읽기는 자유, 쓰기·실행은 묻는다")가
 * 마침 Codex `readOnly` 의 설명과 같으므로 사용자가 잃는 것이 없다.
 */
export interface CopilotModeSettings {
  /** `session/set_mode` 의 modeId. */
  modeId: string
  /** `session/set_config_option` 의 `allow_all` 값. */
  allowAll: boolean
}

export function copilotModeSettings(mode: PermissionMode): CopilotModeSettings {
  switch (mode) {
    case 'plan':
      // plan 은 allow_all 을 **강제로 off 로 되돌린다**(실측). 우리가 원하는 값과 같으므로
      // 굳이 거스르지 않는다.
      return { modeId: COPILOT_SESSION_MODES.plan, allowAll: false }
    case 'auto':
      // autopilot 은 자기 설명대로 allow-all 을 스스로 켠다. 그래도 명시적으로 켜 둔다 —
      // 앞선 모드에서 off 로 끌려 내려온 값이 남아 있을 수 있다.
      return { modeId: COPILOT_SESSION_MODES.autopilot, allowAll: true }
    case 'fullAccess':
      return { modeId: COPILOT_SESSION_MODES.agent, allowAll: true }
    // 'default' 와, 이 백엔드가 지원하지 않아 정규화로 흘러들 수 있는 나머지 값들.
    default:
      return { modeId: COPILOT_SESSION_MODES.agent, allowAll: false }
  }
}

/**
 * 이 모드에서 승인 카드를 띄울 필요가 있는가.
 *
 * `allow_all` 이 켜져 있으면 Copilot 이 `session/request_permission` 을 아예 보내지 않으므로
 * (실측) 이 값은 예측일 뿐이다. 그래도 필요한 이유는 **plan 의 방어선** 때문이다 —
 * [[copilot/session]] 이 plan 에서 읽기 외 요청을 거절하는 판단에 쓴다.
 */
export function isPlanMode(mode: PermissionMode): boolean {
  return mode === 'plan'
}
