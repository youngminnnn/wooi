import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 자동 압축과 "턴 종료 → idle" 순서의 회귀 테스트.
 *
 * 핵심 불변식: **압축 여부를 정하기 전에는 idle 을 방출하지 않는다.** 렌더러는 idle 을 보는
 * 즉시 대기 큐(사용자가 턴 도중 보낸 후속 메시지)를 흘려보내므로, idle 이 먼저 나가면 그
 * 메시지가 압축 전(거의 가득 찬) 맥락 위에서 새 턴을 열어 버린다 — 자동 압축이 막으려던 바로
 * 그 상황이다. 그래서 압축이 필요하면 running 을 유지한 채 /compact 만 흘려보내고, 압축 턴이
 * 끝난 뒤에야 idle 로 간다.
 *
 * SDK 를 통째로 가짜로 물려(진짜 CLI 를 띄우지 않는다) 메시지 순서만 검증한다.
 */

/** 세션이 SDK 에 넘긴 프롬프트/옵션과, 우리가 되돌려 줄 메시지 스트림을 쥔 가짜 query. */
class FakeQuery {
  /** 세션에게 흘려보낼 SDK 메시지 큐(테스트가 push 한다). */
  private out = new AsyncQueue<Record<string, unknown>>()
  /** 세션이 입력 큐로 보낸 사용자 메시지의 본문(문자열/블록 배열). */
  sent: unknown[] = []
  /** getContextUsage 가 돌려줄 값. 테스트가 임계치 초과 여부를 조작한다. */
  usage = {
    totalTokens: 1_000,
    maxTokens: 200_000,
    percentage: 1,
    autoCompactThreshold: 167_000
  }

  constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
    // 세션의 promptStream 을 계속 비워 준다(SDK 가 stdin 으로 흘려보내는 것과 같은 역할).
    void (async () => {
      for await (const m of prompt) this.sent.push(m.message.content)
    })()
  }

  push(msg: Record<string, unknown>): void {
    this.out.push(msg)
  }

  async getContextUsage(): Promise<typeof this.usage> {
    return this.usage
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
}

async function start(autoCompact: boolean): Promise<Harness> {
  const { ClaudeSession } = await import('./session')
  const events: ChatEvent[] = []
  const items: ChatItem[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    model: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact,
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
    statuses: () => events.flatMap((e) => (e.type === 'status' ? [e.status] : []))
  }
}

describe('ClaudeSession 자동 압축 / 턴 종료 순서', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('임계치를 넘으면 idle 을 방출하지 않고 running 을 유지한 채 /compact 를 먼저 보낸다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    // 이 턴이 끝나는 시점에 컨텍스트가 이미 임계치를 넘었다.
    fake.usage = { ...fake.usage, totalTokens: 170_000, percentage: 85 }
    fake.push(successResult('u1'))
    await settle()

    // idle 이 새어 나가면 렌더러가 대기 큐를 압축 전 맥락으로 흘려보낸다 — 절대 없어야 한다.
    expect(h.statuses()).toEqual(['running'])
    expect(h.events).toContainEqual({ type: 'compacting', active: true, trigger: 'auto' })
    expect(fake.sent).toEqual(['hello', '/compact'])

    // 압축 턴이 끝나면 비로소 idle — 이때 렌더러가 대기 큐를 압축된 맥락 위에서 이어서 돌린다.
    fake.usage = { ...fake.usage, totalTokens: 20_000, percentage: 10 }
    fake.push(successResult('u2'))
    await settle()

    expect(h.statuses()).toEqual(['running', 'idle'])
    expect(h.events).toContainEqual({ type: 'compacting', active: false, trigger: 'auto' })
    h.session.dispose()
  })

  it('임계치 아래면 압축 없이 곧바로 idle 로 간다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    fake.push(successResult('u1'))
    await settle()

    expect(h.statuses()).toEqual(['running', 'idle'])
    expect(h.events.some((e) => e.type === 'compacting')).toBe(false)
    expect(fake.sent).toEqual(['hello'])
    h.session.dispose()
  })

  it('autoCompact 가 꺼져 있으면 임계치를 넘겨도 압축하지 않고 idle 로 간다', async () => {
    const h = await start(false)
    h.session.send('hello')
    await settle()

    fake.usage = { ...fake.usage, totalTokens: 170_000, percentage: 85 }
    fake.push(successResult('u1'))
    await settle()

    expect(h.statuses()).toEqual(['running', 'idle'])
    expect(fake.sent).toEqual(['hello'])
    h.session.dispose()
  })

  it('압축을 확인하는 동안 새 사용자 메시지가 오면 뒤늦은 idle 로 턴을 덮어쓰지 않는다', async () => {
    const h = await start(true)
    h.session.send('hello')
    await settle()

    // 컨텍스트 확인 응답을 붙잡아 두고, 그 사이에 사용자가 새 메시지를 보내는 상황을 만든다.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    fake.getContextUsage = async () => {
      await held
      return fake.usage
    }

    fake.push(successResult('u1'))
    await settle()
    h.session.send('second')
    await settle()
    release()
    await settle()

    // 새 턴이 도는 중이므로 idle 이 나가면 안 된다(사이드바가 멈춘 것처럼 보인다).
    expect(h.statuses()).toEqual(['running'])
    expect(fake.sent).toEqual(['hello', 'second'])
    h.session.dispose()
  })
})
