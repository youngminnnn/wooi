import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from '../claude/testWooiMcp'

/**
 * `silent` 전송은 화면에 **한 글자도** 남기지 않는다([[agent/backend]] sendMessage).
 *
 * Wooi 가 사용자를 대신해 보내는 말이 사용자 말풍선으로 쌓이면 안 된다 — 팀으로 바꾼 뒤의 자동
 * 이어가기가 그렇다([[agent/orchestrator]] resumeAfterTurn). 사용자가 보는 것은 자기 요청에 이어
 * 에이전트가 계속 일하는 모습뿐이어야 한다.
 *
 * 두 백엔드를 한 파일에서 함께 지킨다 — 기록하는 자리가 백엔드마다 따로라 한쪽만 고쳐지기 쉽고,
 * 그러면 백엔드에 따라 숨겨야 할 문장이 뜬다.
 */

vi.mock('../claude/mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

// query 는 프롬프트를 한 번 읽고 아무것도 내놓지 않는다 — 여기서 보는 것은 전송의 **기록** 이지
// 모델의 응답이 아니다.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncGenerator<unknown> }) => ({
    getContextUsage: async () => ({ totalTokens: 0, percentage: 0, autoCompactThreshold: 100_000 }),
    interrupt: async () => {},
    setPermissionMode: async () => {},
    async *[Symbol.asyncIterator]() {
      await prompt.next()
      yield* []
    }
  })
}))

beforeAll(() => {
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-silent-send-'))
})

const SECRET = 'this line must never reach the screen'

async function claudeSend(opts?: { prefix?: string; silent?: boolean }): Promise<{
  items: ChatItem[]
  events: ChatEvent[]
}> {
  const { ClaudeSession } = await import('../claude/session')
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
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    emit: (event) => events.push(event),
    persist: (item) => items.push(item),
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })
  session.send(SECRET, undefined, opts)
  session.dispose()
  return { items, events }
}

async function codexSend(opts?: { prefix?: string; silent?: boolean }): Promise<{
  items: ChatItem[]
  events: ChatEvent[]
}> {
  const { CodexThread } = await import('../codex/thread')
  const items: ChatItem[] = []
  const events: ChatEvent[] = []
  const thread = new CodexThread(
    'ws-1',
    {
      cwd: '/tmp/wt',
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      delegateBackends: [],
      delegateInstructions: null,
      resumeThreadId: null
    },
    {
      // 기록은 rpc 보다 먼저 일어나므로, 여기서 끊어도 보려는 것은 다 관찰된다.
      rpc: () => Promise.reject(new Error('no app-server in this test')),
      emit: (event) => events.push(event),
      persist: (item) => items.push(item),
      onThreadId: () => {},
      settleIdle: () => {}
    }
  )
  await thread.send(SECRET, undefined, opts)
  return { items, events }
}

const BACKENDS = [
  { label: 'claude', send: claudeSend },
  { label: 'codex', send: codexSend }
] as const

describe.each(BACKENDS)('silent 전송 ($label)', ({ send }) => {
  it('트랜스크립트에도 화면에도 남지 않는다', async () => {
    const { items, events } = await send({ silent: true })

    expect(items.filter((item) => item.type === 'user')).toEqual([])
    expect(JSON.stringify(items)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  it('silent 가 아니면 평소대로 사용자 메시지로 남는다', async () => {
    const { items, events } = await send()

    expect(items.filter((item) => item.type === 'user')).toHaveLength(1)
    expect(JSON.stringify(events)).toContain(SECRET)
  })

  // prefix 와 silent 는 다른 것을 숨긴다. prefix 는 앞맥락만 감추고 사용자의 말은 남긴다.
  it('prefix 는 앞맥락만 감춘다 — 사용자의 말은 그대로 남는다', async () => {
    const { items } = await send({ prefix: 'hidden context' })

    const user = items.filter((item) => item.type === 'user')
    expect(user).toHaveLength(1)
    expect(JSON.stringify(user)).not.toContain('hidden context')
  })
})
