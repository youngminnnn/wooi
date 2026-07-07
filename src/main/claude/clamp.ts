/**
 * 에이전트 출력 페이로드의 크기 상한.
 *
 * 배경: Claude SDK 쿼리는 메인(브라우저) 프로세스에서 돌고, 거기서 받은 모든 항목은
 * `webContents.send`(IPC)로 렌더러에 보내진다. IPC 는 V8 ValueSerializer 로 페이로드를
 * 직렬화하는데, 단일 메시지가 과도하게 크면(예: 거대 파일을 읽은 tool_result, 큰 본문을
 * 쓰는 Write 의 input) 스트림 수신 콜백 내부에서 네이티브 CHECK 가 터져 메인 프로세스가
 * 통째로 abort 된다 — 실행 중이던 모든 병렬 세션이 함께 죽는다. 이는 JS try/catch 로
 * 잡히지 않는 하드 크래시이므로, 경계를 넘기 전에 소스에서 크기를 제한하는 것이 유일한 방어다.
 *
 * UI 채팅 버블·트랜스크립트에 수십 MB 가 필요할 일은 없고, 자식 CLI 프로세스는 도구 결과
 * 전문을 자체 컨텍스트로 이미 들고 있으므로(여기서 자르는 건 표시·영속용 사본일 뿐) 에이전트의
 * 추론에는 영향이 없다. 한도는 가독 한계를 크게 웃돌면서 V8 직렬화 한계(~512MB)보다는
 * 수백 배 낮게 잡아, 사용성을 해치지 않으면서 크래시 경로를 원천 차단한다.
 */
const MAX_TEXT = 512 * 1024 // 512KiB(문자 수 기준)

/** input 객체를 직렬화했을 때의 전체 상한. 문자열 리프를 잘라도 구조가 거대하면 막는다. */
const MAX_INPUT_TOTAL = 1024 * 1024 // 1MiB

const TRUNCATED = (omitted: number): string =>
  `\n\n…[truncated ${omitted.toLocaleString()} characters — output too large to display]`

/** 문자열을 안전 한도로 자른다. 한도 이하면 원본을 그대로 돌려준다. */
export function clampText(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + TRUNCATED(text.length - max)
}

/**
 * tool_use 의 input(임의 구조)을 IPC 안전 크기로 만든다.
 * 문자열 리프를 재귀적으로 클램프하고, 그래도 전체가 한도를 넘으면 요약 객체로 대체한다.
 */
export function clampInput(input: unknown): unknown {
  const clamped = clampStringLeaves(input)
  let size: number
  try {
    size = JSON.stringify(clamped)?.length ?? 0
  } catch {
    // 순환 참조 등 직렬화 불가 → IPC 직렬화도 실패하므로 안전한 대체값으로 치환.
    return { _note: 'tool input omitted (not serializable)' }
  }
  if (size > MAX_INPUT_TOTAL) {
    return { _note: `tool input omitted (${size.toLocaleString()} bytes — too large to display)` }
  }
  return clamped
}

/** 문자열 리프만 잘라내며 구조는 보존한다(배열/객체는 그대로 순회). */
function clampStringLeaves(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clampText(value)
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => clampStringLeaves(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = clampStringLeaves(v, depth + 1)
  }
  return out
}
