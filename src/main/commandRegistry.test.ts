import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * electron 의 ipcMain 만 목킹한다(github.test.ts 가 child_process 를 목킹하는 방식과 같다).
 * 레지스트리는 Electron 런타임 없이 동작해야 — 그래야 vitest 의 node 환경에서 돌릴 수 있다.
 */
const registered = new Map<string, unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => registered.set(channel, fn),
    removeHandler: (channel: string) => registered.delete(channel)
  }
}))

const { handle, hasCommand, invokeCommand, __resetRegistry, __registeredChannels } =
  await import('./commandRegistry')

beforeEach(() => {
  __resetRegistry()
  registered.clear()
})

describe('handle()', () => {
  it('ipcMain 과 레지스트리 양쪽에 등록한다', () => {
    const fn = vi.fn()
    handle('test:channel', fn)
    expect(registered.get('test:channel')).toBe(fn)
    expect(hasCommand('test:channel')).toBe(true)
    expect(__registeredChannels()).toEqual(['test:channel'])
  })

  it('__resetRegistry 는 ipcMain 등록도 함께 해제한다', () => {
    handle('test:channel', vi.fn())
    __resetRegistry()
    expect(hasCommand('test:channel')).toBe(false)
    expect(registered.has('test:channel')).toBe(false)
  })
})

describe('invokeCommand()', () => {
  it('인자를 그대로 넘기고 반환값을 돌려준다', async () => {
    handle('sum', ((_e: unknown, a: number, b: number) => a + b) as never)
    await expect(invokeCommand('sum', [2, 3])).resolves.toBe(5)
  })

  it('비동기 핸들러를 await 한다', async () => {
    handle('slow', (async () => 'done') as never)
    await expect(invokeCommand('slow', [])).resolves.toBe('done')
  })

  it('미등록 채널은 throw 한다', async () => {
    await expect(invokeCommand('nope', [])).rejects.toThrow(/unknown command channel/)
  })

  it('핸들러가 던진 에러를 전파한다', async () => {
    handle('boom', (() => {
      throw new Error('handler failed')
    }) as never)
    await expect(invokeCommand('boom', [])).rejects.toThrow('handler failed')
  })
})

describe('합성 event 프록시', () => {
  it('event.sender 접근에서 즉시 터진다', async () => {
    handle('peek', ((e: { sender: unknown }) => e.sender) as never)
    await expect(invokeCommand('peek', [])).rejects.toThrow(/not available off-renderer/)
  })

  it('임의의 프로퍼티 접근도 막는다', async () => {
    handle('peek2', ((e: Record<string, unknown>) => e.frameId) as never)
    await expect(invokeCommand('peek2', [])).rejects.toThrow(/event\.frameId/)
  })

  it('await 경로(then 검사)와 심볼 접근은 견딘다', async () => {
    // 핸들러가 event 를 건드리지 않으면, 프록시가 await/로깅 경로에서 터지면 안 된다.
    handle('quiet', ((e: unknown) => {
      // 심볼 접근(로깅·형변환 경로)은 undefined 를 돌려줘야 한다.
      expect((e as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined()
      return 'ok'
    }) as never)
    await expect(invokeCommand('quiet', [])).resolves.toBe('ok')
  })
})
