import { describe, expect, it } from 'vitest'
import type { SDKActiveGoalMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatItem } from '@shared/types'
import { ClaudeSession } from './session'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

function makeSession() {
  const events: ChatEvent[] = []
  const persisted: ChatItem[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    model: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact: false,
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    mcpSettings: { servers: [], disabledInherited: [] },
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    emit: (event) => events.push(event),
    persist: (item) => persisted.push(item),
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })
  const handle = (
    session as unknown as {
      handleMessage: (message: SDKMessage | SDKActiveGoalMessage) => void
    }
  ).handleMessage.bind(session)
  return { session, handle, events, persisted }
}

describe('Claude active_goal', () => {
  it('목표를 휘발성 이벤트로 매핑하고 트랜스크립트에는 쓰지 않는다', () => {
    const { handle, events, persisted } = makeSession()
    handle({
      type: 'active_goal',
      value: {
        condition: 'All checks pass',
        iterations: 3,
        set_at: 1,
        tokens_at_start: 2,
        last_reason: 'One test still fails'
      },
      uuid: '00000000-0000-0000-0000-000000000001',
      session_id: 'session-1'
    })

    expect(events).toContainEqual({
      type: 'goal',
      goal: {
        backend: 'claude',
        condition: 'All checks pass',
        iterations: 3,
        lastReason: 'One test still fails'
      }
    })
    expect(persisted).toEqual([])
  })

  it('value null과 세션 dispose가 목표를 제거한다', () => {
    const { session, handle, events } = makeSession()
    handle({
      type: 'active_goal',
      value: null,
      uuid: '00000000-0000-0000-0000-000000000002',
      session_id: 'session-1'
    })
    session.dispose()
    expect(events.filter((event) => event.type === 'goal' && event.goal === null)).toHaveLength(2)
  })
})
