import { describe, expect, it } from 'vitest'
import {
  shouldFocusComposerFromEditingKey,
  shouldRedirectTyping,
  type TypingRedirectEvent
} from './typingRedirect'

function ev(over: Partial<TypingRedirectEvent> = {}): TypingRedirectEvent {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: document.createElement('div'),
    ...over
  }
}

/** 대화 본문처럼 아무것도 아닌 자리를 만든다. 선택자 판정은 조상까지 올라가므로 붙여 둔다. */
function inertTarget(html = '<span>plain text</span>'): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.firstElementChild as Element
}

describe('shouldRedirectTyping', () => {
  it('아무것도 아닌 자리에서 누른 한 글자는 넘긴다', () => {
    expect(shouldRedirectTyping(ev({ target: inertTarget() }))).toBe(true)
  })

  it('Shift·Alt 로 만든 글자도 넘긴다 — 맥에서 이 둘은 명령이 아니라 글자 수식키다', () => {
    expect(shouldRedirectTyping(ev({ key: 'A', shiftKey: true }))).toBe(true)
    expect(shouldRedirectTyping(ev({ key: '´', altKey: true }))).toBe(true)
  })

  it('⌘·⌃ 조합은 명령이므로 넘기지 않는다', () => {
    expect(shouldRedirectTyping(ev({ key: 'k', metaKey: true }))).toBe(false)
    expect(shouldRedirectTyping(ev({ key: 'o', ctrlKey: true }))).toBe(false)
  })

  it('한 글자가 아닌 키는 모두 무시한다', () => {
    for (const key of ['Enter', 'Tab', 'ArrowUp', 'Escape', 'F5', 'Backspace', 'Process']) {
      expect(shouldRedirectTyping(ev({ key }))).toBe(false)
    }
  })

  it('IME 조합 중에는 발동하지 않는다', () => {
    expect(shouldRedirectTyping(ev({ isComposing: true }))).toBe(false)
  })

  it('이미 처리된 이벤트는 건드리지 않는다', () => {
    expect(shouldRedirectTyping(ev({ defaultPrevented: true }))).toBe(false)
  })

  it.each([
    ['<input />'],
    ['<textarea></textarea>'],
    ['<select></select>'],
    ['<button>go</button>'],
    ['<a href="#">link</a>'],
    ['<div contenteditable="true"></div>'],
    ['<div role="menuitem"></div>'],
    ['<div role="option"></div>'],
    ['<div role="combobox"></div>'],
    ['<div role="switch"></div>'],
    ['<div data-typing-redirect-ignore="true"></div>']
  ])('%s 위에서는 발동하지 않는다', (html) => {
    expect(shouldRedirectTyping(ev({ target: inertTarget(html) }))).toBe(false)
  })

  it('버튼 안쪽 글자에서 눌러도 버튼으로 친다 — 조상까지 훑는다', () => {
    const inner = inertTarget('<button><pre>npm run build</pre></button>')
    expect(shouldRedirectTyping(ev({ target: inner.firstElementChild }))).toBe(false)
  })

  it('contenteditable="false" 는 편집 가능한 곳이 아니다', () => {
    expect(
      shouldRedirectTyping(ev({ target: inertTarget('<div contenteditable="false"></div>') }))
    ).toBe(true)
  })

  it('텍스트 노드가 대상이어도 부모 요소로 판정한다', () => {
    const button = inertTarget('<button>go</button>')
    expect(shouldRedirectTyping(ev({ target: button.firstChild }))).toBe(false)
  })

  it('대상이 없으면 대화 본문으로 본다', () => {
    expect(shouldRedirectTyping(ev({ target: null }))).toBe(true)
  })
})

describe('shouldFocusComposerFromEditingKey', () => {
  it('맨 Backspace·Delete 는 포커스를 옮긴다', () => {
    expect(shouldFocusComposerFromEditingKey(ev({ key: 'Backspace' }))).toBe(true)
    expect(shouldFocusComposerFromEditingKey(ev({ key: 'Delete' }))).toBe(true)
  })

  it('수식키가 붙으면 지금 포커스된 쪽 것이다', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(shouldFocusComposerFromEditingKey(ev({ key: 'Backspace', [mod]: true }))).toBe(false)
    }
  })

  it('다른 키는 이 경로가 아니다', () => {
    expect(shouldFocusComposerFromEditingKey(ev({ key: 'a' }))).toBe(false)
    expect(shouldFocusComposerFromEditingKey(ev({ key: 'Escape' }))).toBe(false)
  })

  it('입력 요소 위에서는 발동하지 않는다', () => {
    expect(
      shouldFocusComposerFromEditingKey(ev({ key: 'Backspace', target: inertTarget('<input />') }))
    ).toBe(false)
  })

  it('IME 조합 중에는 발동하지 않는다', () => {
    expect(shouldFocusComposerFromEditingKey(ev({ key: 'Backspace', isComposing: true }))).toBe(
      false
    )
  })
})
