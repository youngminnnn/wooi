import { describe, it, expect, vi } from 'vitest'
import { CodexThread, threadStatusType } from './thread'
import { NOTIFY, RPC } from './wire'
import type { ChatEvent, ChatItem } from '@shared/types'
import type { RpcClient } from './jsonrpc'

/**
 * 승인 프롬프트에 실을 diff 는 **승인 요청에 들어 있지 않다** — 같은 itemId 의 fileChange
 * 아이템이 먼저 도착하므로 그걸 붙잡아 뒀다가 꺼내 쓴다.
 *
 * 실물로 확인한 순서(codex 0.146.0):
 *   item/started(fileChange, changes=1) → item/fileChange/requestApproval → item/completed
 *
 * 이 순서가 깨지거나 추적을 놓치면 사용자가 **내용을 못 보고 패치를 승인**하게 되므로 고정해 둔다.
 */

function makeThread() {
  const events: ChatEvent[] = []
  const persisted: ChatItem[] = []
  const thread = new CodexThread(
    'ws1',
    {
      cwd: '/tmp/wt',
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      delegateBackends: [],
      delegateInstructions: null,
      resumeThreadId: null
    },
    {
      rpc: () => Promise.reject(new Error('not used')),
      emit: (e) => events.push(e),
      persist: (i) => persisted.push(i),
      onThreadId: () => {},
      settleIdle: () => {}
    }
  )
  return { thread, events, persisted }
}

const CHANGES = [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }]

describe('승인용 diff 추적', () => {
  it('item/started 로 온 changes 를 itemId 로 꺼낼 수 있다', () => {
    const { thread } = makeThread()
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f1', type: 'fileChange', status: 'inProgress', changes: CHANGES }
    })
    expect(thread.fileChanges('f1')).toEqual(CHANGES)
  })

  it('아이템이 확정되면 버려 메모리가 새지 않는다', () => {
    const { thread } = makeThread()
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f1', type: 'fileChange', changes: CHANGES }
    })
    thread.handleNotification(NOTIFY.itemCompleted, {
      item: { id: 'f1', type: 'fileChange', status: 'completed', changes: CHANGES }
    })
    expect(thread.fileChanges('f1')).toEqual([])
  })

  it('모르는 itemId 는 빈 배열(프롬프트는 뜨되 diff 만 비어 있다)', () => {
    const { thread } = makeThread()
    expect(thread.fileChanges('nope')).toEqual([])
  })

  it('여러 패치가 동시에 대기해도 서로 섞이지 않는다', () => {
    const { thread } = makeThread()
    const other = [{ path: 'b.ts', kind: 'add', diff: '@@ b @@' }]
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f1', type: 'fileChange', changes: CHANGES }
    })
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f2', type: 'fileChange', changes: other }
    })
    expect(thread.fileChanges('f1')).toEqual(CHANGES)
    expect(thread.fileChanges('f2')).toEqual(other)
  })

  // 이게 없으면 사용자가 옛 diff 를 보고 새 내용을 승인하게 된다.
  it('패치가 갱신되면 승인에 실을 diff 도 새것으로 바뀐다', () => {
    const { thread } = makeThread()
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f1', type: 'fileChange', changes: CHANGES }
    })
    const revised = [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+revised' }]
    thread.handleNotification(NOTIFY.fileChangePatchUpdated, {
      threadId: 'thr_1',
      turnId: 't1',
      itemId: 'f1',
      changes: revised
    })
    expect(thread.fileChanges('f1')).toEqual(revised)
  })

  it('빈 갱신은 붙잡아 둔 diff 를 지우지 않는다', () => {
    const { thread } = makeThread()
    thread.handleNotification(NOTIFY.itemStarted, {
      item: { id: 'f1', type: 'fileChange', changes: CHANGES }
    })
    thread.handleNotification(NOTIFY.fileChangePatchUpdated, { itemId: 'f1', changes: [] })
    expect(thread.fileChanges('f1')).toEqual(CHANGES)
  })
})

