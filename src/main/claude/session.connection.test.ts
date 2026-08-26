import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

const ERROR_TEXT = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncGenerator<unknown> }) => ({
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
      yield { type: 'system', subtype: 'init', session_id: 'sess-net', model: 'test-model' }
      yield {
        type: 'assistant',
        uuid: 'assistant-net',
        session_id: 'sess-net',
        error: 'unknown',
        message: { id: 'assistant-net', content: [{ type: 'text', text: ERROR_TEXT }] }
      }
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'result-net',
        session_id: 'sess-net',
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0
      }
    }
  })
}))

beforeAll(() => {
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-session-net-'))
})

describe('ClaudeSession connection loss handling', () => {
  /**
   * 이 보고가 없으면 ENOTFOUND 로 죽은 턴은 이어가기 대상에 들어가지 않는다 — 오류 카드 한 장만
   * 남고 작업이 거기서 끝난다(사용자가 겪은 증상).
   */
  it('API 에 닿지 못해 끝난 턴을 메인에 알리고, 무엇이 끊겼는지는 그대로 보여 준다', async () => {
    const { ClaudeSession } = await import('./session')
    const items: ChatItem[] = []
    const onConnectionLost = vi.fn()

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
      onConnectionLost,
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && onConnectionLost.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    session.dispose()

    expect(onConnectionLost).toHaveBeenCalledOnce()
    // 사용량 제한과 달리 실패 카드는 감추지 않는다 — 와이파이·VPN·프록시는 사용자가 고칠 수 있다.
    expect(items.some((item) => item.type === 'assistant' && item.text.includes('ENOTFOUND'))).toBe(
      true
    )
  })
})
