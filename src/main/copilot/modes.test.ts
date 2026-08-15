import { describe, expect, it } from 'vitest'
import { normalizePermissionMode } from '@shared/types'
import { COPILOT_META } from '../agent/backend'
import { COPILOT_SESSION_MODES } from './acp'
import { copilotModeSettings, isPlanMode } from './modes'

describe('copilotModeSettings', () => {
  it('실측한 네 조합을 그대로 옮긴다', () => {
    expect(copilotModeSettings('default')).toEqual({
      modeId: COPILOT_SESSION_MODES.agent,
      allowAll: false
    })
    expect(copilotModeSettings('plan')).toEqual({
      modeId: COPILOT_SESSION_MODES.plan,
      allowAll: false
    })
    expect(copilotModeSettings('fullAccess')).toEqual({
      modeId: COPILOT_SESSION_MODES.agent,
      allowAll: true
    })
    expect(copilotModeSettings('auto')).toEqual({
      modeId: COPILOT_SESSION_MODES.autopilot,
      allowAll: true
    })
  })

  // 승인을 없애는 두 모드는 성격이 다르다 — fullAccess 는 대화형 에이전트 그대로이고,
  // autopilot 은 완료까지 스스로 진행한다. 같은 modeId 로 접히면 그 차이가 사라진다.
  it('fullAccess 와 autopilot 을 한 모드로 접지 않는다', () => {
    expect(copilotModeSettings('fullAccess').modeId).not.toBe(copilotModeSettings('auto').modeId)
  })

  // Copilot 에 대응 개념이 없어 메타에서 뺀 값들. 정규화가 default 로 떨어뜨리므로 실제로는
  // 세션까지 오지 않지만, 흘러들어도 가장 좁은 조합을 고르는지 못 박는다.
  it('지원하지 않는 모드가 흘러들면 가장 좁은 조합으로 떨어진다', () => {
    expect(copilotModeSettings('readOnly')).toEqual({
      modeId: COPILOT_SESSION_MODES.agent,
      allowAll: false
    })
    expect(copilotModeSettings('acceptEdits')).toEqual({
      modeId: COPILOT_SESSION_MODES.agent,
      allowAll: false
    })
  })
})

describe('COPILOT_META 의 권한 모드', () => {
  it('저장된 readOnly·acceptEdits 는 default 로 정규화된다', () => {
    expect(normalizePermissionMode(COPILOT_META, 'readOnly')).toBe('default')
    expect(normalizePermissionMode(COPILOT_META, 'acceptEdits')).toBe('default')
  })

  it('메타의 모든 모드가 실제 조합을 갖는다', () => {
    for (const mode of COPILOT_META.permissionModes) {
      expect(Object.values(COPILOT_SESSION_MODES)).toContain(copilotModeSettings(mode.id).modeId)
    }
  })

  it('자동 모드는 autopilot 이다', () => {
    expect(COPILOT_META.autonomousPermissionMode).toBe('auto')
    expect(copilotModeSettings('auto').modeId).toBe(COPILOT_SESSION_MODES.autopilot)
  })
})

describe('isPlanMode', () => {
  it('plan 에서만 참 — 승인 경계의 마지막 방어선을 가른다', () => {
    expect(isPlanMode('plan')).toBe(true)
    expect(isPlanMode('default')).toBe(false)
    expect(isPlanMode('auto')).toBe(false)
    expect(isPlanMode('fullAccess')).toBe(false)
  })
})