describe('컨텍스트 사용량 추적', () => {
  // codex 에는 "지금 사용량을 알려 달라"는 조회 API 가 없다 — 흘러가는 알림을 붙잡아 둬야
  // /context 카드가 언제든 답할 수 있다.
  it('토큰 사용량 알림을 붙잡아 두었다가 돌려준다', () => {
    const { thread } = makeThread()
    expect(thread.contextUsage()).toBeNull()
    thread.handleNotification(NOTIFY.tokenUsage, {
      tokenUsage: { last: { inputTokens: 17100 }, modelContextWindow: 258400 }
    })
    expect(thread.contextUsage()).toEqual({
      usedTokens: 17100,
      maxTokens: 258400,
      percentage: 17100 / 258400
    })
  })
})

describe('턴 추적', () => {
  it.each([
    ['active', 'active'],
    [{ type: 'active', activeFlags: [] }, 'active'],
    [{ type: 'idle' }, 'idle'],
    [undefined, null]
  ])('스레드 상태 %j 를 %j 로 정규화한다', (input, expected) => {
    expect(threadStatusType(input)).toBe(expected)
  })

  it('turn/started 의 id 를 기억하고 완료 시 놓는다', () => {
    const { thread, events } = makeThread()
    thread.handleNotification(NOTIFY.turnStarted, { turn: { id: 't1', status: 'inProgress' } })
    expect(events.some((e) => e.type === 'status' && e.status === 'running')).toBe(true)

    thread.handleNotification(NOTIFY.turnCompleted, { turn: { id: 't1', status: 'completed' } })
    expect(events.at(-1)).toEqual({ type: 'status', status: 'idle' })
  })

  it('재개된 기존 턴의 active 상태로 running 을 복구한다', () => {
    const { thread, events } = makeThread()
    thread.handleNotification(NOTIFY.threadStatusChanged, {
      threadId: 'thr_1',
      status: { type: 'active', activeFlags: [] }
    })
    expect(events).toContainEqual({ type: 'status', status: 'running' })
  })

  it('thread idle 은 turn/completed 와 중복되므로 상태 이벤트를 내지 않는다', () => {
    const { thread, events } = makeThread()
    thread.handleNotification(NOTIFY.threadStatusChanged, {
      threadId: 'thr_1',
      status: { type: 'idle' }
    })
    expect(events).toEqual([])
  })
})

describe('알 수 없는 입력', () => {
  it('같은 종류는 unknown 아이템을 한 번만 방출하고 저장한다', () => {
    const { thread, events, persisted } = makeThread()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => {
      thread.handleNotification(NOTIFY.itemCompleted, { item: { id: 'x', type: 'brandNewThing' } })
      thread.handleNotification(NOTIFY.itemCompleted, { item: { id: 'y', type: 'brandNewThing' } })
    }).not.toThrow()
    expect(events.filter((e) => e.type === 'item' && e.item.type === 'unknown')).toHaveLength(1)
    expect(persisted.filter((item) => item.type === 'unknown')).toHaveLength(1)
    warn.mockRestore()
  })

  it.each([
    { supported: false, expected: 1 },
    { supported: true, expected: 0 }
  ])(
    'steer 지원 여부가 $supported 이면 unknown 카드가 $expected개다',
    async ({ supported, expected }) => {
      const events: ChatEvent[] = []
      const persisted: ChatItem[] = []
      const rpc = {
        supports: vi.fn(() => supported),
        tryRequest: vi.fn(async () => undefined),
        request: vi.fn(async (method: string) => {
          if (method === RPC.threadStart) return { thread: { id: 'thr1' } }
          if (method === RPC.turnStart) return { turn: { id: 'turn2' } }
          return {}
        })
      } as unknown as RpcClient
      const thread = new CodexThread(
        'ws1',
        {
          cwd: '/tmp/wt',
          model: null,
          effort: null,
          fastMode: false,
          permissionMode: 'default',
          delegateBackends: [],
          delegateInstructions: null,
          resumeThreadId: null
        },
        {
          rpc: async () => rpc,
          emit: (event) => events.push(event),
          persist: (item) => persisted.push(item),
          onThreadId: () => {},
          settleIdle: () => {}
        }
      )
      thread.handleNotification(NOTIFY.turnStarted, { turn: { id: 'turn1' } })

      await thread.send('follow-up')

      expect(events.filter((e) => e.type === 'item' && e.item.type === 'unknown')).toHaveLength(
        expected
      )
      expect(persisted.filter((item) => item.type === 'unknown')).toHaveLength(expected)
    }
  )
})
