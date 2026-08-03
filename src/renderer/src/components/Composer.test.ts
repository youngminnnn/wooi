import { describe, expect, it } from 'vitest'
import { matchLocal, matchMemory, matchSideQuestion } from './Composer'

describe('백엔드 전용 composer 명령', () => {
  it('Codex에서는 Claude 전용 /memory를 로컬 명령으로 가로채지 않는다', () => {
    expect(matchLocal('/memory', false)).toBeNull()
    expect(matchLocal('/memory', true)).toBe('memory')
  })

  it('side question capability가 없으면 /btw를 가로채지 않는다', () => {
    expect(matchSideQuestion('/btw explain this', false)).toBeNull()
    expect(matchSideQuestion('/btw explain this', true)?.[1]).toBe('explain this')
  })

  it('백엔드 공용 로컬 명령은 그대로 처리한다', () => {
    expect(matchLocal('/diff', false)).toBe('diff')
    expect(matchLocal('/clear', false)).toBe('clear')
  })

  it('Claude 백엔드에서만 /add-dir을 가로챈다', () => {
    expect(matchLocal('/add-dir ~/notes', false)).toBeNull()
    expect(matchLocal('/add-dir ~/notes', true)).toBe('add-dir')
  })
})

describe('# 메모리 단축키', () => {
  it('# 뒤의 내용을 기억할 문장으로 뽑는다', () => {
    expect(matchMemory('# always run npm run typecheck')).toBe('always run npm run typecheck')
    expect(matchMemory('#no space')).toBe('no space')
  })

  it('마크다운 제목과 빈 #은 일반 메시지로 둔다', () => {
    expect(matchMemory('## Heading')).toBeNull()
    expect(matchMemory('#')).toBeNull()
    expect(matchMemory('#   ')).toBeNull()
    expect(matchMemory('call the #memory shortcut')).toBeNull()
  })
})
