import { describe, it, expect, vi } from 'vitest'
import { RpcClient, RpcError, type RpcStreams } from './jsonrpc'

/**
 * 프레이밍·상관 계층은 실제 codex 없이 전부 검증할 수 있다 — 가짜 스트림만 물리면 된다.
 * 여기서 잡아야 하는 것들은 하나같이 실제로 터지면 원인 파악이 어려운 종류다:
 * 청크 경계에서 잘린 JSON, 순서가 뒤바뀐 응답, 응답 없이 매달리는 서버 요청 등.
 */

interface Harness {
  client: RpcClient
  /** 서버가 보낸 것처럼 원시 바이트를 흘려보낸다. */
  feed: (chunk: string | Buffer) => void
  /** 클라이언트가 써 보낸 줄들(파싱된 형태). */
  sent: () => Record<string, unknown>[]
  notifications: [string, unknown][]
}

function harness(handlers?: Record<string, (params: unknown) => unknown>): Harness {
  let onData: ((chunk: Buffer | string) => void) | null = null
  const written: string[] = []
  const notifications: [string, unknown][] = []

  const streams: RpcStreams = {
    readable: {
      on: (_event, cb) => {
        onData = cb
      }
    },
    writable: { write: (chunk) => written.push(chunk) }
  }

  const client = new RpcClient(streams, {
    onNotification: (method, params) => notifications.push([method, params]),
    requestHandlers: handlers,
    timeoutMs: 200
  })

  return {
    client,
    feed: (chunk) => onData?.(chunk as Buffer),
    sent: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    notifications
  }
}

describe('프레이밍', () => {
  it('여러 청크에 걸쳐 잘린 JSON 을 이어 붙인다', async () => {
    const h = harness()
    const promise = h.client.request('thread/start')
    h.feed('{"id":1,"resu')
    h.feed('lt":{"thread":{"id":"t1"')
    h.feed('}}}\n')
    await expect(promise).resolves.toEqual({ thread: { id: 't1' } })
  })

  it('한 청크에 담긴 여러 메시지를 모두 처리한다', () => {
    const h = harness()
    h.feed('{"method":"a","params":1}\n{"method":"b","params":2}\n')
    expect(h.notifications).toEqual([
      ['a', 1],
      ['b', 2]
    ])
  })

  it('JSON 문자열 안의 개행(이스케이프)은 메시지를 자르지 않는다', () => {
    const h = harness()
    h.feed('{"method":"log","params":{"text":"line1\\nline2"}}\n')
    expect(h.notifications).toEqual([['log', { text: 'line1\nline2' }]])
  })

  it('빈 줄과 CRLF 를 견딘다', () => {
    const h = harness()
    h.feed('\r\n{"method":"a","params":null}\r\n\r\n')
    expect(h.notifications).toEqual([['a', null]])
  })

  it('비-JSON 줄은 버리고 연결을 유지한다', () => {
    const h = harness()
    // codex 가 stdout 으로 흘리는 로그가 섞여도 죽으면 안 된다.
    h.feed('some stray log line\n{"method":"a","params":null}\n')
    expect(h.notifications).toEqual([['a', null]])
  })

  it('와이어에 jsonrpc 필드를 싣지 않는다 (app-server 규약)', () => {
    const h = harness()
    h.client.notify('initialized')
    expect(h.sent()[0]).not.toHaveProperty('jsonrpc')
  })
})

describe('요청/응답 상관', () => {
  it('응답이 뒤바뀐 순서로 와도 각 요청에 맞게 돌려준다', async () => {
    const h = harness()
    const first = h.client.request('a')
    const second = h.client.request('b')
    // 두 번째 요청의 응답을 먼저 흘려보낸다.
    h.feed('{"id":2,"result":"B"}\n{"id":1,"result":"A"}\n')
    await expect(first).resolves.toBe('A')
    await expect(second).resolves.toBe('B')
  })

  it('에러 응답은 코드와 함께 RpcError 로 거절한다', async () => {
    const h = harness()
    const promise = h.client.request('nope')
    h.feed('{"id":1,"error":{"code":-32601,"message":"Unknown"}}\n')
    await expect(promise).rejects.toMatchObject({ name: 'RpcError', code: -32601 })
  })

  it('응답이 오지 않으면 타임아웃으로 끊는다', async () => {
    const h = harness()
    await expect(h.client.request('slow')).rejects.toThrow(/timed out/)
  })

  it('close() 는 대기 중인 요청을 전부 거절한다', async () => {
    const h = harness()
    const promise = h.client.request('a')
    h.client.close('host died')
    await expect(promise).rejects.toThrow('host died')
  })

  it('모르는 id 의 응답은 무시한다', () => {
    const h = harness()
    expect(() => h.feed('{"id":999,"result":1}\n')).not.toThrow()
  })
})

