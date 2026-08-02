import { describe, expect, it } from 'vitest'
import { matchLocal, matchSideQuestion } from './Composer'

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
})
