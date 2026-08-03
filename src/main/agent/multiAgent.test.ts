import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../storeSchema'
import type { AppSettings, Workspace } from '@shared/types'
import { agentDefaultsFor, multiAgentConfigFrom, multiAgentFor } from './multiAgent'

/**
 * 위임을 켤지 말지는 **워크스페이스 설정 × 실험 스위치**의 곱이다. 어느 한쪽만 보고 판단하는
 * 코드가 생기면, 실험을 껐는데 위임 도구가 계속 실리거나 그 반대가 된다 — 그 곱을 여기서 못 박는다.
 */

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: 'w1', agentBackend: 'claude', ...patch } as Workspace
}

describe('multiAgentConfigFrom', () => {
  it('메인 백엔드는 위임 대상에서 뺀다', () => {
    // 같은 백엔드 작업은 네이티브 서브에이전트가 맡는 편이 낫다. 도구 스키마에 남기면
    // 모델이 Task 와 위임 사이에서 헷갈린다.
    expect(multiAgentConfigFrom(['claude', 'codex'], 'claude')).toEqual({ subBackends: ['codex'] })
  })

  it('남는 것이 없으면 null — 워크스페이스에 필드 자체가 생기지 않는다', () => {
    expect(multiAgentConfigFrom(['claude'], 'claude')).toBeNull()
    expect(multiAgentConfigFrom([], 'claude')).toBeNull()
    expect(multiAgentConfigFrom(undefined, 'claude')).toBeNull()
  })

  it('중복과 모르는 백엔드를 걸러 낸다', () => {
    const unknown = 'gemini' as never
    expect(multiAgentConfigFrom(['codex', 'codex', unknown], 'claude')).toEqual({
      subBackends: ['codex']
    })
  })
})

describe('multiAgentFor', () => {
  const ws = workspace({ multiAgent: { subBackends: ['codex'] } })

  it('실험 스위치가 꺼져 있으면 설정이 있어도 null', () => {
    expect(multiAgentFor(ws, settings())).toBeNull()
  })

  it('실험 스위치를 켜면 저장된 설정이 그대로 살아난다', () => {
    const on = settings({ experiments: { multiAgent: true } })
    expect(multiAgentFor(ws, on)).toEqual({ subBackends: ['codex'] })
  })

  it('실험 항목이 통째로 없는 저장 설정(구버전)도 꺼진 것으로 읽는다', () => {
    const legacy = { ...DEFAULT_SETTINGS, experiments: undefined } as AppSettings
    expect(multiAgentFor(ws, legacy)).toBeNull()
  })

  it('위임 설정이 없는 기존 워크스페이스는 실험을 켜도 단일 에이전트다', () => {
    const on = settings({ experiments: { multiAgent: true } })
    expect(multiAgentFor(workspace(), on)).toBeNull()
  })

  it('저장된 값에 모르는 백엔드만 있으면 null', () => {
    const on = settings({ experiments: { multiAgent: true } })
    const bad = workspace({ multiAgent: { subBackends: ['gemini' as never] } })
    expect(multiAgentFor(bad, on)).toBeNull()
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
