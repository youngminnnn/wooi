import { describe, it, expect } from 'vitest'
import { canSwitchAgentBackend } from './types'
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
    expect(canSwitchAgentBackend(ws(), 0)).toBe(true)
  })

  it('대화가 한 줄이라도 있으면 잠근다 — 맥락이 다른 CLI 로 이어지지 않는다', () => {
    expect(canSwitchAgentBackend(ws(), 1)).toBe(false)
  })

  it('세션이 열린 적 있으면(sessionId) 트랜스크립트가 비어 보여도 잠근다', () => {
    expect(canSwitchAgentBackend(ws({ sessionId: 'sess-1' }), 0)).toBe(false)
  })

  it('턴이 도는 중이거나 아카이브된 워크스페이스는 대상이 아니다', () => {
    expect(canSwitchAgentBackend(ws({ status: 'running' }), 0)).toBe(false)
    expect(canSwitchAgentBackend(ws({ archived: true }), 0)).toBe(false)
  })

  it('/clear 로 비운 워크스페이스는 다시 고를 수 있다(세션·기록이 모두 없다)', () => {
    expect(canSwitchAgentBackend(ws({ sessionId: null }), 0)).toBe(true)
  })
})
