/**
 * 대화 아무 데나 글자를 치면 그 글자부터 입력창으로 흘려보낸다.
 *
 * 도구 로그를 스크롤해 읽다가 지시를 이어 치려면 지금은 ⌘L 로 포커스를 먼저 옮겨야 한다
 * ([[FOCUS_COMPOSER_EVENT]]). 한 박자 끊기는 그 동작을 없애는 것이 목적이다.
 *
 * 이 파일에는 **판정만** 둔다. "언제 발동하지 않는가" 가 기능의 절반이고, 잘못 발동하면
 * 앱 전체의 키 입력이 망가지므로 DOM 조작과 떼어 놓고 단위 테스트로 못박는다.
 */

/** KeyboardEvent 중 판정에 쓰는 부분만. 테스트에서 평범한 객체로 만들 수 있게 좁혀 둔다. */
export type TypingRedirectEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  target: EventTarget | null
}

/**
 * 이 안에서 눌린 키는 가로채지 않는다.
 *
 * 입력 요소는 물론이고 링크·버튼·메뉴 항목까지 넣는다 — 이들은 글자 키를 스스로 쓴다
 * (메뉴의 typeahead, 버튼의 Space). 빠져나갈 구멍이 필요한 곳은 마지막 속성을 달면 된다.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[data-typing-redirect-ignore="true"]'
].join(',')

/**
 * 인쇄 가능한 한 글자를 컴포저로 넘겨야 하는가.
 *
 * `key.length !== 1` 하나가 Enter·Tab·화살표·F키를 전부 걸러 낸다. IME 조합은 두 겹으로 막힌다 —
 * 조합을 여는 첫 키는 `key === 'Process'`(길이 7)로 들어오고, 이어지는 키는 `isComposing` 이
 * 참이다. 그래서 한글을 치는 동안에는 아무것도 새지 않는다.
 *
 * Shift·Alt 는 막지 않는다. 맥에서 두 키는 명령이 아니라 글자를 만드는 수식키라(⇧a → 'A',
 * ⌥e → '´'), 막으면 대문자와 특수문자를 못 치게 된다. 명령 수식키는 ⌘·⌃ 뿐이다.
 */
export function shouldRedirectTyping(event: TypingRedirectEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey) return false
  if (event.key.length !== 1) return false
  return !isInteractiveTarget(event.target)
}

/**
 * Backspace/Delete 는 포커스만 옮긴다.
 *
 * 지울 글자가 없는 자리에서 눌렀더라도 "고쳐 쓰려던 참" 이라는 신호이므로 컴포저로 데려간다.
 * 다만 이 키에는 삽입할 글자 모양이 없으니 넣지는 않는다 — 포커스를 받은 textarea 가 그
 * 다음 입력부터 알아서 처리한다.
 *
 * 수식키가 붙은 조합(⌥⌫ 단어 지우기, ⌘⌫ 줄 지우기 등)은 지금 포커스된 쪽 것이라 건드리지 않는다.
 */
export function shouldFocusComposerFromEditingKey(event: TypingRedirectEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false
  return !isInteractiveTarget(event.target)
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = elementOf(target)
  return !!element && element.closest(INTERACTIVE_SELECTOR) !== null
}

/** 이벤트 대상이 텍스트 노드일 수도 있어(선택 영역 등) 가장 가까운 요소로 올라간다. */
function elementOf(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') return null
  const node = target as { closest?: (selector: string) => Element | null; parentElement?: Element }
  if (typeof node.closest === 'function') return node as Element
  return node.parentElement ?? null
}
