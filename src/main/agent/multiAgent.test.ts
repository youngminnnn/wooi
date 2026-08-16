import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../storeSchema'
import { AGENT_BACKEND_IDS, type AppSettings, type Workspace } from '@shared/types'
import { backendMeta } from './backend'
import { markBackendAvailability } from './availability'
import { agentDefaultsFor, delegateBackendsFor } from './multiAgent'

/**
 * 위임이 열리는 조건은 **워크스페이스 모드 × 메인 백엔드의 capability** 의 곱이다. 어느 하나만
 * 보고 판단하는 코드가 생기면, Solo 인데 위임 도구가 실리거나 조율할 수 없는 백엔드에 도구가
 * 실리는 식으로 갈라진다 — 그 곱을 여기서 못 박는다.
 */

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: 'w1', agentBackend: 'claude', ...patch } as Workspace
}

describe('delegateBackendsFor', () => {
  it('모드가 켜져 있으면 등록된 모든 에이전트 종류를 연다', () => {
    // 화이트리스트가 아니라 모드다 — 어떤 종류를 쓸지는 대화에서 정해지므로, 미리 고른 목록으로
    // 좁히지 않는다. 메인 백엔드 자신도 빼지 않는다("Claude 서브에이전트 띄워줘"도 유효한 요청).
    expect(delegateBackendsFor(workspace({ multiAgent: true }))).toEqual(AGENT_BACKEND_IDS)
  })

  it('탐지 뒤 설치되지 않은 백엔드만 도구 목록에서 빠진다', () => {
    markBackendAvailability('copilot', false)
    expect(delegateBackendsFor(workspace({ multiAgent: true }))).toEqual(
      AGENT_BACKEND_IDS.filter((id) => id !== 'copilot')
    )
    // 모듈 스냅샷을 쓰는 다른 테스트에 상태가 새지 않게 원래의 fail-open 의미로 되돌린다.
    markBackendAvailability('copilot', true)
  })

  it('모드를 켜지 않은 워크스페이스는 단일 에이전트다', () => {
    // 플래그가 아예 없는 저장 워크스페이스(이 기능 이전 버전)도 같은 자리에 떨어진다.
    expect(delegateBackendsFor(workspace())).toEqual([])
    expect(delegateBackendsFor(workspace({ multiAgent: false }))).toEqual([])
  })

  it('Codex 도 메인이 될 수 있다', () => {
    // Claude 는 SDK 의 in-process MCP 서버로, Codex 는 thread/start 의 config 로 위임 도구를
    // 붙인다. 경로는 다르지만 열리는 것은 같아야 한다 — 메인을 무엇으로 골랐느냐에 따라 위임이
    // 되기도 하고 안 되기도 하면 사용자가 이유를 알 수 없다.
    const codexMain = workspace({ agentBackend: 'codex', multiAgent: true })
    expect(delegateBackendsFor(codexMain)).toEqual(AGENT_BACKEND_IDS)
  })

  it('조율할 수 없는 백엔드는 capability 로 걸러진다', () => {
    // 지금은 모든 백엔드가 조율할 수 있지만, 게이트 자체는 살아 있어야 한다 — 새 백엔드가
    // 붙었는데 위임 도구를 꽂을 경로가 없으면, 켜도 아무 일이 안 일어나는 스위치가 된다.
    const gated = AGENT_BACKEND_IDS.filter((id) => !backendMeta(id).capabilities.delegate)
    for (const id of gated) {
      expect(delegateBackendsFor(workspace({ agentBackend: id, multiAgent: true }))).toEqual([])
    }
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
