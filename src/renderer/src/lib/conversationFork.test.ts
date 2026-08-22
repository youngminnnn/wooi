import { describe, expect, it } from 'vitest'
import {
  areWorkspaceTreeSiblings,
  conversationForkDisabledReason,
  parseForkCommand
} from './conversationFork'

describe('conversationForkDisabledReason', () => {
  it('대화가 없으면 막는다', () => {
    expect(conversationForkDisabledReason({ sessionId: null, status: 'idle' })).toBe(
      'No conversation to fork yet'
    )
  })

  it('턴이 실행 중이면 막는다', () => {
    expect(conversationForkDisabledReason({ sessionId: 'session', status: 'running' })).toBe(
      'Wait for the current turn to finish'
    )
  })
})

describe('parseForkCommand', () => {
  it('이름을 그대로 생성 인자로 넘긴다', () => {
    expect(parseForkCommand('/fork my-idea')).toEqual({ name: 'my-idea' })
  })

  it('이름이 없으면 name 키를 만들지 않는다', () => {
    expect(parseForkCommand('/fork')).toEqual({})
  })
})

describe('areWorkspaceTreeSiblings', () => {
  const origin = {
    repoId: 'repo',
    archived: false,
    parentWorkspaceId: null,
    forkedFromWorkspaceId: null
  }

  it('fork 와 그 원본을 드래그 형제로 취급하지 않는다', () => {
    expect(
      areWorkspaceTreeSiblings(origin, {
        ...origin,
        forkedFromWorkspaceId: 'origin'
      })
    ).toBe(false)
  })
})
