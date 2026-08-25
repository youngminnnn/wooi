import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 유휴 세션 정리로 끊은 query 가 마지막 오류 result 문구를 들고 죽는 상황.
 *
 * SDK 는 프로세스 종료 오류를 마지막 오류 result 의 문구로 갈아 끼운다(sdk.mjs readMessages) —
 * 그래서 사용량 제한으로 멈춘 세션을 정리하면 종료가 "Claude Code returned an error result:
 * You've hit your session limit…" 예외로 온다.
 */
class FakeQuery {
  private pending: Array<Record<string, unknown>> = []
  private wake: (() => void) | null = null
  private failure: Error | null = null
  private done = false

  push(message: Record<string, unknown>): void {
    this.pending.push(message)
    this.wake?.()
  }

  /** 프로세스가 죽어 스트림이 예외로 끝나는 것을 흉내 낸다. */
  fail(err: Error): void {
    this.failure = err
    this.wake?.()
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

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    while (!this.done) {
      if (this.pending.length) {
        yield this.pending.shift()!
        continue
      }
      if (this.failure) {
        this.done = true
        throw this.failure
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

let fake: FakeQuery

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (fake = new FakeQuery())
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('ClaudeSession dispose after a rate-limited turn', () => {
  it('할 일 없이 죽은 query 의 오류를 카드로 띄우지 않는다', async () => {
    const { ClaudeSession } = await import('./session')
    const events: ChatEvent[] = []
    const persisted: ChatItem[] = []
    const rateLimits: Array<number | undefined> = []
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600

    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      mcpSettings: { servers: [], disabledInherited: [] },
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      autoResumeAfterRateLimit: true,
      peer: { name: 'wooi/repo/test', inbound: 'refuse' },
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp,
      emit: (event) => events.push(event),
      persist: (item) => persisted.push(item),
      requestPermission: async () => ({ behavior: 'deny', message: 'no' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      onRateLimit: (resetAt) => rateLimits.push(resetAt),
      settleIdle: () => {}
    })

    session.send('hello')
    await settle()
    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' })
    fake.push({
      type: 'assistant',
      uuid: 'assistant-limit',
      session_id: 'sess-1',
      error: 'unknown',
      message: {
        id: 'assistant-limit',
        content: [{ type: 'text', text: `Claude AI usage limit reached|${resetEpoch}` }]
      }
    })
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'result-limit',
      session_id: 'sess-1',
      num_turns: 1,
      duration_ms: 1,
      total_cost_usd: 0
    })
    await settle()

    // 턴은 제한으로 멈췄고, 메인은 이어가기를 예약할 근거를 이미 받았다.
    expect(rateLimits).toHaveLength(1)

    // 유휴 세션 정리 — 우리가 끊은 프로세스가 마지막 오류 문구를 들고 죽는다.
    session.dispose()
    fake.fail(new Error("Claude Code returned an error result: You've hit your session limit"))
    await settle()

    expect(persisted.filter((item) => item.type === 'error')).toHaveLength(0)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(false)
  })
})