describe('서버 → 클라이언트 요청', () => {
  it('핸들러 결과를 같은 id 로 응답한다', async () => {
    const h = harness({ 'item/commandExecution/requestApproval': () => ({ decision: 'accept' }) })
    h.feed('{"id":7,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}\n')
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1))
    expect(h.sent()[0]).toEqual({ id: 7, result: { decision: 'accept' } })
  })

  // 무응답은 서버 쪽 턴을 영영 멈춰 세운다 — 반드시 에러로라도 답해야 한다.
  it('핸들러가 없으면 매달리지 않고 method-not-found 로 답한다', async () => {
    const h = harness()
    h.feed('{"id":8,"method":"some/unknownRequest","params":{}}\n')
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1))
    expect(h.sent()[0]).toMatchObject({ id: 8, error: { code: -32601 } })
  })

  it('핸들러가 던져도 에러로 응답하고 연결을 유지한다', async () => {
    const h = harness({
      'item/fileChange/requestApproval': () => {
        throw new Error('boom')
      }
    })
    h.feed('{"id":9,"method":"item/fileChange/requestApproval","params":{}}\n')
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1))
    expect(h.sent()[0]).toMatchObject({ id: 9, error: { message: 'boom' } })

    // 연결은 살아 있어야 한다.
    h.feed('{"method":"still/alive","params":null}\n')
    expect(h.notifications).toEqual([['still/alive', null]])
  })

  // 알림 하나를 처리하다 난 예외가 그 뒤의 알림까지 삼키면, 턴 중간부터 화면이 멈춘다.
  it('한 알림 핸들러가 던져도 이후 알림이 계속 흐른다', () => {
    const seen: string[] = []
    let feed: ((chunk: Buffer | string) => void) | null = null

    new RpcClient(
      {
        readable: {
          on: (_e, cb) => {
            feed = cb
          }
        },
        writable: { write: () => {} }
      },
      {
        onNotification: (method) => {
          seen.push(method)
          if (method === 'boom') throw new Error('handler exploded')
        }
      }
    )

    feed!('{"method":"boom","params":null}\n{"method":"ok","params":null}\n')
    expect(seen).toEqual(['boom', 'ok'])
  })
})

describe('버전 차이 흡수 (tryRequest)', () => {
  it('미지원 메서드는 undefined 를 돌려주고 다시 호출하지 않는다', async () => {
    const h = harness()
    const first = h.client.tryRequest('experimental/thing')
    h.feed('{"id":1,"error":{"code":-32601,"message":"Unknown"}}\n')
    await expect(first).resolves.toBeUndefined()

    const before = h.sent().length
    await expect(h.client.tryRequest('experimental/thing')).resolves.toBeUndefined()
    // 두 번째 호출은 왕복 자체를 하지 않는다.
    expect(h.sent().length).toBe(before)
    expect(h.client.supports('experimental/thing')).toBe(false)
  })

  it('미지원이 아닌 에러는 그대로 던진다', async () => {
    const h = harness()
    const promise = h.client.tryRequest('thing')
    h.feed('{"id":1,"error":{"code":-32603,"message":"Internal"}}\n')
    await expect(promise).rejects.toThrow('Internal')
  })
})

describe('과부하 재시도', () => {
  it('-32001 은 백오프 후 재시도해 결국 성공한다', async () => {
    const h = harness()
    const promise = h.client.request('busy', undefined, 5_000)

    // 첫 시도는 과부하로 거절.
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1))
    h.feed('{"id":1,"error":{"code":-32001,"message":"Server overloaded; retry later."}}\n')

    // 재시도가 새 id 로 나가야 한다.
    await vi.waitFor(() => expect(h.sent()).toHaveLength(2), { timeout: 2000 })
    h.feed('{"id":2,"result":"done"}\n')

    await expect(promise).resolves.toBe('done')
  })
})

describe('RpcError', () => {
  it('코드를 보존한다', () => {
    expect(new RpcError('x', -32601).code).toBe(-32601)
  })
})
