import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import type { SessionDeps } from './session'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 모델을 바꿔도 세션을 버리지 않는다.
 *
 * 예전에는 매니저가 dispose 해서, 다음 메시지가 resume 으로 query 를 다시 열며 디스크
 * 트랜스크립트를 통째로 다시 입력으로 보냈다(프로세스·MCP 재기동은 덤). SDK 의 setModel 로
 * 살아 있는 query 위에서 갈아 끼우면 그 비용이 사라진다 — 이 테스트는 query 가 **다시 열리지
 * 않는다**는 것과 새 모델이 실제로 전달된다는 것을 함께 못 박는다.
 */

let opened = 0

class FakeQuery {
  private out = new AsyncQueue<Record<string, unknown>>()
  /** setModel 로 라이브 세션에 전달된 값들. undefined 는 "기본 모델로" 다. */
  applied: (string | undefined)[] = []

  constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
    void (async () => {
      for await (const _ of prompt) void _
    })()
  }

  async getContextUsage(): Promise<{
    totalTokens: number
    maxTokens: number
    percentage: number
    autoCompactThreshold: number
  }> {
    return { totalTokens: 1_000, maxTokens: 200_000, percentage: 1, autoCompactThreshold: 167_000 }
  }
  async interrupt(): Promise<void> {}
  async setModel(model?: string): Promise<void> {
    this.applied.push(model)
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let fake: FakeQuery
/** 마지막으로 query 를 열 때 SDK 에 넘어간 모델. */
let openedWith: string | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>
    options: { model?: string }
  }) => {
    opened += 1
    openedWith = options.model
    return (fake = new FakeQuery(prompt))
  }
}))

vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

interface Session {
  send(text: string): void
  setModel(model: string | null): Promise<void>
  dispose(): void
}

/** 세션이 들고 있는 deps. 다음 query 가 어떤 모델로 열릴지는 여기 적힌 값이 정한다. */
let deps: SessionDeps

async function start(model: string | null): Promise<Session> {
  const { ClaudeSession } = await import('./session')
  const items: ChatItem[] = []
  const events: ChatEvent[] = []
  deps = {
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact: false,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    emit: (e) => events.push(e),
    persist: (i) => items.push(i),
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  }
  const session = new ClaudeSession(deps)
  session.send('hello')
  await settle()
  return session
}

describe('ClaudeSession.setModel', () => {
  beforeEach(() => {
    vi.resetModules()
    opened = 0
    openedWith = undefined
  })

  it('살아 있는 query 위에서 모델을 갈아 끼운다 — 세션을 다시 열지 않는다', async () => {
    const session = await start('claude-sonnet-5')
    expect(opened).toBe(1)

    await session.setModel('claude-opus-5')
    await settle()

    expect(fake.applied).toEqual(['claude-opus-5'])
    expect(opened).toBe(1)
    session.dispose()
  })

  it('null 은 "모델 지정 없음" 으로 전달한다(모델 기본 동작)', async () => {
    const session = await start('claude-opus-5')
    await session.setModel(null)
    await settle()

    expect(fake.applied).toEqual([undefined])
    session.dispose()
  })

  it('바꾼 모델은 세션이 나중에 다시 열릴 때도 유지된다', async () => {
    const session = await start('claude-sonnet-5')
    expect(openedWith).toBe('claude-sonnet-5')

    await session.setModel('claude-opus-5')
    // query 를 다시 여는 것은 프로세스 교체·크래시 복구뿐인데, 그때 무엇으로 열지는 deps 가
    // 정한다 — 여기가 갱신되지 않으면 재시작이 조용히 옛 모델로 되돌아간다.
    expect(deps.model).toBe('claude-opus-5')
    session.dispose()
  })
})
