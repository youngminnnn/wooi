import { describe, expect, it } from 'vitest'
import { summarizeToolResult } from './toolResult'

describe('summarizeToolResult', () => {
  it('reduces file and search outputs', () => {
    expect(
      summarizeToolResult('Read', { file: { filePath: 'a.ts', numLines: 10, totalLines: 20 } })
    ).toEqual({ kind: 'read', path: 'a.ts', lines: 10, total: 20 })
    expect(summarizeToolResult('Glob', { numFiles: 3, filenames: ['large', 'blob'] })).toEqual({
      kind: 'found',
      count: 3,
      unit: 'file'
    })
    expect(summarizeToolResult('Grep', { numMatches: 4, numFiles: 2 })).toEqual({
      kind: 'found',
      count: 4,
      unit: 'match',
      across: 2
    })
  })

  it('counts patches without retaining originalFile', () => {
    expect(
      summarizeToolResult('Edit', {
        filePath: 'a.ts',
        originalFile: 'do not retain',
        structuredPatch: [{ lines: [' a', '-b', '+c'] }]
      })
    ).toEqual({ kind: 'patch', path: 'a.ts', added: 1, removed: 1 })
  })

  // 새 파일은 "몇 줄을 썼는가", 덮어쓴 파일은 "무엇이 바뀌었는가" 가 알고 싶은 것이다.
  it('tells writing a new file apart from overwriting one', () => {
    const patch = [{ lines: ['+a', '+b'] }]
    expect(
      summarizeToolResult('Write', { type: 'create', filePath: 'a.ts', structuredPatch: patch })
    ).toEqual({ kind: 'write', path: 'a.ts', lines: 2, created: true })
    expect(
      summarizeToolResult('Write', {
        type: 'update',
        filePath: 'a.ts',
        structuredPatch: [{ lines: ['-old', '+new'] }]
      })
    ).toEqual({ kind: 'patch', path: 'a.ts', added: 1, removed: 1 })
  })

  // appliedLimit 은 boolean 이 아니라 잘라 낸 개수다 — true 와 비교하면 영영 걸리지 않는다.
  it('reads Grep truncation from the numeric applied limit', () => {
    expect(summarizeToolResult('Grep', { numMatches: 9, numFiles: 2, appliedLimit: 5 })).toEqual({
      kind: 'found',
      count: 9,
      unit: 'match',
      across: 2,
      truncated: true
    })
  })

  it('returns null for unknown tools and shapes', () => {
    expect(summarizeToolResult('FutureTool', { huge: 'blob' })).toBeNull()
    expect(summarizeToolResult('Read', { nope: true })).toBeNull()
  })
})
