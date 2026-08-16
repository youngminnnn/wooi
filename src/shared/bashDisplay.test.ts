import { describe, expect, it } from 'vitest'
import { BASH_FOLD, foldBashOutput } from './bashDisplay'

describe('foldBashOutput', () => {
  it('Codex agent 명령은 앞뒤를 남겨 다섯 행으로 접는다', () => {
    const folded = foldBashOutput(
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'),
      BASH_FOLD.agent
    )
    expect(folded).toEqual({
      text: 'line 1\nline 2\n… +6 lines\nline 9\nline 10',
      omitted: 6
    })
  })

  it('상한 이하는 원문을 그대로 둔다', () => {
    expect(foldBashOutput('one\ntwo', BASH_FOLD.agent)).toEqual({
      text: 'one\ntwo',
      omitted: 0
    })
  })

  it('사용자 shell은 Codex의 50행 상한을 쓴다', () => {
    const output = Array.from({ length: 51 }, (_, i) => String(i + 1)).join('\n')
    const folded = foldBashOutput(output, BASH_FOLD.user)
    expect(folded.text.split('\n')).toHaveLength(50)
    expect(folded.omitted).toBe(2)
  })
})
