import { describe, it, expect } from 'vitest'
import { parsePathWithLine } from './fileViewer'

describe('parsePathWithLine', () => {
  it('줄 번호가 없으면 경로만 돌려준다', () => {
    expect(parsePathWithLine('src/main/git.ts')).toEqual({ path: 'src/main/git.ts' })
  })

  it('#L 뒤의 줄 번호를 떼어 낸다', () => {
    expect(parsePathWithLine('src/main/git.ts#L42')).toEqual({ path: 'src/main/git.ts', line: 42 })
  })

  it('멘션의 범위 표기(#L시작-끝)는 시작 줄로 연다', () => {
    expect(parsePathWithLine('src/main/git.ts#L10-20')).toEqual({
      path: 'src/main/git.ts',
      line: 10
    })
  })

  it('앞뒤 공백은 무시한다(붙여 넣기 대비)', () => {
    expect(parsePathWithLine('  src/App.tsx#L7  ')).toEqual({ path: 'src/App.tsx', line: 7 })
  })

  it('# 이 있어도 줄 표기가 아니면 경로의 일부로 둔다', () => {
    expect(parsePathWithLine('docs/c#-notes.md')).toEqual({ path: 'docs/c#-notes.md' })
  })
})
