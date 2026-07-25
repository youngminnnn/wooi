import { describe, it, expect } from 'vitest'
import { AsyncQueue } from './asyncQueue'

/** 다음 매크로태스크까지 양보한다(async generator 본문이 대기 지점까지 진행하도록). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('AsyncQueue', () => {
  it('push 한 순서대로 흘려보내고 close 로 종료된다', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    const got: number[] = []
    for await (const v of q) got.push(v)
    expect(got).toEqual([1, 2])
  })

  it('isClosed 로 닫힘 여부를 알 수 있고, 닫힌 뒤 push 는 무시된다', () => {
    const q = new AsyncQueue<number>()
    expect(q.isClosed).toBe(false)
    q.close()
    expect(q.isClosed).toBe(true)
    q.push(1)
    expect(q.drain()).toEqual([])
  })

  it('drain 은 아직 소비되지 않은 값을 꺼내고 큐를 비운다', () => {
    const q = new AsyncQueue<string>()
    q.push('a')
    q.push('b')
    expect(q.drain()).toEqual(['a', 'b'])
    expect(q.drain()).toEqual([])
  })

  it('close 는 대기 중인 소비자를 done 으로 풀어 준다', async () => {
    const q = new AsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const pending = it.next()
    await tick()
    q.close()
    expect((await pending).done).toBe(true)
  })

  // 죽은 query 를 재시도할 때 큐를 **재사용하지 않고 교체하는** 이유를 고정한다.
  it('버려진 소비자가 대기 resolver 를 남겨 이후 push 를 가로챈다', async () => {
    const q = new AsyncQueue<number>()
    // 중단된 promptStream 을 흉내낸다 — 값이 없어 대기하다 그대로 방치된 소비자.
    const abandoned = q[Symbol.asyncIterator]()
    const pending = abandoned.next()
    await tick()

    q.push(1)

    // 새 소비자가 아니라 버려진 소비자에게 배달된다 → 큐를 재사용하면 메시지가 조용히 사라진다.
    expect((await pending).value).toBe(1)
    expect(q.drain()).toEqual([])
  })

  it('drain + 새 큐 교체로 미처리 메시지를 순서대로 이월한다', async () => {
    // ClaudeSession.recycleInput 과 같은 절차: inFlight(이미 SDK 가 꺼내 간 것) 뒤에 미소비분을 붙인다.
    const old = new AsyncQueue<string>()
    old.push('queued-1')
    old.push('queued-2')
    const carried = ['in-flight', ...old.drain()]
    old.close()

    const fresh = new AsyncQueue<string>()
    for (const m of carried) fresh.push(m)
    fresh.close()

    const got: string[] = []
    for await (const v of fresh) got.push(v)
    expect(got).toEqual(['in-flight', 'queued-1', 'queued-2'])
  })
})
