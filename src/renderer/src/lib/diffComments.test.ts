import { describe, it, expect } from 'vitest'
import {
  commentLocation,
  composeDiffCommentsMessage,
  isSendCommentsShortcut,
  type DiffComment
} from './diffComments'

const comment = (over: Partial<DiffComment> = {}): DiffComment => ({
  id: 'dc:1',
  path: 'src/calc.ts',
  deleted: false,
  from: 11,
  to: 12,
  body: 'b 를 상수로 빼 주세요.',
  ...over
})

describe('commentLocation', () => {
  it('한 줄이면 범위를 접는다', () => {
    expect(commentLocation(comment({ from: 11, to: 11 }))).toBe('src/calc.ts:11')
    expect(commentLocation(comment())).toBe('src/calc.ts:11-12')
  })
})

describe('composeDiffCommentsMessage', () => {
  it('멘션과 본문만 싣는다 — 코드는 멘션이 첨부하므로 다시 적지 않는다', () => {
    const msg = composeDiffCommentsMessage([comment()])
    // 멘션이 곧 위치다 — CLI 가 이 범위만큼 파일을 첨부해 주므로 에이전트가 다시 찾을 필요가 없다.
    expect(msg).toContain('@src/calc.ts#L11-12')
    expect(msg).toContain('b 를 상수로 빼 주세요.')
    // 같은 코드를 두 번 보내면 코멘트 수만큼 토큰만 늘어난다.
    expect(msg).not.toContain('```')
    expect(msg).not.toContain('@@')
  })

  it('여러 건이면 번호를 붙이고 개수를 앞에서 알린다', () => {
    const msg = composeDiffCommentsMessage([
      comment(),
      comment({ id: 'dc:2', path: 'src/ui.tsx', from: 3, to: 3, body: 'here too' })
    ])
    expect(msg).toContain('I left 2 comments')
    expect(msg).toContain('### 1. @src/calc.ts#L11-12')
    expect(msg).toContain('### 2. @src/ui.tsx#L3')
  })

  it('한 건이면 단수형으로 말한다', () => {
    expect(composeDiffCommentsMessage([comment()])).toContain('I left a comment')
  })

  it('공백이 든 경로는 CLI 규칙대로 따옴표로 감싼다', () => {
    const msg = composeDiffCommentsMessage([comment({ path: 'my docs/a.md' })])
    expect(msg).toContain('@"my docs/a.md#L11-12"')
  })

  it('삭제된 파일은 멘션 대신 옛 줄 범위를 알린다 — 첨부할 파일이 없다', () => {
    const msg = composeDiffCommentsMessage([comment({ deleted: true, from: 4, to: 4 })])
    expect(msg).not.toContain('@src/calc.ts')
    expect(msg).toContain('`src/calc.ts` (deleted file, line 4 of the old file)')
  })

  it('본문 앞뒤 공백은 털어 낸다 — 입력 상자에서 흔히 딸려 온다', () => {
    const msg = composeDiffCommentsMessage([comment({ body: '  \n고쳐 주세요.\n  ' })])
    expect(msg.endsWith('고쳐 주세요.')).toBe(true)
  })
})

/**
 * 실제로 터졌던 자리다 — 코멘트 상자에서 ⌘↵ 로 저장하면 그 타건이 window 까지 올라오는데,
 * 그때는 상자가 이미 사라져 포커스가 body 다. 포커스로 판단했더니 저장과 전송이 한 번에
 * 일어나 코멘트 한 건이 곧바로 나가 버렸다.
 */
describe('isSendCommentsShortcut', () => {
  const press = (over: Record<string, unknown> = {}): boolean =>
    isSendCommentsShortcut({
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      isComposing: false,
      target: null,
      ...over
    } as Parameters<typeof isSendCommentsShortcut>[0])

  const el = (tagName: string, isContentEditable = false): EventTarget =>
    ({ tagName, isContentEditable }) as unknown as EventTarget

  it('입력창 밖에서 누른 ⌘↵ 와 ⌃↵ 를 받는다', () => {
    expect(press()).toBe(true)
    expect(press({ target: el('DIV') })).toBe(true)
    expect(press({ metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('수식 키 없는 Enter 나 다른 키는 무시한다', () => {
    expect(press({ metaKey: false })).toBe(false)
    expect(press({ key: 'a' })).toBe(false)
  })

  it('한글 조합 중이면 무시한다 — 조합 확정 Enter 가 전송으로 새면 안 된다', () => {
    expect(press({ isComposing: true })).toBe(false)
  })

  it('코멘트 상자·Composer 등 입력창에서 누른 것은 그쪽 몫이다', () => {
    expect(press({ target: el('TEXTAREA') })).toBe(false)
    expect(press({ target: el('INPUT') })).toBe(false)
    expect(press({ target: el('DIV', true) })).toBe(false)
  })
})
