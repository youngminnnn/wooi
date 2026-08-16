import { RequestError, type ClientContext } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { isMethodNotFoundError, requestExtension } from './ext'

function context(request: ClientContext['request']): ClientContext {
  return { request } as ClientContext
}

describe('isMethodNotFoundError', () => {
  it('SDK 의 -32601 오류만 미지원으로 분류한다', () => {
    expect(isMethodNotFoundError(RequestError.methodNotFound('x/test'))).toBe(true)
    expect(isMethodNotFoundError(RequestError.invalidParams())).toBe(false)
    expect(isMethodNotFoundError(new Error('Method not found'))).toBe(false)
  })
})

describe('requestExtension', () => {
  it('지원하는 확장 메서드의 값을 돌려준다', async () => {
    const request = vi.fn().mockResolvedValue({ enabled: true })
    await expect(
      requestExtension<{ enabled: boolean }, { sessionId: string }>(
        context(request),
        'vendor/status',
        { sessionId: 's1' }
      )
    ).resolves.toEqual({ supported: true, value: { enabled: true } })
  })

  it('method_not_found 는 기능 미지원 값으로 낮춘다', async () => {
    const request = vi.fn().mockRejectedValue(RequestError.methodNotFound('vendor/status'))
    await expect(requestExtension(context(request), 'vendor/status')).resolves.toEqual({
      supported: false,
      reason: 'method_not_found'
    })
  })

  it('실제 실패는 호출부가 처리하도록 다시 던진다', async () => {
    const failure = RequestError.internalError({ detail: 'broken' })
    const request = vi.fn().mockRejectedValue(failure)
    await expect(requestExtension(context(request), 'vendor/status')).rejects.toBe(failure)
  })
})
