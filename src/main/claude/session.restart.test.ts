import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

type Prompt = { message: { content: unknown }; uuid?: string }
type Scenario = 'single' | 'fold' | 'interrupt'

let scenario: Scenario
let queryCalls: number
let interruptCalls: number
const prompts: Prompt[][] = []
const queryOptions: Array<Record<string, unknown>> = []
let finishInterruptedQuery: (() => void) | null

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncGenerator<Prompt>
    options: Record<string, unknown>
  }) => {
    const call = ++queryCalls
    queryOptions.push(options)
    const received: Prompt[] = []
    prompts.push(received)
    return {
      getContextUsage: async () => ({
        totalTokens: 1_000,
        percentage: 1,
        autoCompactThreshold: 100_000
      }),
      interrupt: async () => {
        interruptCalls++
        // requestRestart itself interrupts once. Keep this stream alive until the user interrupts too.
        if (scenario === 'interrupt' && interruptCalls === 2) finishInterruptedQuery?.()
      },
      setPermissionMode: async () => {},
      async *[Symbol.asyncIterator]() {
        const first = await prompt.next()
        if (first.done) return
        received.push(first.value)
        if (scenario === 'fold') {
          const second = await prompt.next()
          if (!second.done) received.push(second.value)
        }
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'session-before-restart',
          model: 'test-model'
        }
        for (const message of received) {
          yield {
            type: 'user',
            uuid: message.uuid,
            isReplay: true,
            session_id: 'session-before-restart',
            message: message.message
          }
        }
        yield {
          type: 'assistant',
          uuid: `assistant-${call}`,
          error: 'OAuth token expired',
          message: { content: [{ type: 'text', text: 'OAuth token expired' }] }
        }
        yield {
          type: 'result',
          subtype: 'success',
          uuid: `result-${call}`,
          session_id: 'session-before-restart',
          num_turns: 1,
          duration_ms: 1,
          total_cost_usd: 0
        }
        if (scenario === 'interrupt' && call === 1) {
          await new Promise<void>((resolve) => {
            finishInterruptedQuery = resolve
          })
          finishInterruptedQuery = null
        }
      }
    }
  }
}))

beforeEach(() => {
  scenario = 'single'
  queryCalls = 0
  interruptCalls = 0
  prompts.length = 0
  queryOptions.length = 0
  finishInterruptedQuery = null
})

function makeSession(items: ChatItem[] = []) {
  return import('./session').then(
    ({ ClaudeSession }) =>
      new ClaudeSession({
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
        onPermissionMode: () => {},
        settleIdle: () => {}
      })
  )
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !predicate())
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe('ClaudeSession terminal restart input identity', () => {
  it('resumes with a reminted in-flight UUID while retaining its UI checkpoint', async () => {
    const items: ChatItem[] = []
    const session = await makeSession(items)
    session.send('retry this exact content')
    await waitFor(
      () => queryCalls === 2 && items.filter((item) => item.type === 'error').length === 1
    )
    session.dispose()

    expect(queryOptions[1].resume).toBe('session-before-restart')
    expect(prompts).toHaveLength(2)
    expect(prompts[1][0].message.content).toBe(prompts[0][0].message.content)
    expect(prompts[1][0].uuid).not.toBe(prompts[0][0].uuid)
    expect(session.getCheckpoints()).toEqual([
      expect.objectContaining({
        userMessageId: prompts[1][0].uuid,
        text: 'retry this exact content'
      })
    ])
    expect(items.filter((item) => item.type === 'user')).toHaveLength(1)
    expect(items.filter((item) => item.type === 'error')).toHaveLength(1)
  })

  it('remints all folded in-flight UUIDs and retargets their checkpoint chain', async () => {
    scenario = 'fold'
    const session = await makeSession()
    session.send('first folded input')
    session.send('second folded input')
    await waitFor(() => queryCalls === 2 && prompts[1]?.length === 2)
    session.dispose()

    expect(prompts[0].map((message) => message.message.content)).toEqual([
      'first folded input',
      'second folded input'
    ])
    expect(prompts[1].map((message) => message.message.content)).toEqual([
      'first folded input',
      'second folded input'
    ])
    expect(prompts[1][0].uuid).not.toBe(prompts[0][0].uuid)
    expect(prompts[1][1].uuid).not.toBe(prompts[0][1].uuid)
    expect(session.getCheckpoints()).toEqual([
      expect.objectContaining({ userMessageId: prompts[1][1].uuid, forkAt: prompts[1][0].uuid }),
      expect.objectContaining({ userMessageId: prompts[1][0].uuid, forkAt: null })
    ])
  })

  it('does not recreate a terminal restart after the user interrupts it', async () => {
    scenario = 'interrupt'
    const session = await makeSession()
    session.send('cancel this restart')
    await waitFor(() => interruptCalls === 1)
    await session.interrupt()
    await waitFor(() => queryCalls === 1 && finishInterruptedQuery === null)
    session.dispose()
  })
})
