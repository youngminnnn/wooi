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

describe('ClaudeSession session limit handling', () => {
  it('알려진 session limit 오류를 새 프로세스에서 재시도하지 않는다', async () => {
    const { ClaudeSession } = await import('./session')
    queryCalls = 0
    const items: ChatItem[] = []

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
