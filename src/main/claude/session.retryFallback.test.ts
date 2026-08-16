import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

class FakeQuery {
  private out = new AsyncQueue<Record<string, unknown>>()

  push(message: Record<string, unknown>): void {
    this.out.push(message)
  }
  async getContextUsage(): Promise<{
    totalTokens: number
    maxTokens: number
    percentage: number
    autoCompactThreshold: number
  }> {
    return { totalTokens: 1, maxTokens: 200_000, percentage: 0, autoCompactThreshold: 167_000 }
  }
  async interrupt(): Promise<void> {}
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let fake: FakeQuery
let queryOptions: Record<string, unknown>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    queryOptions = options
    return (fake = new FakeQuery())
  }
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('ClaudeSession API retry and fallback models', () => {
  beforeEach(() => {
    queryOptions = {}
  })

  it('재시도는 휘발 상태만 만들고 다음 스트림 이벤트에서 지운다', async () => {
    const { ClaudeSession } = await import('./session')
    const events: ChatEvent[] = []
    const persisted: ChatItem[] = []
    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      mcpSettings: { servers: [], disabledInherited: [] },
      model: 'claude-opus-5[1m]',
      fallbackModels: [],
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      peer: { name: 'wooi/repo/test', inbound: 'refuse' },
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp,
      emit: (event) => events.push(event),
      persist: (item) => persisted.push(item),
      requestPermission: async () => ({ behavior: 'deny', message: 'no' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')
    fake.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 1500,
      error_status: 529,
      error: 'overloaded_error',
      uuid: 'retry-1',
      session_id: 's1'
    })
    await settle()
    expect(events).toContainEqual({
      type: 'apiRetry',
      retry: { attempt: 2, maxRetries: 5, retryDelayMs: 1500, errorStatus: 529 }
    })
    expect(persisted.some((item) => item.id.includes('retry'))).toBe(false)

    fake.push({ type: 'system', subtype: 'status', status: null, uuid: 'next', session_id: 's1' })
    await settle()
    expect(events.at(-1)).toEqual({ type: 'apiRetry', retry: null })
    expect(persisted.some((item) => item.id.includes('retry'))).toBe(false)
    session.dispose()
  })

  it('fallbackModel 을 순서대로 넘기며 primary 와 중복은 제외한다', () => {
    return import('./session').then(({ ClaudeSession }) => {
      const session = new ClaudeSession({
        cwd: process.cwd(),
        repoPath: null,
        mcpSettings: { servers: [], disabledInherited: [] },
        model: 'claude-opus-5[1m]',
        fallbackModels: [
          'claude-opus-5[1m]',
          'claude-sonnet-4-6',
          'claude-haiku-4-5',
          'claude-sonnet-4-6'
        ],
        effort: null,
        fastMode: false,
        permissionMode: 'default',
        autoCompact: false,
        peer: { name: 'wooi/repo/test', inbound: 'refuse' },
        resumeSessionId: null,
        additionalDirs: [],
        wooiMcp,
        emit: () => {},
        persist: () => {},
        requestPermission: async () => ({ behavior: 'deny', message: 'no' }),
        onSessionId: () => {},
        onPermissionMode: () => {},
        settleIdle: () => {}
      })
      session.ensureLiveQuery()
      expect(queryOptions.fallbackModel).toBe('claude-sonnet-4-6,claude-haiku-4-5')
      session.dispose()
    })
  })

  it('assistant 가 보고한 실제 fallback 모델을 session 이벤트로 알린다', async () => {
    const { ClaudeSession } = await import('./session')
    const events: ChatEvent[] = []
    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      mcpSettings: { servers: [], disabledInherited: [] },
      model: 'claude-opus-5[1m]',
      fallbackModels: ['claude-sonnet-4-6'],
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      peer: { name: 'wooi/repo/test', inbound: 'refuse' },
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp,
      emit: (event) => events.push(event),
      persist: () => {},
      requestPermission: async () => ({ behavior: 'deny', message: 'no' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })
    session.send('hello')
    fake.push({
      type: 'system',
      subtype: 'init',
      session_id: 's-fallback',
      model: 'claude-opus-5[1m]',
      permissionMode: 'default'
    })
    fake.push({
      type: 'assistant',
      message: { id: 'a1', model: 'claude-sonnet-4-6', content: [] },
      parent_tool_use_id: null,
      uuid: 'a1',
      session_id: 's-fallback'
    })
    await settle()
    expect(events).toContainEqual({
      type: 'session',
      sessionId: 's-fallback',
      model: 'claude-sonnet-4-6',
      isFallback: true
    })
    session.dispose()
  })
})
