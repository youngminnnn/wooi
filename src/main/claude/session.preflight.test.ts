import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 콜드 resume preflight 가 첫 메시지를 흘려보내는지 검증한다(데드락 회귀 방지).
 *
 * 배경: resume + autoCompact 인 세션은 compact-first 를 판단하려고 사용자 첫 메시지를 잠시
 * 버퍼링한다(preflight). 이 preflight 를 `system:init` 수신 시점에 돌리면 데드락이 된다 —
 * 실제 CLI 는 **입력 스트림에서 메시지를 하나라도 받아야** init 을 내보내는데, preflight 가
 * 바로 그 메시지를 붙들고 있기 때문이다. 그래서 "init 을 기다리는 preflight" 와 "입력을
 * 기다리는 init" 이 서로를 기다려, 워치독(180초)이 끊을 때까지 앱이 무응답이 된다.
 *
 * 아래 가짜 query 는 그 CLI 동작(입력 없으면 init 없음)을 그대로 흉내 내므로, preflight 가
 * init 에 의존하면 이 테스트는 타임아웃으로 실패한다.
 */

// 입력 스트림이 실제로 받아 간 사용자 메시지(테스트 관찰점).
const received: string[] = []
let contextUsage: { totalTokens: number; percentage: number; autoCompactThreshold: number }

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncGenerator<unknown> }) => ({
    getContextUsage: async () => contextUsage,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    async *[Symbol.asyncIterator]() {
      // 실제 CLI 와 동일하게, 입력이 한 건이라도 들어와야 init 을 낸다.
      const first = await prompt.next()
      if (first.done) return
      const msg = first.value as { message: { content: unknown } }
      received.push(JSON.stringify(msg.message.content))
      yield { type: 'system', subtype: 'init', session_id: 'sess-fake', model: 'test-model' }
      // 턴을 정상 종료시켜 세션이 idle 로 정착하게 한다.
      yield { type: 'result', subtype: 'success', num_turns: 1 }
    }
  })
}))

beforeAll(() => {
  // 로거가 실제 userData 로그를 건드리지 않도록 임시 디렉터리로 돌린다.
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-preflight-'))
})

async function runFirstTurn(autoCompact: boolean, usage: typeof contextUsage) {
  received.length = 0
  contextUsage = usage
  const { ClaudeSession } = await import('./session')
  const items: ChatItem[] = []
  const events: ChatEvent[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model: null,
    effort: null,
    fastMode: true,
    permissionMode: 'default',
    autoCompact,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    // 이 값이 있어야 preflight 경로로 들어간다(= fast mode/모델 변경 후 첫 메시지, 앱 재시작 후 첫 메시지).
    resumeSessionId: 'prev-session-id',
    additionalDirs: [],
    wooiMcp,
    emit: (e) => events.push(e),
    persist: (i) => items.push(i),
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })

  session.send('hello')

  // 데드락이면 여기서 아무것도 도착하지 않는다(실제 앱에서는 180초 워치독까지 무응답).
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && received.length === 0) {
    await new Promise((r) => setTimeout(r, 20))
  }
  session.dispose()
  return { received: [...received], items, events }
}

describe('ClaudeSession cold-resume preflight', () => {
  it('임계치 아래면 첫 사용자 메시지를 곧바로 입력 스트림으로 흘려보낸다', async () => {
    const { received, events } = await runFirstTurn(true, {
      totalTokens: 1_000,
      percentage: 5,
      autoCompactThreshold: 100_000
    })

    // 회귀 지점: preflight 가 init 을 기다리면 이 배열은 영원히 비어 있다.
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('hello')
    // 세션이 정상 시작됐다 = init 이 도착했다.
    expect(events.some((e) => e.type === 'session')).toBe(true)
  }, 15_000)

  it('임계치를 넘으면 사용자 턴보다 /compact 를 먼저 보낸다(compact-first)', async () => {
    const { received, events } = await runFirstTurn(true, {
      totalTokens: 150_000,
      percentage: 95,
      autoCompactThreshold: 100_000
    })

    // 첫 입력이 사용자 메시지가 아니라 /compact 여야 한다 — 큰 맥락을 두 번 흘리지 않기 위함.
    expect(received[0]).toContain('/compact')
    expect(events.some((e) => e.type === 'compacting')).toBe(true)
  }, 15_000)

  it('autoCompact 가 꺼져 있으면 버퍼링 없이 그대로 보낸다', async () => {
    const { received } = await runFirstTurn(false, {
      totalTokens: 150_000,
      percentage: 95,
      autoCompactThreshold: 100_000
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toContain('hello')
  }, 15_000)
})
