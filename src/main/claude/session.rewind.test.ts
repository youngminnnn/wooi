import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent, ChatItem } from '@shared/types'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

/**
 * /rewind 가 실제로 되돌릴 수 있는 상태인지 검증한다.
 *
 * 회귀 배경: 체크포인트는 **CLI 가 보낸 사용자 메시지를 uuid 와 함께 되돌려 보내 줄 때만**
 * 만들어진다. 그 echo 는 `--replay-user-messages` 없이는 오지 않는데, Agent SDK 는 그 플래그를
 * 자체 옵션으로 노출하지도, 대신 넘겨 주지도 않는다. 그래서 extraArgs 로 직접 넘기기 전까지
 * 체크포인트는 늘 0개였고 /rewind 패널은 언제나 비어 있었다 — 배선은 끝까지 이어져 있는데
 * 기능만 죽어 있는, 타입으로는 잡히지 않는 종류의 고장이다.
 *
 * 아래 가짜 query 는 실제 CLI 처럼 **플래그가 있을 때만** echo 를 낸다.
 */

/** 마지막으로 query 에 넘어간 옵션(플래그·resumeSessionAt 관찰점). */
let lastOptions: Record<string, unknown>
/** query 가 몇 번 열렸는지 — 대화 되돌리기가 프로세스를 갈아 끼우는지 본다. */
let queryCount: number
let rewindFilesCalls: string[]
/** rewindFiles 가 돌려줄 값. 통계 필드가 없는 CLI 응답을 흉내 낼 수 있다. */
let rewindFilesResult: Record<string, unknown>
/** true 면 매 턴 앞에 "우리가 보내지 않은" 사용자 메시지를 하나 끼워 넣는다(자동 /compact 주입). */
let injectStrayUser: boolean

vi.mock('./mcp', () => ({
  MCP_SETTING_SOURCES: ['user', 'project', 'local'],
  resolveUserMcpServers: () => ({})
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({
    prompt,
    options
  }: {
    prompt: AsyncGenerator<unknown>
    options: Record<string, unknown>
  }) => {
    lastOptions = options
    queryCount++
    const replay = (options.extraArgs as Record<string, unknown> | undefined)?.[
      'replay-user-messages'
    ]
    // 실제 CLI 와 같다 — 플래그를 켠 클라이언트에게만 사용자 메시지를 되돌려 보낸다.
    const replayEnabled = replay !== undefined
    let seq = 0
    return {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      rewindFiles: async (id: string) => {
        rewindFilesCalls.push(id)
        return rewindFilesResult
      },
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'test-model' }
        // 실제 SDK 처럼 abortController 를 지킨다 — 세션이 프로세스를 갈아 끼우는 유일한 손잡이라,
        // 이걸 무시하면 재시작 경로가 테스트에서만 멈춘 것처럼 보인다.
        const signal = (options.abortController as AbortController | undefined)?.signal
        const aborted = new Promise<'aborted'>((resolve) => {
          signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
        while (!signal?.aborted) {
          const next = await Promise.race([prompt.next(), aborted])
          if (next === 'aborted' || next.done) return
          const m = next.value as { message: { content: unknown }; uuid?: string }
          seq++
          if (replayEnabled && injectStrayUser) {
            // 실제 CLI 도 자동 /compact 처럼 우리가 보내지 않은 사용자 메시지를 echo 한다 —
            // 그때 CLI 가 스스로 붙인 uuid 를 단다.
            yield {
              type: 'user',
              message: { role: 'user', content: '/compact' },
              uuid: `stray-${seq}`,
              isReplay: true,
              session_id: 'sess-1'
            }
          }
          if (replayEnabled) {
            // 실제 CLI 와 같다 — 클라이언트가 uuid 를 실어 보내면 그 값을 그대로 쓴다.
            yield {
              type: 'user',
              message: m.message,
              uuid: m.uuid ?? `u-${seq}`,
              isReplay: true,
              session_id: 'sess-1'
            }
          }
          yield {
            type: 'assistant',
            uuid: `a-${seq}`,
            message: { content: [{ type: 'text', text: 'ok' }] },
            session_id: 'sess-1'
          }
          yield { type: 'result', subtype: 'success', num_turns: 1, session_id: 'sess-1' }
        }
      }
    }
  }
}))

