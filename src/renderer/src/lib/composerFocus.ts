/** 현재 워크스페이스의 메시지 입력창으로 포커스를 옮긴다. */
export const FOCUS_COMPOSER_EVENT = 'wooi:focus-composer'

/**
 * 입력창의 caret 위치에 글자를 끼워 넣고 포커스까지 옮긴다. `detail` 이 넣을 글자다.
 *
 * 포커스만 옮기는 이벤트와 나눠 둔 이유는 Backspace 때문이다 — 그 키는 데려가기만 하고
 * 넣지는 않는다([[shouldFocusComposerFromEditingKey]]).
 */
export const INSERT_INTO_COMPOSER_EVENT = 'wooi:insert-into-composer'
