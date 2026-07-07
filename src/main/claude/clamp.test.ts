import { describe, it, expect } from 'vitest'
import { clampText, clampInput } from './clamp'

describe('clampText', () => {
  it('한도 이하 문자열은 원본을 그대로 반환한다', () => {
    const s = 'hello world'
    expect(clampText(s)).toBe(s)
  })

  it('한도를 넘으면 잘라내고 truncated 안내를 덧붙인다', () => {
    const out = clampText('a'.repeat(20), 10)
    expect(out.startsWith('a'.repeat(10))).toBe(true)
    expect(out).toContain('truncated')
    expect(out).toContain('10')
  })
})

describe('clampInput', () => {
  it('한도 이하 입력은 구조를 그대로 보존한다', () => {
    const input = { cmd: 'ls -la', nested: { note: 'ok' }, list: ['a', 'b'] }
    expect(clampInput(input)).toEqual(input)
  })

  it('거대한 문자열 리프는 잘라내되 나머지 구조는 보존한다', () => {
    const input = { big: 'x'.repeat(600 * 1024), note: 'ok' }
    const out = clampInput(input) as { big: string; note: string }
    expect(out.big).toContain('truncated')
    expect(out.big.length).toBeLessThan(input.big.length)
    expect(out.note).toBe('ok')
  })

  it('직렬화 불가(순환 참조) 입력은 안전한 대체값으로 치환한다', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const out = clampInput(circular) as { _note?: string }
    expect(out._note).toContain('not serializable')
  })
})
