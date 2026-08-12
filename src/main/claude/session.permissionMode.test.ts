import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 권한 모드는 우리만 바꾸는 게 아니다 — 모델이 EnterPlanMode 로 계획 모드에 들어가고, CLI 는
 * ExitPlanMode 를 처리하며 모드를 되돌린다. CLI 는 그때마다 `status` 메시지에 permissionMode 를
 * 실어 보내는데, 이걸 흘리면 하단 모드 표시가 실제와 어긋난 채 남는다("계획 중"인데 "default").
 *
 * SDK 를 통째로 가짜로 물려(진짜 CLI 를 띄우지 않는다) 모드 반영만 검증한다.
 */

class FakeQuery {
  private out = new AsyncQueue<Record<string, unknown>>()
  /** setPermissionMode 로 라이브 세션에 실제로 전달된 모드들. */
  applied: string[] = []

  constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
    void (async () => {
      for await (const _ of prompt) void _
    })()
  }

  push(msg: Record<string, unknown>): void {
    this.out.push(msg)
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
  async setPermissionMode(mode: string): Promise<void> {
    this.applied.push(mode)
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let fake: FakeQuery
/** 세션이 SDK 에 넘긴 canUseTool. 승인 프롬프트 경로를 테스트에서 직접 태우는 데 쓴다. */
let canUseTool: (name: string, input: unknown, opts: unknown) => Promise<unknown>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>
    options: { canUseTool: typeof canUseTool }
  }) => {
    canUseTool = options.canUseTool
    return (fake = new FakeQuery(prompt))
  }
}))

vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

/** CLI 가 모드를 바꿀 때 보내는 모양: status 는 null 이고 permissionMode 만 실린다. */
const modeStatus = (permissionMode: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'status',
  status: null,
  permissionMode,
  uuid: `u-${permissionMode}`,
  session_id: 's1'
})

interface Harness {
  session: { send(text: string): void; dispose(): void }
  modes: string[]
}

async function start(approvePlanWith?: string): Promise<Harness> {
  const { ClaudeSession } = await import('./session')
  const modes: string[] = []
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
    emit: (e) => events.push(e),
    persist: (i) => items.push(i),
    requestPermission: async () =>
      approvePlanWith
        ? { behavior: 'allow' as const, optionId: approvePlanWith }
        : { behavior: 'deny' as const },
    onSessionId: () => {},
    onPermissionMode: (m) => modes.push(m),
    settleIdle: () => {}
  })
  session.send('hello')
  await settle()
  return { session, modes }
}

describe('ClaudeSession 권한 모드 동기화', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('CLI 가 계획 모드로 들어가면 UI 에 그대로 반영한다', async () => {
    const h = await start()
    fake.push(modeStatus('plan'))
    await settle()

    expect(h.modes).toEqual(['plan'])
    h.session.dispose()
  })

  it('같은 모드가 다시 보고돼도 UI 를 흔들지 않는다', async () => {
    const h = await start()
    fake.push(modeStatus('plan'))
    fake.push(modeStatus('plan'))
    await settle()

    expect(h.modes).toEqual(['plan'])
    h.session.dispose()
  })

  it('우리 UI 에 없는 모드는 무시한다 — default 로 접어 보여 주면 실제보다 안전해 보인다', async () => {
    const h = await start()
    fake.push(modeStatus('bypassPermissions'))
    fake.push(modeStatus('dontAsk'))
    await settle()

    expect(h.modes).toEqual([])
    h.session.dispose()
  })

  it('계획 승인 직후 CLI 의 되돌림은 사용자가 고른 모드를 덮지 않는다', async () => {
    const h = await start('plan-auto-accept')

    // 사용자가 승인 프롬프트에서 "auto-accept edits" 를 골랐다.
    await canUseTool('ExitPlanMode', { plan: 'do the thing' }, {})
    expect(h.modes).toEqual(['acceptEdits'])

    // CLI 는 ExitPlanMode 를 처리하며 자기 기본값으로 되돌아간다고 보고한다 — 사용자의 선택이
    // 아니라 중간 상태이므로 UI 를 흔들면 안 된다.
    fake.push(modeStatus('default'))
    await settle()
    expect(h.modes).toEqual(['acceptEdits'])

    h.session.dispose()
  })
})
