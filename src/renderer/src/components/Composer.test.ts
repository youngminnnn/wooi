import { describe, expect, it } from 'vitest'
import { matchLocal, matchMemory, matchPicker, matchSideQuestion } from './Composer'

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

describe('선택 카드 슬래시 명령', () => {
  it('고를 에이전트가 둘 이상일 때만 /agent 를 가로챈다', () => {
    expect(matchPicker('/agent', true, true)).toBe('agent')
    // 쓸 수 있는 에이전트가 하나뿐이면 "/agent" 는 카드가 아니라 에이전트에게 보내는 평범한 메시지다.
    expect(matchPicker('/agent', true, false)).toBeNull()
  })

  it('fast mode 미지원 백엔드에서는 /fast 를 가로채지 않는다', () => {
    expect(matchPicker('/fast', false, true)).toBeNull()
    expect(matchPicker('/fast', true, true)).toBe('fast')
  })

  it('/model·/effort 는 뒤따르는 인자와 무관하게 카드를 연다', () => {
    expect(matchPicker('/model opus', false, false)).toBe('model')
    expect(matchPicker('/effort high', false, false)).toBe('effort')
    expect(matchPicker('/models', false, false)).toBeNull()
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

  it('이슈 초안처럼 #번호로 시작하는 여러 줄 프롬프트는 일반 메시지로 둔다', () => {
    expect(
      matchMemory(
        '#44 Add a branch stack summary to the README\n\n' +
          'https://github.com/youngminnnn/stacked-pr-playground/issues/44\n\n' +
          'Acceptance criteria:\n- Describe the branch relationship.'
      )
    ).toBeNull()
  })
})
