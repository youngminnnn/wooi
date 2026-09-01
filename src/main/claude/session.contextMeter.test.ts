import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 상태줄 컨텍스트 미터가 늘 "—" 로 남는 회귀의 테스트.
 *
 * refreshContextUsage 의 getContextUsage 호출이 실패/타임아웃해도 지금까지는 로그 한 줄 없이
 * 삼켜졌고, 다음 성공 턴이 올 때까지 미터가 복구되지 않았다. 이제는 실패를 로그로 남기고, 턴을
 * 더 붙잡지 않은 채(idle 은 그대로 방출) 미터만 뒤늦게 채우는 재시도를 별도로 돈다.
 *
 * SDK 를 통째로 가짜로 물려(진짜 CLI 를 띄우지 않는다) 메시지 순서와 context 이벤트만 검증한다.
 */

/** 세션이 SDK 에 넘긴 프롬프트/옵션과, 우리가 되돌려 줄 메시지 스트림을 쥔 가짜 query. */
class FakeQuery {
  /** 세션에게 흘려보낼 SDK 메시지 큐(테스트가 push 한다). */
  private out = new AsyncQueue<Record<string, unknown>>()
  /** 세션이 입력 큐로 보낸 사용자 메시지의 본문(문자열/블록 배열). */
  sent: unknown[] = []
  /** getContextUsage 가 돌려줄 값. 테스트가 조작한다. */
  usage = {
    totalTokens: 1_000,
    maxTokens: 200_000,
    percentage: 1,
    autoCompactThreshold: 167_000
  }
  /** 테스트가 실패/성공을 갈아 끼우는 훅. 기본은 usage 를 그대로 돌려준다. */
  getContextUsage: () => Promise<typeof this.usage> = async () => this.usage

  constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
    // 세션의 promptStream 을 계속 비워 준다(SDK 가 stdin 으로 흘려보내는 것과 같은 역할).
    void (async () => {
      for await (const m of prompt) this.sent.push(m.message.content)
    })()
  }

  push(msg: Record<string, unknown>): void {
    this.out.push(msg)
  }

  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let fake: FakeQuery

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) =>
    (fake = new FakeQuery(prompt))
}))

// 네이티브 바이너리 경로 계산은 패키징된 앱 전용이라(process.resourcesPath) 테스트에선 무의미하다.
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

/** 대기 중인 마이크로태스크/타이머가 정리될 때까지 잠깐 양보한다. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

/** 성공 result 메시지 한 건(세션이 턴을 닫는 데 필요한 필드만 채운다). */
const successResult = (uuid: string): Record<string, unknown> => ({
  type: 'result',
  subtype: 'success',
  uuid,
  session_id: 's1',
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0
})

interface Harness {
  session: { send(text: string): void; dispose(): void }
  events: ChatEvent[]
  statuses: () => string[]
  contextEvents: () => Extract<ChatEvent, { type: 'context' }>[]
}

async function start(autoCompact: boolean): Promise<Harness> {
  const { ClaudeSession } = await import('./session')
  const events: ChatEvent[] = []
  const items: ChatItem[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    emit: (e) => events.push(e),
    persist: (i) => items.push(i),
    requestPermission: async () => ({ behavior: 'deny' }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => events.push({ type: 'status', status: 'idle' })
  })
  return {
    session,
    events,
    statuses: () => events.flatMap((e) => (e.type === 'status' ? [e.status] : [])),
    contextEvents: () =>
      events.filter((e): e is Extract<ChatEvent, { type: 'context' }> => e.type === 'context')
  }
}

describe('ClaudeSession 컨텍스트 미터', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('턴이 성공으로 끝나면 context 이벤트가 정확히 1건, 값이 맞게 방출된다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    fake.push(successResult('u1'))
    await settle()

    expect(h.contextEvents()).toEqual([
      { type: 'context', usedTokens: 1_000, maxTokens: 200_000, percentage: 0.01 }
    ])
    h.session.dispose()
  })

  it('1차 조회가 실패해도 턴은 idle 로 가고, 뒤늦은 재시도가 미터를 채운다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    // 첫 호출은 즉시 던지고(타임아웃을 기다리지 않는다), 재시도의 두 번째 호출은 값을 돌려준다.
    let calls = 0
    fake.getContextUsage = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return fake.usage
    }

    fake.push(successResult('u1'))
    await settle()

    // 미터 조회가 실패했어도 턴은 붙잡히지 않고 idle 로 간다.
    expect(h.statuses()).toEqual(['running', 'idle'])
    // 재시도가 뒤늦게 채운 context 이벤트.
    expect(h.contextEvents()).toEqual([
      { type: 'context', usedTokens: 1_000, maxTokens: 200_000, percentage: 0.01 }
    ])
    h.session.dispose()
  })

  it('재시도 응답이 늦게 왔고 그 사이 새 턴이 시작됐으면 방출하지 않는다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    // 1차는 즉시 던진다. 재시도 응답은 release() 를 부를 때까지 붙잡아 둔다.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    let calls = 0
    fake.getContextUsage = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      await held
      return fake.usage
    }

    fake.push(successResult('u1'))
    await settle()

    // 재시도가 응답을 기다리는 사이 새 턴을 연다.
    h.session.send('second')
    await settle()

    // 이제야 재시도 응답이 온다 — 이미 새 턴이 열렸으니 뒤늦은 옛 값으로 미터를 덮으면 안 된다.
    release()
    await settle()

    expect(h.contextEvents()).toEqual([])
    h.session.dispose()
  })
})
