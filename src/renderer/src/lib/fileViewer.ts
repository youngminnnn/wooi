/**
 * 파일 퀵 오픈 팔레트를 여는 커스텀 이벤트. 팔레트 상태는 App 이 들고 있고, 여는 곳은
 * 여러 군데(단축키·헤더 버튼·뷰어 주소창)라 콜백을 꿰는 대신 이벤트 한 곳으로 받는다.
 */
export const OPEN_FILE_QUICK_OPEN_EVENT = 'wooi:open-file-quick-open'

export function openFileQuickOpen(): void {
  window.dispatchEvent(new Event(OPEN_FILE_QUICK_OPEN_EVENT))
}

/**
 * `src/main/git.ts#L42` 처럼 줄 번호가 붙은 경로를 갈라 준다.
 * 멘션 문법(`@경로#L줄`)과 같은 표기라, 대화에서 눈으로 본 위치를 그대로 붙여 넣을 수 있다.
 */
export function parsePathWithLine(input: string): { path: string; line?: number } {
  const m = /^(.*?)#L(\d+)(?:-\d+)?$/.exec(input.trim())
  if (!m) return { path: input.trim() }
  return { path: m[1], line: Number(m[2]) }
}
