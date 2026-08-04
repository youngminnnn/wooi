import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * 재시작된 query 도 스톨 워치독의 보호를 받는지 검증한다(회귀 방지).
 *
 * `sawAnyMessage` 는 "이 query 가 메시지를 하나라도 받았는지" 를 뜻하는 **query 단위** 상태다.
 * 과거에는 이 값이 run() 마다 리셋되지 않아 세션 단위로 누적됐고, 그래서 첫 query 가 메시지를
 * 한 번 받고 나면 이어지는 재시도 query 는 워치독이 `if (this.sawAnyMessage) return` 으로
 * 즉시 빠져나가 **스톨 보호를 전혀 받지 못했다**(무한 로딩). 아래 시나리오가 정확히 그 경로다 —
 * query #1 은 init 까지 받고 산출 없이 실패해 재시작을 부르고, query #2 는 시작부터 스톨한다.
 */

let queryCalls = 0
const started: number[] = []
/** 두 번째(재시작된) query 가 어떻게 실패할지. */
let secondQueryMode: 'stall' | 'die' = 'stall'

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

/** resume 대상 트랜스크립트가 디스크에 남아 있는지(테스트가 조작한다). */
let transcriptOnDisk = true
vi.mock('./sessionFiles', () => ({
  sessionTranscriptExists: () => transcriptOnDisk
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
    prompt: AsyncGenerator<unknown>
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
          // 첫 프로세스: 입력을 받고 init 까지 낸 뒤, 산출 없이 실패한다 → 자동 재시작을 부른다.
          const first = await prompt.next()
          if (first.done) return
          yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' }
          yield { type: 'result', subtype: 'error_during_execution', num_turns: 1 }
          await untilAbort(signal)
          return
        }
        // 두 번째 프로세스: 첫 메시지 전에 죽거나(die), 시작부터 스톨한다(stall).
        // stall 은 워치독이 살아 있어야만 끊긴다.
        if (secondQueryMode === 'die') throw new Error('spawn failed before first message')
        await untilAbort(signal)
      }
    }
  }
}))

beforeAll(() => {
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-watchdog-'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeSession stall watchdog', () => {
  it('첫 query 가 메시지를 받은 뒤여도, 재시작된 query 의 스톨을 워치독이 끊는다', async () => {
    const { ClaudeSession } = await import('./session')
    queryCalls = 0
    started.length = 0

    const items: ChatItem[] = []
    const events: ChatEvent[] = []
    vi.useFakeTimers()

    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
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

    // query #1 이 실패하고 재시작이 걸려 query #2 가 뜰 때까지.
    await vi.advanceTimersByTimeAsync(100)
    expect(started).toEqual([1, 2])
    // 아직 워치독 상한 전이므로 스톨 오류는 없어야 한다.
    expect(items.filter((i) => i.type === 'error')).toHaveLength(0)

    // 워치독 상한(180초)을 넘긴다.
    await vi.advanceTimersByTimeAsync(200_000)

    // 회귀 지점: sawAnyMessage 가 리셋되지 않으면 워치독이 즉시 return 해 아무 일도 일어나지 않고,
    // 사용자는 무한 로딩에 갇힌다.
    const errors = items.filter((i) => i.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].text).toContain('took too long')
    // 무한 로딩이 아니라 명확한 상태로 정착해야 한다.
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)

    session.dispose()
  }, 20_000)

  it('재시작된 query 가 첫 메시지 전에 죽고 트랜스크립트도 사라졌으면 새 세션으로 폴백한다', async () => {
    const { ClaudeSession } = await import('./session')
    queryCalls = 0
    started.length = 0
    secondQueryMode = 'die'
    // resume 대상 맥락이 디스크에서 사라진 상황(CLI 의 cleanupPeriodDays 정리 등).
    transcriptOnDisk = false

    const items: ChatItem[] = []
    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp,
      emit: () => {},
      persist: (i) => items.push(i),
      requestPermission: async () => ({ behavior: 'deny' as const }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && started.length < 3) await new Promise((r) => setTimeout(r, 20))
    session.dispose()

    // 회귀 지점: sawAnyMessage 가 누적되면 canFallbackFresh 가 영영 성립하지 않아 폴백 없이
    // 오류로만 끝난다. 리셋되면 맥락을 포기하고 새 세션으로 1회 다시 시도한다.
    expect(items.some((i) => i.type === 'system' && i.text.includes("Couldn't restore"))).toBe(true)
    expect(started.length).toBeGreaterThanOrEqual(3)

    secondQueryMode = 'stall'
    transcriptOnDisk = true
  }, 20_000)
})
