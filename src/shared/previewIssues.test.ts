import { describe, expect, it } from 'vitest'
import { addIssue, countIssues, formatIssues, type PreviewIssue } from './previewIssues'

const mk = (over: Partial<PreviewIssue> = {}): Omit<PreviewIssue, 'id' | 'count'> => ({
  kind: 'console',
  level: 'error',
  text: 'Cannot read properties of undefined',
  source: 'src/App.tsx:12',
  ts: 1000,
  ...over
})

describe('addIssue', () => {
  it('처음 보는 문제는 count 1 로 넣는다', () => {
    const out = addIssue([], mk(), 100)
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(1)
  })

  it('같은 문제가 다시 나면 새 줄을 만들지 않고 count 만 올린다', () => {
    let out = addIssue([], mk(), 100)
    out = addIssue(out, mk({ ts: 2000 }), 100)
    out = addIssue(out, mk({ ts: 3000 }), 100)
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(3)
    expect(out[0].ts).toBe(3000)
  })

  it('본문이나 위치가 다르면 별개로 본다', () => {
    let out = addIssue([], mk(), 100)
    out = addIssue(out, mk({ text: 'other' }), 100)
    out = addIssue(out, mk({ source: 'src/Other.tsx:1' }), 100)
    expect(out).toHaveLength(3)
  })

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    let out: PreviewIssue[] = []
    for (let i = 0; i < 5; i++) out = addIssue(out, mk({ text: `e${i}` }), 3)
    expect(out.map((i) => i.text)).toEqual(['e2', 'e3', 'e4'])
  })

  it('원본 배열을 건드리지 않는다', () => {
    const before = addIssue([], mk(), 100)
    const after = addIssue(before, mk({ ts: 9000 }), 100)
    expect(before[0].count).toBe(1)
    expect(after).not.toBe(before)
  })
})

describe('countIssues', () => {
  it('에러와 경고를 따로 센다', () => {
    let out = addIssue([], mk(), 100)
    out = addIssue(out, mk({ text: 'w', level: 'warning' }), 100)
    out = addIssue(out, mk({ text: 'w2', level: 'warning' }), 100)
    expect(countIssues(out)).toEqual({ errors: 1, warnings: 2 })
  })

  it('빈 목록은 0', () => {
    expect(countIssues([])).toEqual({ errors: 0, warnings: 0 })
  })
})

describe('formatIssues', () => {
  it('에러를 경고보다 앞에 둔다', () => {
    let out = addIssue([], mk({ text: 'a warning', level: 'warning', ts: 1 }), 100)
    out = addIssue(out, mk({ text: 'an error', level: 'error', ts: 2 }), 100)
    const text = formatIssues(out, 'http://localhost:3000')
    expect(text.indexOf('an error')).toBeLessThan(text.indexOf('a warning'))
  })

  it('반복 횟수와 위치를 적는다', () => {
    let out = addIssue([], mk(), 100)
    out = addIssue(out, mk({ ts: 2 }), 100)
    const text = formatIssues(out, 'http://localhost:3000')
    expect(text).toContain('(×2)')
    expect(text).toContain('at src/App.tsx:12')
    expect(text).toContain('http://localhost:3000')
  })

  it('한 번만 난 문제에는 횟수를 붙이지 않는다', () => {
    expect(formatIssues(addIssue([], mk(), 100), 'u')).not.toContain('×')
  })

  it('빈 목록이면 빈 문자열', () => {
    expect(formatIssues([], 'u')).toBe('')
  })
})
