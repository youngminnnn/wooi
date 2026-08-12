import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatItem } from '@shared/types'
import { ClaudeSession } from './session'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

describe('ClaudeSession 알 수 없는 입력', () => {
  it('같은 모르는 assistant 블록을 한 번만 방출하고 저장한다', () => {
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
    const handleAssistant = (
      session as unknown as {
        handleAssistant: (message: Extract<SDKMessage, { type: 'assistant' }>) => void
      }
    ).handleAssistant.bind(session)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const message = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { id: 'api-1', content: [{ type: 'server_tool_use' }] }
    } as unknown as Extract<SDKMessage, { type: 'assistant' }>

    handleAssistant(message)
    handleAssistant(message)

    expect(
      events.filter((event) => event.type === 'item' && event.item.type === 'unknown')
    ).toHaveLength(1)
    expect(persisted.filter((item) => item.type === 'unknown')).toHaveLength(1)
    warn.mockRestore()
  })
})
