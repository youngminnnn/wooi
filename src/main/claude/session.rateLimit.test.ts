import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

let queryCalls = 0

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    queryCalls++
    return {
      getContextUsage: async () => ({
        totalTokens: 1_000,
        percentage: 5,
        autoCompactThreshold: 100_000
      }),
      interrupt: async () => {},
      setPermissionMode: async () => {},
      async *[Symbol.asyncIterator]() {
        const first = await prompt.next()
        if (first.done) return
        yield { type: 'system', subtype: 'init', session_id: 'sess-limit', model: 'test-model' }
        yield {
          type: 'assistant',
          uuid: 'assistant-limit',
          session_id: 'sess-limit',
          error: 'unknown',
          message: {
            id: 'assistant-limit',
            content: [
              {
                type: 'text',
                text: "You've hit your session limit · resets 1:30am (Asia/Seoul)"
              }
            ]
          }
        }
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          uuid: 'result-limit',
          session_id: 'sess-limit',
          num_turns: 1,
          duration_ms: 1,
          total_cost_usd: 0
        }
      }
    }
  }
}))

beforeAll(() => {
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-session-limit-'))
})

describe('rateLimitResetAt', () => {
  const NOW = Date.parse('2026-08-10T00:00:00Z')

  it('CLI 가 덧붙인 epoch 를 해제 시각으로 읽는다', async () => {
    const { rateLimitResetAt } = await import('./session')
    const at = NOW + 2 * 60 * 60_000
    expect(rateLimitResetAt(`Claude AI usage limit reached|${Math.floor(at / 1000)}`, NOW)).toBe(at)
    expect(rateLimitResetAt(`usage limit reached|${at}`, NOW)).toBe(at)
  })

  it('과거·먼 미래·형식이 다른 값은 믿지 않는다', async () => {
    const { rateLimitResetAt } = await import('./session')
    expect(rateLimitResetAt('Claude AI usage limit reached|1600000000', NOW)).toBeNull()
    expect(
      rateLimitResetAt(`usage limit reached|${Math.floor(NOW / 1000) + 60 * 24 * 3600}`, NOW)
    ).toBeNull()
    expect(
      rateLimitResetAt("You've hit your session limit · resets 1:30am (Asia/Seoul)", NOW)
    ).toBeNull()
    expect(rateLimitResetAt(null, NOW)).toBeNull()
  })
})

describe('RATE_LIMIT_ERROR', () => {
  it('SDK assistant.error 의 rate_limit 코드도 제한으로 인식한다', async () => {
    const { RATE_LIMIT_ERROR } = await import('./session')
    expect(RATE_LIMIT_ERROR.test('Assistant error: rate_limit')).toBe(true)
  })
})

describe('ClaudeSession session limit handling', () => {
  it('알려진 session limit 오류를 새 프로세스에서 재시도하지 않는다', async () => {
    const { ClaudeSession } = await import('./session')
    queryCalls = 0
    const items: ChatItem[] = []

    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      mcpSettings: { servers: [], disabledInherited: [] },
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      peer: { name: 'wooi/repo/test', inbound: 'refuse' },
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp,
      emit: () => {},
      persist: (item) => items.push(item),
      requestPermission: async () => ({ behavior: 'deny' as const }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !items.some((item) => item.type === 'error')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    session.dispose()

    expect(queryCalls).toBe(1)
    expect(items.filter((item) => item.type === 'error')).toHaveLength(1)
    expect(
      items.some(
        (item) => item.type === 'assistant' && item.text.includes("You've hit your session limit")
      )
    ).toBe(true)
  })
})
