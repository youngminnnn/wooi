import { describe, expect, it } from 'vitest'
import { REMOTE_UPLOAD_CHUNK_BYTES } from '@shared/remote'
import { CHUNK_BASE64_CHARS, base64Bytes, chunkBase64 } from './chunks'

/**
 * 이 파일이 지키는 것은 하나다: **조각 하나하나가 그 자체로 유효한 base64 여야 한다.**
 * 아니면 랩탑이 조각을 붙였을 때 원본과 다른 바이트가 나오는데, 증상은 "사진이 깨진다" 뿐이라
 * 어디서 어긋났는지 짚을 수가 없다.
 */
function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function sample(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let at = 0; at < length; at += 1) bytes[at] = (at * 31 + 7) % 256
  return bytes
}

describe('청크', () => {
  it('청크 크기가 3의 배수라 조각 경계가 base64 그룹과 맞아떨어진다', () => {
    expect(REMOTE_UPLOAD_CHUNK_BYTES % 3).toBe(0)
    expect(CHUNK_BASE64_CHARS % 4).toBe(0)
  })

  it('붙이면 원본으로 돌아온다', () => {
    for (const length of [1, 3, 4, 1000, REMOTE_UPLOAD_CHUNK_BYTES, REMOTE_UPLOAD_CHUNK_BYTES * 2 + 17]) {
      const bytes = sample(length)
      const chunks = chunkBase64(encode(bytes))
      const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))
      expect(joined.equals(Buffer.from(bytes))).toBe(true)
    }
  })

  it('마지막 조각만 패딩을 갖는다 — 중간 조각은 홀로 디코딩된다', () => {
    const chunks = chunkBase64(encode(sample(REMOTE_UPLOAD_CHUNK_BYTES * 2 + 1)))
    expect(chunks.length).toBe(3)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk).not.toContain('=')
      expect(Buffer.from(chunk, 'base64').length).toBe(REMOTE_UPLOAD_CHUNK_BYTES)
    }
  })

  it('빈 입력은 조각이 없다', () => {
    expect(chunkBase64('')).toEqual([])
  })

  it('base64 에서 원본 바이트 수를 되돌린다', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 999]) {
      expect(base64Bytes(encode(sample(length)))).toBe(length)
    }
  })
})
