import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 자동 재시도는 조용히 일어나면 안 된다.
 *
 * 산출이 없었던 턴을 새 프로세스에서 한 번 더 돌리는 것 자체는 옳다(부작용이 없고, 없으면
 * 사용자가 직접 다시 보내야 한다). 문제는 **말없이** 한다는 것이었다 — 첫 시도의 입력이 이미
 * API 로 나갔다면 사용자는 모르는 채로 같은 맥락을 두 번 낸다. 재시도로 들어오는 두 경로 모두
 * 트랜스크립트에 한 줄을 남기는지 검증한다.
 */

let queryCalls = 0
/** 첫 query 가 어떻게 실패할지 — result 로 실패(=requestRestart) 또는 예외(=handleQueryDeath). */
let firstQueryMode: 'failedResult' | 'died' = 'failedResult'

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))
vi.mock('./sessionFiles', () => ({ sessionTranscriptExists: () => true }))

function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncGenerator<unknown>
    options: { abortController: AbortController }
  }) => {
    const n = ++queryCalls
    const signal = options.abortController.signal
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
        if (n === 1) {
          const first = await prompt.next()
          if (first.done) return
          if (firstQueryMode === 'died') throw new Error('spawn failed before first message')
          // 산출을 하나도 내지 못한 채 실패한 턴. 원인 문자열이 없어 자격증명 문제일 수 있다.
          yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' }
          yield { type: 'result', subtype: 'error_during_execution', num_turns: 1 }
          await untilAbort(signal)
          return
        }
        // 재시도한 프로세스는 그냥 매달려 둔다 — 검증 대상은 재시도 안내지 그 결과가 아니다.
        await untilAbort(signal)
      }
    }
  }
}))

const notices = (items: ChatItem[]): string[] =>
  items.flatMap((i) =>
    i.type === 'system' && i.id.startsWith('system:auto-retry:') ? [i.text] : []
  )

async function runUntilRetry(): Promise<ChatItem[]> {
  const { ClaudeSession } = await import('./session')
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
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })

  session.send('hello')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && queryCalls < 2) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 20))
  session.dispose()
  return items
}

describe('자동 재시도 안내', () => {
  beforeEach(() => {
    vi.resetModules()
    queryCalls = 0
  })

  it('산출 없이 실패한 턴을 다시 돌릴 때 트랜스크립트에 남긴다', async () => {
    firstQueryMode = 'failedResult'
    const items = await runUntilRetry()

    expect(queryCalls).toBe(2)
    const said = notices(items)
    expect(said).toHaveLength(1)
    // 무엇이 일어났는지와, 이미 청구됐을 수 있다는 사실을 함께 말한다.
    expect(said[0]).toContain('sent your message again')
    expect(said[0]).toContain('billed')
  })

  it('첫 메시지 전에 프로세스가 죽어 다시 돌릴 때도 남긴다', async () => {
    firstQueryMode = 'died'
    const items = await runUntilRetry()

    expect(queryCalls).toBe(2)
    expect(notices(items)).toHaveLength(1)
  })
})
