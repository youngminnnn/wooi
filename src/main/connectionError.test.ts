import { describe, expect, it } from 'vitest'
import { isConnectionError } from './connectionError'

describe('isConnectionError', () => {
  it('사용자가 실제로 본 문구를 알아본다', () => {
    // 이 판정이 없어서 이어가기가 걸리지 않았던 바로 그 오류다.
    expect(
      isConnectionError(
        "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
      )
    ).toBe(true)
  })

  it('Node 가 던지는 연결 오류 코드들을 알아본다', () => {
    for (const text of [
      'unknown getaddrinfo EAI_AGAIN api.anthropic.com',
      'connect ECONNREFUSED 127.0.0.1:443',
      'read ECONNRESET',
      'TypeError: fetch failed',
      'socket hang up',
      'connect ETIMEDOUT'
    ]) {
      expect(isConnectionError(text), text).toBe(true)
    }
  })

  it('연결과 무관한 실패는 잡지 않는다 — 잡으면 영영 재시도만 한다', () => {
    for (const text of [
      null,
      '',
      'API Error: 401 Unauthorized',
      'Claude AI usage limit reached|1754880000',
      'User denied permission',
      'Error: ENOENT: no such file or directory'
    ]) {
      expect(isConnectionError(text), String(text)).toBe(false)
    }
  })
})
