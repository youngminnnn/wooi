import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatItem } from '@shared/types'
import { ClaudeSession } from './session'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 사고 과정 블록은 대개 본문 없이 signature 만 온다 — 사람이 읽을 요약은 Claude Code 의
 * showThinkingSummaries 를 켰을 때만 내려온다. 그대로 실으면 펼쳐도 빈 카드만 쌓인다.
 */
function newSession(events: ChatEvent[], persisted: ChatItem[]): ClaudeSession {
  return new ClaudeSession({
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
}

function assistantWith(content: unknown[]): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    message: { id: 'api-1', content }
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>
}

function handle(session: ClaudeSession, message: Extract<SDKMessage, { type: 'assistant' }>): void {
  ;(
    session as unknown as {
      handleAssistant: (m: Extract<SDKMessage, { type: 'assistant' }>) => void
    }
  ).handleAssistant.bind(session)(message)
}

describe('ClaudeSession 사고 과정 블록', () => {
  it('본문 없이 signature 만 온 사고 과정은 남기지 않는다', () => {
    const events: ChatEvent[] = []
    const persisted: ChatItem[] = []
    handle(
      newSession(events, persisted),
      assistantWith([{ type: 'thinking', thinking: '', signature: 'CAISuAsKhwEIEBgC' }])
    )

    expect(persisted.filter((item) => item.type === 'thinking')).toHaveLength(0)
    expect(
      events.filter((event) => event.type === 'item' && event.item.type === 'thinking')
    ).toHaveLength(0)
  })

  it('요약이 실려 오면 그대로 남긴다', () => {
    const events: ChatEvent[] = []
    const persisted: ChatItem[] = []
    handle(
      newSession(events, persisted),
      assistantWith([{ type: 'thinking', thinking: 'Weighing two approaches.' }])
    )

    expect(persisted.filter((item) => item.type === 'thinking')).toMatchObject([
      { type: 'thinking', text: 'Weighing two approaches.' }
    ])
  })
})
