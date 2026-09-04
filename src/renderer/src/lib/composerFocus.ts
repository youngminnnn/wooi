/** 현재 워크스페이스의 메시지 입력창으로 포커스를 옮긴다. */
export const FOCUS_COMPOSER_EVENT = 'wooi:focus-composer'

/**
 * 입력창의 caret 위치에 글자를 끼워 넣고 포커스까지 옮긴다. `detail` 이 넣을 글자다.
 *
 * 포커스만 옮기는 이벤트와 나눠 둔 이유는 Backspace 때문이다 — 그 키는 데려가기만 하고
 * 넣지는 않는다([[shouldFocusComposerFromEditingKey]]).
 */
export const INSERT_INTO_COMPOSER_EVENT = 'wooi:insert-into-composer'

/**
 * 즉시 실행 `/wooi:*` 커맨드를 입력창 대신 팔레트에서 부를 때 쓴다. `detail` 은 커맨드 이름과
 * 나머지 인자다.
 *
 * 팔레트가 `window.api.commands.wooiRun` 을 직접 부르지 않는 이유: 실행은 절반이고 나머지
 * 절반은 결과 카드다. 그 카드는 Composer 가 자기 상태로 들고 있으므로, 여기서 직접 부르면
 * 명령은 돌지만 사용자에게는 아무 일도 안 일어난 것처럼 보인다. 입구를 하나 더 내고 실행은
 * 원래 하던 곳에 맡긴다.
 */
export const RUN_WOOI_COMMAND_EVENT = 'wooi:run-wooi-command'

export interface RunWooiCommandDetail {
  workspaceId: string
  /** 접두사를 뺀 커맨드 이름(`pr`, `peers` …). */
  name: string
  /** 커맨드 뒤에 붙은 나머지 텍스트. 인자가 없으면 빈 문자열. */
  rest: string
}
