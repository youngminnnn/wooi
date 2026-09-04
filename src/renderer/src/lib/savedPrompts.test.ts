import { describe, expect, it } from 'vitest'
import { appendPrompt } from './savedPrompts'

/**
 * 저장된 프롬프트를 고르는 것은 **전송이 아니다.** 입력창을 채우기만 하므로, 채우는 규칙이
 * 사용자가 이미 친 글을 지우지 않는다는 것만 지키면 된다.
 */
describe('appendPrompt', () => {
  it('빈 입력창은 그대로 채운다', () => {
    expect(appendPrompt('', 'Review the diff')).toBe('Review the diff')
    expect(appendPrompt('   \n', 'Review the diff')).toBe('Review the diff')
  })

  it('쓰던 글이 있으면 지우지 않고 빈 줄을 두고 뒤에 붙인다', () => {
    expect(appendPrompt('Fix the parser.', 'Review the diff')).toBe(
      'Fix the parser.\n\nReview the diff'
    )
    // 끝에 남은 개행이 빈 줄을 겹쳐 만들지 않게 다듬는다.
    expect(appendPrompt('Fix the parser.\n\n', 'Review the diff')).toBe(
      'Fix the parser.\n\nReview the diff'
    )
  })
})
