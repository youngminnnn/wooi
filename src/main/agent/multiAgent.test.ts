import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../storeSchema'
import { AGENT_BACKEND_IDS, type AppSettings, type Workspace } from '@shared/types'
import { agentDefaultsFor, delegateBackendsFor } from './multiAgent'

/**
 * 위임이 열리는 조건은 **워크스페이스 모드 × 실험 스위치 × 메인 백엔드의 capability** 의 곱이다.
 * 어느 하나만 보고 판단하는 코드가 생기면, 실험을 껐는데 위임 도구가 계속 실리거나 조율할 수
 * 없는 백엔드에 도구가 실리는 식으로 갈라진다 — 그 곱을 여기서 못 박는다.
 */

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: 'w1', agentBackend: 'claude', ...patch } as Workspace
}

const EXPERIMENT_ON = settings({ experiments: { multiAgent: true } })
const EXPERIMENT_OFF = settings({ experiments: { multiAgent: false } })

describe('delegateBackendsFor', () => {
  it('모드가 켜져 있으면 등록된 모든 에이전트 종류를 연다', () => {
    // 화이트리스트가 아니라 모드다 — 어떤 종류를 쓸지는 대화에서 정해지므로, 미리 고른 목록으로
    // 좁히지 않는다. 메인 백엔드 자신도 빼지 않는다("Claude 서브에이전트 띄워줘"도 유효한 요청).
    expect(delegateBackendsFor(workspace({ multiAgent: true }), EXPERIMENT_ON)).toEqual(
      AGENT_BACKEND_IDS
    )
  })

  it('실험 스위치를 끄면 모드가 켜져 있어도 아무것도 열지 않는다', () => {
    // 워크스페이스 설정은 지우지 않으므로, 실험을 다시 켜면 그대로 살아난다.
    expect(delegateBackendsFor(workspace({ multiAgent: true }), EXPERIMENT_OFF)).toEqual([])
  })

  it('실험 항목이 통째로 없는 저장 설정(구버전)은 기본값을 따른다', () => {
    // 기본값이 켜짐이므로 기존 사용자도 선택지를 보게 된다. 그래도 **워크스페이스 모드**를
    // 따로 켜야 실제로 열리므로, 저장된 워크스페이스의 동작은 달라지지 않는다(아래 테스트).
    const legacy = { ...DEFAULT_SETTINGS, experiments: undefined } as AppSettings
    expect(delegateBackendsFor(workspace({ multiAgent: true }), legacy)).toEqual(AGENT_BACKEND_IDS)
    expect(delegateBackendsFor(workspace(), legacy)).toEqual([])
  })

  it('모드를 켜지 않은 기존 워크스페이스는 실험을 켜도 단일 에이전트다', () => {
    expect(delegateBackendsFor(workspace(), EXPERIMENT_ON)).toEqual([])
    expect(delegateBackendsFor(workspace({ multiAgent: false }), EXPERIMENT_ON)).toEqual([])
  })

  it('조율하는 쪽이 될 수 없는 백엔드에서는 모드가 켜져 있어도 아무것도 열지 않는다', () => {
    // Codex 는 아직 위임 도구를 꽂을 경로가 없다(capabilities.delegate=false). 도구를 실어 봤자
    // 아무 일도 일어나지 않으므로 아예 열지 않는다 — UI 도 같은 capability 로 모드를 감춘다.
    const codexMain = workspace({ agentBackend: 'codex', multiAgent: true })
    expect(delegateBackendsFor(codexMain, EXPERIMENT_ON)).toEqual([])
  })
})

describe('agentDefaultsFor', () => {
  it('위임받은 실행은 전역 백엔드 설정을 따른다', () => {
    // 위임 실행은 워크스페이스가 아니라 오버라이드가 없다. "Codex 는 xhigh 로" 같은 전역
    // 설정이 위임된 Codex 에도 적용되어야 한다.
    const s = settings({
      agents: {
        ...DEFAULT_SETTINGS.agents,
        codex: { model: 'gpt-5.5', effort: 'xhigh', permissionMode: null, fastMode: false }
      }
    })
    expect(agentDefaultsFor(s).codex).toEqual({ model: 'gpt-5.5', effort: 'xhigh' })
  })
})