beforeAll(() => {
  process.env.WOOI_USER_DATA = mkdtempSync(join(tmpdir(), 'wooi-rewind-'))
})

async function makeSession() {
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
  return { session, items, events }
}

/** 체크포인트가 n 개 쌓일 때까지(또는 시간이 다할 때까지) 기다린다. */
async function waitForCheckpoints(
  session: { getCheckpoints: () => unknown[] },
  n: number
): Promise<unknown[]> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && session.getCheckpoints().length < n) {
    await new Promise((r) => setTimeout(r, 20))
  }
  return session.getCheckpoints()
}

describe('ClaudeSession /rewind', () => {
  beforeEach(() => {
    queryCount = 0
    rewindFilesCalls = []
    rewindFilesResult = { canRewind: true }
    injectStrayUser = false
  })

  it('보낸 메시지마다 체크포인트가 쌓인다 — echo 플래그를 켠 덕분에', async () => {
    const { session, items } = await makeSession()
    session.send('first message')
    await waitForCheckpoints(session, 1)
    session.send('second message')
    const checkpoints = (await waitForCheckpoints(session, 2)) as {
      userMessageId: string
      itemId: string
      forkAt: string | null
      text: string
    }[]
    session.dispose()

    // 회귀 지점: 이 플래그가 빠지면 아래 기대는 전부 0개로 무너진다.
    expect(lastOptions.extraArgs).toHaveProperty('replay-user-messages')
    expect(checkpoints).toHaveLength(2)

    // 최근이 위로 온다.
    expect(checkpoints[0].text).toBe('second message')
    expect(checkpoints[1].text).toBe('first message')

    // 화면 트랜스크립트의 같은 메시지를 가리켜야 대화 되돌리기가 어디를 자를지 안다.
    const userItems = items.filter((i) => i.type === 'user')
    expect(checkpoints[1].itemId).toBe(userItems[0].id)
    expect(checkpoints[0].itemId).toBe(userItems[1].id)

    // forkAt 은 "남길 마지막 항목" 이다 — 첫 메시지 앞에는 아무것도 없고, 두 번째 앞에는 첫 턴의
    // assistant 응답이 있다. 이 값이 어긋나면 되돌리기가 한 턴씩 밀린다.
    expect(checkpoints[1].forkAt).toBeNull()
    expect(checkpoints[0].forkAt).toBe('a-1')
  }, 15_000)

  it('silent 전송은 체크포인트를 만들지 않는다', async () => {
    const { session } = await makeSession()
    session.send('background work', undefined, { silent: true })
    session.send('real message')
    const checkpoints = (await waitForCheckpoints(session, 1)) as { text: string }[]
    session.dispose()

    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].text).toBe('real message')
  }, 15_000)

  it('우리가 보내지 않은 메시지 echo 가 체크포인트를 훔치지 않는다', async () => {
    // 회귀 지점: 예전 설계는 "보낸 순서대로 echo 를 받아" 짝지었다. 자동 /compact 처럼 send() 를
    // 거치지 않고 입력 큐로 직접 들어가는 메시지가 하나 끼면 그 뒤로 라벨과 되돌아갈 지점이
    // 통째로 한 칸씩 밀린다 — 되돌리기가 조용히 엉뚱한 지점을 가리키게 되는 종류의 고장이다.
    injectStrayUser = true
    const { session, items } = await makeSession()
    session.send('first message')
    await waitForCheckpoints(session, 1)
    session.send('second message')
    const checkpoints = (await waitForCheckpoints(session, 2)) as {
      text: string
      itemId: string
    }[]
    session.dispose()

    expect(checkpoints.map((c) => c.text)).toEqual(['second message', 'first message'])
    const userItems = items.filter((i) => i.type === 'user')
    expect(checkpoints[1].itemId).toBe(userItems[0].id)
    expect(checkpoints[0].itemId).toBe(userItems[1].id)
  }, 15_000)

  it('files 모드는 파일만 되돌리고 대화는 건드리지 않는다', async () => {
    rewindFilesResult = { canRewind: true, filesChanged: ['a.ts'], insertions: 3, deletions: 1 }
    const { session } = await makeSession()
    session.send('one')
    const [cp] = (await waitForCheckpoints(session, 1)) as { userMessageId: string }[]

    const result = await session.rewind(cp.userMessageId, 'files')
    session.dispose()

    expect(rewindFilesCalls).toEqual([cp.userMessageId])
    expect(result.canRewind).toBe(true)
    expect(result.filesChanged).toEqual(['a.ts'])
    // 대화는 그대로다 — 메인이 트랜스크립트를 자를 이유가 없어야 한다.
    expect(result.conversationRewound).toBeUndefined()
    expect(result.truncateFromItemId).toBeUndefined()
  }, 15_000)

  it('통계를 안 주는 CLI 응답에 0 을 지어내지 않는다', async () => {
    rewindFilesResult = { canRewind: true, skippedLinks: 2 }
    const { session } = await makeSession()
    session.send('one')
    const [cp] = (await waitForCheckpoints(session, 1)) as { userMessageId: string }[]

    const result = await session.rewind(cp.userMessageId, 'files')
    session.dispose()

    // 없는 값을 0 으로 채우면 화면에 "0개 복원" 이 떠 성공이 실패처럼 읽힌다.
    expect(result.filesChanged).toBeUndefined()
    expect(result.insertions).toBeUndefined()
    expect(result.skippedLinks).toBe(2)
  }, 15_000)

  it('conversation 모드는 자를 지점을 알려 주고 다음 query 를 그 지점으로 연다', async () => {
    const { session, items } = await makeSession()
    session.send('one')
    await waitForCheckpoints(session, 1)
    session.send('two')
    const checkpoints = (await waitForCheckpoints(session, 2)) as {
      userMessageId: string
      itemId: string
    }[]
    const second = checkpoints[0]
    const before = queryCount

    const result = await session.rewind(second.userMessageId, 'conversation')

    expect(rewindFilesCalls).toEqual([])
    expect(result.conversationRewound).toBe(true)
    // 메인이 화면 트랜스크립트에서 잘라 낼 지점 = 그 사용자 메시지 자신.
    expect(result.truncateFromItemId).toBe(items.filter((i) => i.type === 'user')[1].id)
    expect(result.sessionReset).toBeUndefined()
    // 이 지점부터의 체크포인트는 사라진 대화를 가리키므로 함께 버려진다.
    expect(session.getCheckpoints()).toHaveLength(1)

    // 프로세스를 갈아 끼우고, 새 query 는 첫 턴 끝까지만 불러온다.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && queryCount === before) {
      await new Promise((r) => setTimeout(r, 20))
    }
    session.dispose()
    expect(queryCount).toBeGreaterThan(before)
    expect(lastOptions.resume).toBe('sess-1')
    expect(lastOptions.resumeSessionAt).toBe('a-1')
  }, 15_000)

  it('첫 메시지로 되돌리면 남길 맥락이 없다 — 새 세션으로 알린다', async () => {
    const { session } = await makeSession()
    session.send('one')
    const [cp] = (await waitForCheckpoints(session, 1)) as { userMessageId: string }[]

    const result = await session.rewind(cp.userMessageId, 'conversation')
    session.dispose()

    expect(result.sessionReset).toBe(true)
    expect(result.conversationRewound).toBe(true)
  }, 15_000)

  it('both 에서 파일 되돌리기가 실패하면 대화는 손대지 않는다', async () => {
    rewindFilesResult = { canRewind: false, error: 'no backup for that message' }
    const { session } = await makeSession()
    session.send('one')
    await waitForCheckpoints(session, 1)
    session.send('two')
    const checkpoints = (await waitForCheckpoints(session, 2)) as { userMessageId: string }[]

    const result = await session.rewind(checkpoints[0].userMessageId, 'both')
    session.dispose()

    expect(result.canRewind).toBe(false)
    expect(result.error).toContain('no backup')
    // 반만 되돌아간 상태가 제일 나쁘다 — 대화 절단 지시가 나가면 안 된다.
    expect(result.truncateFromItemId).toBeUndefined()
    expect(session.getCheckpoints()).toHaveLength(2)
  }, 15_000)

  it('모르는 체크포인트는 거절한다', async () => {
    const { session } = await makeSession()
    session.send('one')
    await waitForCheckpoints(session, 1)

    const result = await session.rewind('nope', 'both')
    session.dispose()

    expect(result.canRewind).toBe(false)
    expect(result.error).toContain('no longer available')
  }, 15_000)
})
