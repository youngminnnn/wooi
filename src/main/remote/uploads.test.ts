import { describe, expect, it } from 'vitest'
import { REMOTE_MAX_ATTACHMENT_BYTES, REMOTE_MAX_ATTACHMENTS } from '@shared/remote'
import { RemoteUploads } from './uploads'

function b64(text: string): string {
  return Buffer.from(text).toString('base64')
}

describe('RemoteUploads', () => {
  it('조각을 순서와 무관하게 받아 원본으로 붙인다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 1, 2, b64('world'))
    uploads.chunk('dev-1', 'up-1', 0, 2, b64('hello '))
    expect(uploads.take('dev-1', 'up-1').toString()).toBe('hello world')
  })

  it('꺼내고 나면 사라진다 — 같은 id 를 다시 쓸 수 없다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 1, b64('x'))
    uploads.take('dev-1', 'up-1')
    expect(() => uploads.take('dev-1', 'up-1')).toThrow(/never uploaded/)
    expect(uploads.pendingCount).toBe(0)
  })

  it('조각이 비면 꺼내지 못한다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 3, b64('a'))
    uploads.chunk('dev-1', 'up-1', 2, 3, b64('c'))
    expect(() => uploads.take('dev-1', 'up-1')).toThrow(/incomplete \(2\/3/)
  })

  it('같은 자리를 다시 받으면 덮어쓴다 — 재시도가 실패가 되지 않는다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 2, b64('AA'))
    uploads.chunk('dev-1', 'up-1', 0, 2, b64('aa'))
    uploads.chunk('dev-1', 'up-1', 1, 2, b64('bb'))
    expect(uploads.take('dev-1', 'up-1').toString()).toBe('aabb')
  })

  it('다른 기기의 업로드는 보이지 않는다 — uploadId 는 비밀이 아니다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 1, b64('secret'))
    expect(() => uploads.take('dev-2', 'up-1')).toThrow(/never uploaded/)
    expect(uploads.take('dev-1', 'up-1').toString()).toBe('secret')
  })

  it('조각 수가 도중에 바뀌면 거절한다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 2, b64('a'))
    expect(() => uploads.chunk('dev-1', 'up-1', 1, 3, b64('b'))).toThrow(/chunk count changed/)
  })

  it('첨부 상한을 넘기면 그 업로드를 통째로 버린다', () => {
    const uploads = new RemoteUploads()
    const big = 'x'.repeat(REMOTE_MAX_ATTACHMENT_BYTES + 1)
    expect(() => uploads.chunk('dev-1', 'up-1', 0, 1, b64(big))).toThrow(/larger than/)
    expect(uploads.pendingCount).toBe(0)
  })

  it('기기당 동시 업로드 수를 제한한다', () => {
    const uploads = new RemoteUploads()
    for (let index = 0; index < REMOTE_MAX_ATTACHMENTS; index += 1) {
      uploads.chunk('dev-1', `up-${index}`, 0, 2, b64('a'))
    }
    expect(() => uploads.chunk('dev-1', 'up-extra', 0, 2, b64('a'))).toThrow(/too many uploads/)
  })

  it('오래된 조각은 스스로 사라진다', () => {
    let now = 1_000
    const uploads = new RemoteUploads(() => now)
    uploads.chunk('dev-1', 'up-1', 0, 1, b64('a'))
    now += 10 * 60_000
    expect(() => uploads.take('dev-1', 'up-1')).toThrow(/never uploaded, or it expired/)
  })

  it('조각이 계속 오는 동안에는 만료를 미룬다', () => {
    let now = 1_000
    const uploads = new RemoteUploads(() => now)
    uploads.chunk('dev-1', 'up-1', 0, 2, b64('a'))
    now += 4 * 60_000
    uploads.chunk('dev-1', 'up-1', 1, 2, b64('b'))
    now += 4 * 60_000
    expect(uploads.take('dev-1', 'up-1').toString()).toBe('ab')
  })

  it('페어링이 끊긴 기기의 조각을 버린다', () => {
    const uploads = new RemoteUploads()
    uploads.chunk('dev-1', 'up-1', 0, 1, b64('a'))
    uploads.forget('dev-1')
    expect(uploads.pendingCount).toBe(0)
  })
})
