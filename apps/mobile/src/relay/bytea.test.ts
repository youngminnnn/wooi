import { describe, expect, it } from 'vitest'
import { decodePostgresBytea, encodePostgresBytea } from './bytea'

/**
 * PostgREST 는 bytea 를 `\x` + 소문자 16진 문자열로 주고받는다. 이 표현을 어긴 적이 있고,
 * 증상은 `nonce must be 24 bytes, got 197` 이었다 — supabase-js 가 Uint8Array 를 JSON 으로
 * 직렬화해 `{"0":1,…}` 를 보낸 것이다. 왕복이 성립하는 것만으로는 못 잡는 종류라, 여기서는
 * **문자열 표현 자체**를 단언한다.
 */
describe('Postgres bytea', () => {
  it('`\\x` 접두사와 소문자 16진으로 인코딩한다', () => {
    expect(encodePostgresBytea(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('\\x00010f10abff')
  })

  it('한 자리 바이트를 0 으로 채운다', () => {
    // 패딩을 빼먹으면 길이가 어긋나 뒤쪽 바이트가 전부 밀린다.
    expect(encodePostgresBytea(new Uint8Array([1, 2, 3]))).toBe('\\x010203')
  })

  it('빈 바이트열도 표현한다', () => {
    expect(encodePostgresBytea(new Uint8Array())).toBe('\\x')
    expect(decodePostgresBytea('\\x')).toEqual(new Uint8Array())
  })

  it('임의의 바이트열을 왕복한다', () => {
    const bytes = new Uint8Array(256)
    for (let index = 0; index < 256; index += 1) bytes[index] = index
    expect(decodePostgresBytea(encodePostgresBytea(bytes))).toEqual(bytes)
  })

  it('접두사가 없으면 거부한다', () => {
    // 조용히 통과하면 잘못 해석한 바이트가 암호 계층까지 내려가 "복호화 실패" 로만 보인다.
    expect(() => decodePostgresBytea('00010f')).toThrow()
  })

  it('16진이 아니거나 길이가 홀수면 거부한다', () => {
    expect(() => decodePostgresBytea('\\x0g')).toThrow()
    expect(() => decodePostgresBytea('\\x010')).toThrow()
  })
})
