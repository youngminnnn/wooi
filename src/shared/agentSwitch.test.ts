import { describe, it, expect } from 'vitest'
import { agentSwitchNeedsHandoff, canSwitchAgentBackend } from './types'
import type { Workspace } from './types'

const ws = (
  over: Partial<Workspace> = {}
): Pick<Workspace, 'archived' | 'sessionId' | 'status'> => ({
  archived: false,
  sessionId: null,
  status: 'idle',
  ...over
})

describe('canSwitchAgentBackend', () => {
  it('아무것도 보내지 않은 워크스페이스에서는 에이전트를 바꿀 수 있다', () => {
    expect(canSwitchAgentBackend(ws())).toBe(true)
  })

  it('대화가 오간 뒤에도 바꿀 수 있다 — 대신 인수인계 비용을 경고받는다', () => {
    expect(canSwitchAgentBackend(ws({ sessionId: 'sess-1' }))).toBe(true)
  })

  it('턴이 도는 중이거나 아카이브된 워크스페이스는 대상이 아니다', () => {
    expect(canSwitchAgentBackend(ws({ status: 'running' }))).toBe(false)
    expect(canSwitchAgentBackend(ws({ archived: true }))).toBe(false)
  })
})

describe('agentSwitchNeedsHandoff', () => {
  it('아무것도 보내지 않았으면 넘길 맥락이 없다 — 경고도 비용도 없이 바꾼다', () => {
    expect(agentSwitchNeedsHandoff(ws(), 0)).toBe(false)
  })

  it('대화가 한 줄이라도 있으면 넘겨야 한다 — 새 에이전트는 세션을 물려받지 못한다', () => {
    expect(agentSwitchNeedsHandoff(ws(), 1)).toBe(true)
  })

  it('세션이 열린 적 있으면(sessionId) 트랜스크립트가 비어 보여도 경고한다', () => {
    expect(agentSwitchNeedsHandoff(ws({ sessionId: 'sess-1' }), 0)).toBe(true)
  })

  it('/clear 로 비운 워크스페이스는 다시 맨 처음과 같다(세션·기록이 모두 없다)', () => {
    expect(agentSwitchNeedsHandoff(ws({ sessionId: null }), 0)).toBe(false)
  })
})
