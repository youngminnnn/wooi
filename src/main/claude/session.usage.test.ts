import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem, UsageTotals } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 어떤 result 로 끝나든 그 턴이 쓴 토큰은 장부로 간다.
 *
 * handleResult 에는 이른 return 이 둘 있다 — 조용한 자동 재시도(산출 없이 실패한 턴)와 사용량
 * 제한 뒤 자동 이어가기. 둘 다 "돈이 안 든 턴" 이 아니다. 특히 자동 재시도는 첫 시도의 입력이
 * 이미 API 로 나간 경우가 있어, 여기서 빠뜨리면 장부가 **정확히 그 숨은 비용만** 놓친다.
 * 실제로 앱을 띄워 돌려 보다가 사용량 제한 창에서 장부가 통째로 비는 것을 보고 잡은 회귀다.
 */

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))
vi.mock('./sessionFiles', () => ({ sessionTranscriptExists: () => true }))

let out: AsyncQueue<Record<string, unknown>>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    const mine = out
    return {
      getContextUsage: async () => ({
        totalTokens: 1_000,
        maxTokens: 200_000,
        percentage: 1,
        autoCompactThreshold: 167_000
      }),
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      async *[Symbol.asyncIterator]() {
        const first = await prompt.next()
        if (first.done) return
        for await (const msg of mine) yield msg
      }
    }
  }
}))

/** 실제 result 가 싣고 오는 모양(누계). 값은 "0이 아니다" 만 의미가 있다. */
const resultMessage = (
  subtype: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: 'result',
  subtype,
  uuid: `r-${subtype}-${Math.round(Math.random() * 1e6)}`,
  session_id: 'sess-1',
  num_turns: 1,
  duration_ms: 10,
  total_cost_usd: 0.25,
  usage: {},
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 3_000,
      cacheCreationInputTokens: 4_000,
      webSearchRequests: 0,
      costUSD: 0.25,
      contextWindow: 200_000,
      maxOutputTokens: 64_000
    }
  },
  ...extra
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

async function runTurn(
  push: (out: AsyncQueue<Record<string, unknown>>) => void,
  opts: { autoResumeAfterRateLimit?: boolean } = {}
): Promise<{ recorded: UsageTotals[]; items: ChatItem[] }> {
  const { ClaudeSession } = await import('./session')
  out = new AsyncQueue<Record<string, unknown>>()
  const recorded: UsageTotals[] = []
  const items: ChatItem[] = []
  const events: ChatEvent[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact: false,
    autoResumeAfterRateLimit: opts.autoResumeAfterRateLimit,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    emit: (e) => events.push(e),
    persist: (i) => items.push(i),
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onRateLimit: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {},
    onUsage: (_runId, usage) => recorded.push(usage)
  })

  session.send('hello')
  await settle()
  push(out)
  await settle()
  session.dispose()
  return { recorded, items }
}

/**
 * 이른 return 을 실제로 탔는지 가리는 표식. 그 두 갈래는 result 카드를 남기지 않고 빠져나가므로,
 * result 항목이 없다는 것이 "평범한 경로로 흘러가지 않았다" 는 증거가 된다.
 */
const tookEarlyReturn = (items: ChatItem[]): boolean => !items.some((i) => i.type === 'result')

describe('세션이 장부에 올리는 사용량', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('성공한 턴의 누계를 modelUsage 에서 뽑아 올린다', async () => {
    const { recorded, items } = await runTurn((q) => q.push(resultMessage('success')))

    expect(items.some((i) => i.type === 'result')).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 4_000,
      costUsd: 0.25
    })
  })

  it('조용히 다시 보내는 턴도 장부에 올린다 — 첫 시도가 이미 청구됐을 수 있다', async () => {
    // 산출이 하나도 없는 실패 result = 자동 재시도 경로(handleResult 의 첫 이른 return).
    const { recorded, items } = await runTurn((q) => {
      q.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' })
      q.push(resultMessage('error_during_execution'))
    })

    expect(tookEarlyReturn(items)).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].cacheCreationTokens).toBe(4_000)
    expect(recorded[0].costUsd).toBe(0.25)
  })

  it('사용량 제한으로 멈춘 턴도 장부에 올린다', async () => {
    // 제한 문구가 담긴 assistant.error 뒤에 오는 result = 자동 이어가기 경로(두 번째 이른 return).
    const { recorded, items } = await runTurn(
      (q) => {
        q.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' })
        q.push({
          type: 'assistant',
          uuid: 'a-1',
          session_id: 'sess-1',
          error: 'unknown',
          message: {
            id: 'm-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Claude AI usage limit reached|1754880000' }]
          }
        })
        q.push(resultMessage('success'))
      },
      { autoResumeAfterRateLimit: true }
    )

    expect(tookEarlyReturn(items)).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].cacheReadTokens).toBe(3_000)
  })
})
