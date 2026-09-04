import { describe, it, expect, vi } from 'vitest'
import type { ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * fold 회귀 테스트 — 턴이 도는 중 밀어 넣은 메시지를 CLI 가 진행 중인 턴으로 접어 넣으면(fold)
 * result 는 1건인데 우리가 흘려보낸 입력은 2건이다. `inFlight` 를 "result 마다 하나씩 shift" 로
 * 회계하면 접힌 두 번째 메시지가 영영 안 지워진 유령으로 남고, 그 뒤 아무 관계 없는 턴이 죽어
 * 재시작(recycleInput)이 돌면 이미 실행된 그 메시지가 다음 프로세스로 다시 나간다.
 *
 * n=1: "first" 를 받고 턴을 시작, 도중에 "second" 를 접어 받아 result 1건으로 끝낸다(fold).
 * n=2: 세 번째 메시지("third")를 받기도 전에 죽어 조용한 자동 재시도를 부른다.
 * n=3: 재시도로 되살아난 query — 되살려 받은 첫 메시지를 기록한다.
 *
 * inFlight 를 통째로 비우면(clearInFlight) n=3 이 받는 첫 메시지는 "third" 다. 하나씩만 shift
 * 했다면 접힌 "second" 가 유령으로 남아 pending 맨 앞에 끼어들어 n=3 이 "second" 를 먼저 받는다.
 */

let queryCalls = 0
const started: number[] = []
const resent: string[] = []

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

/** signal 이 abort 될 때까지 매달린다(실제 CLI 프로세스가 abort 로 끊기는 것을 흉내). */
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
    prompt: AsyncGenerator<{ message: { content: unknown } }>
    options: { abortController: AbortController }
  }) => {
    const n = ++queryCalls
    started.push(n)
    const signal = options.abortController.signal
    return {
      getContextUsage: async () => ({
        totalTokens: 1_000,
        percentage: 5,
        autoCompactThreshold: 100_000
      }),
      interrupt: async () => {},
      setPermissionMode: async () => {},
      async *[Symbol.asyncIterator]() {
        if (n === 1) {
          const first = await prompt.next()
          if (first.done) return
          yield { type: 'system', subtype: 'init', session_id: 'sess-fold', model: 'test-model' }
          // 턴이 도는 중 두 번째 메시지가 들어온다 — CLI 는 툴 라운드 사이에 진행 중인 턴으로
          // 접어 넣으므로(fold), 두 입력이 소비돼도 result 는 하나뿐이다.
          const second = await prompt.next()
          if (second.done) return
          yield {
            type: 'result',
            subtype: 'success',
            uuid: 'result-fold',
            session_id: 'sess-fold',
            num_turns: 2,
            duration_ms: 5,
            total_cost_usd: 0
          }
          return
        }
        if (n === 2) {
          // 세 번째 메시지를 받기도 전에 죽는다 — 산출이 없었으므로 조용한 자동 재시도가 걸린다.
          throw new Error('query #2 died before first message')
        }
        // n === 3: 재시도로 되살아난 query. recycleInput 이 되살려 넣은 첫 메시지를 기록한다.
        const revived = await prompt.next()
        if (!revived.done) {
          resent.push(String(revived.value.message.content))
        }
        await untilAbort(signal)
      }
    }
  }
}))

describe('ClaudeSession fold accounting', () => {
  it('턴 중 접힌(fold) 메시지 뒤에도 재시작 재생에 유령 메시지를 남기지 않는다', async () => {
    const { ClaudeSession } = await import('./session')
    queryCalls = 0
    started.length = 0
    resent.length = 0

    const items: ChatItem[] = []
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
      emit: () => {},
      persist: (item) => items.push(item),
      requestPermission: async () => ({ behavior: 'deny' as const }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('first')
    const deadline1 = Date.now() + 2_000
    while (Date.now() < deadline1 && started.length < 1) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // 턴이 도는 중 — fold 로 같은 턴에 접혀 result 하나로 끝난다.
    session.send('second')

    // n=1 의 result 가 처리되어 턴이 idle 로 닫힐 때까지 기다린다.
    const deadline2 = Date.now() + 2_000
    while (Date.now() < deadline2 && !items.some((i) => i.type === 'result')) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // 완전히 무관한 다음 턴 — query(#2)가 곧바로 죽어 자동 재시도(#3)를 부른다.
    session.send('third')

    const deadline3 = Date.now() + 2_000
    while (Date.now() < deadline3 && started.length < 3) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // n=3 이 되살려 받은 첫 메시지를 기록할 시간을 준다.
    await new Promise((r) => setTimeout(r, 50))

    session.dispose()

    // 회귀 지점: inFlight 를 하나씩만 shift 했다면 접힌 "second" 가 유령으로 남아, "third" 대신
    // "second" 가 먼저 재생된다.
    expect(resent).toEqual(['third'])
  }, 20_000)
})
