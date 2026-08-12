import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentBackendId } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 셸로 다른 에이전트 제품을 돌리려는 시도는 승인 카드보다 **앞에서** 되돌아야 한다.
 *
 * 카드로 넘기면 두 가지가 어긋난다. 하나 — 카드는 "이 명령을 실행할까?" 만 묻는데, 사용자가
 * 원한 것은 대개 "codex 에게 시켜라" 이지 "셸에서 codex 를 돌려라" 가 아니다. 둘 — fullAccess·auto
 * 에서는 카드 자체가 없어 조용히 지나간다. 실측에서 모델이 샌 경로가 정확히 그것이다.
 */

class FakeQuery {
  private out = new AsyncQueue<Record<string, unknown>>()
  constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
    void (async () => {
      for await (const _ of prompt) void _
    })()
  }
  async getContextUsage(): Promise<Record<string, number>> {
    return { totalTokens: 0, maxTokens: 200_000, percentage: 0, autoCompactThreshold: 167_000 }
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let canUseTool: (
  name: string,
  input: Record<string, unknown>,
  opts: Record<string, unknown>
) => Promise<{ behavior: string; message?: string }>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>
    options: { canUseTool: typeof canUseTool }
  }) => {
    canUseTool = options.canUseTool
    return new FakeQuery(prompt)
  }
}))

vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

interface Harness {
  dispose: () => void
  /** 카드까지 간 승인 요청들. 가로챈 호출은 여기 나타나면 안 된다. */
  cards: string[]
}

async function start(
  opts: { delegateBackends?: AgentBackendId[]; canSwitchToAgentTeam?: boolean } = {}
): Promise<Harness> {
  const { ClaudeSession } = await import('./session')
  const cards: string[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model: null,
    effort: null,
    fastMode: false,
    // auto 로 연다 — 자동 승인이라 카드가 없는 모드에서도 가로채기가 서야 한다는 것이 요점이다.
    permissionMode: 'auto',
    autoCompact: false,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    delegateBackends: opts.delegateBackends ?? [],
    canSwitchToAgentTeam: opts.canSwitchToAgentTeam ?? false,
    emit: () => {},
    persist: () => {},
    requestPermission: async (req) => {
      cards.push(req.toolName)
      return { behavior: 'allow' as const }
    },
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })
  session.send('hello')
  await settle()
  return { dispose: () => session.dispose(), cards }
}

const bash = (command: string): Promise<{ behavior: string; message?: string }> =>
  canUseTool('Bash', { command }, {})

describe('셸 위임 시도 가로채기', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('Solo 에서 codex exec 를 거절하고 전환 도구를 지목한다', async () => {
    const h = await start({ canSwitchToAgentTeam: true })

    const result = await bash('codex exec --sandbox workspace-write "구현해 줘"')

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('switch_to_agent_team')
    // 카드까지 가지 않아야 한다 — 사용자에게 물을 것은 "이 명령" 이 아니라 "전환" 이다.
    expect(h.cards).toEqual([])
    h.dispose()
  })

  it('팀에서는 같은 시도를 위임 도구로 돌려세운다', async () => {
    const h = await start({ delegateBackends: ['claude', 'codex'] })

    const result = await bash('codex exec "구현해 줘"')

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('codex_subagent')
    h.dispose()
  })

  it('바꿀 수 없는 워크스페이스에서는 대안 대신 사용자에게 넘기라고 한다', async () => {
    const h = await start({ canSwitchToAgentTeam: false })

    const result = await bash('claude -p "일해"')

    expect(result.behavior).toBe('deny')
    expect(result.message).not.toContain('switch_to_agent_team')
    h.dispose()
  })

  // 가로채기가 넓으면 그냥 Bash 를 못 쓰는 에이전트가 된다.
  it('평범한 명령은 건드리지 않는다', async () => {
    const h = await start({ canSwitchToAgentTeam: true })

    await expect(bash('npm test')).resolves.toMatchObject({ behavior: 'allow' })
    await expect(bash('codex --version')).resolves.toMatchObject({ behavior: 'allow' })
    h.dispose()
  })
})
