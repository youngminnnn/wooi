import type { FileContent, FileSaveConflict } from './types'

/**
 * 파일 뷰어의 인라인 편집 — "열었을 때의 파일" 과 "저장하는 순간의 파일" 이 같은지 판정한다.
 *
 * 이 앱에서는 사람과 에이전트가 **같은 워크트리를 동시에** 만진다. 사용자가 오타를 고치는 동안
 * 에이전트가 같은 파일을 리팩터링하고 있을 수 있고, 그때 무조건 덮어쓰면 에이전트의 작업이
 * 조용히 사라진다. 그래서 저장은 낙관적 동시성 제어로 간다 — 읽을 때 받은 내용 해시를 들고
 * 있다가, 쓰기 직전에 디스크의 해시와 맞춰 보고 다르면 멈춘다.
 *
 * 판정을 순수 함수로 빼 둔 이유는 메인(실제 쓰기)과 렌더러(버튼·경고 UI)가 **같은 규칙**을
 * 봐야 하기 때문이다. 두 곳에 규칙을 각각 적으면 어긋나는 날이 온다.
 */

/** `classifySave` 의 판정. */
export type SaveVerdict = { kind: 'write' } | { kind: 'conflict'; conflict: FileSaveConflict }

export interface SaveCheck {
  /** 편집을 시작할 때 읽은 내용의 해시. */
  baselineSha: string | null
  /** 저장하는 지금 디스크에 있는 내용의 해시. 파일이 없거나 못 읽으면 null. */
  diskSha: string | null
  /** 사용자가 경고를 보고 "그래도 덮어쓴다" 를 고른 경우. */
  force?: boolean
}

/**
 * 지금 써도 되는지 판정한다.
 *
 * `force` 는 모든 검사를 건너뛴다 — 사용자가 경고를 **보고 나서** 고른 선택이므로, 그 뒤에
 * 다시 막으면 빠져나갈 길이 없다(사라진 파일을 되살리는 것도 여기 포함이다).
 */
export function classifySave({ baselineSha, diskSha, force = false }: SaveCheck): SaveVerdict {
  if (force) return { kind: 'write' }
  // 파일이 사라진 것과 내용이 바뀐 것은 사용자에게 다른 사건이라 따로 알린다.
  if (diskSha === null) return { kind: 'conflict', conflict: 'vanished' }
  // baseline 이 없으면 비교할 근거가 없다. 모르는 상태에서의 기본값은 "쓰지 않는다" 다.
  if (baselineSha === null) return { kind: 'conflict', conflict: 'stale' }
  if (baselineSha !== diskSha) return { kind: 'conflict', conflict: 'stale' }
  return { kind: 'write' }
}

/**
 * 이 파일을 뷰어 안에서 고칠 수 있는가.
 *
 * 바이너리는 텍스트 상자에 담을 수 없고, 잘려서 읽힌 파일은 **보이지 않는 뒷부분을 날려 버리므로**
 * 편집을 열어 주면 안 된다(1 MiB 넘는 파일이 여기 해당한다).
 */
export function canEditFile(content: FileContent | null): boolean {
  if (!content) return false
  return !content.binary && !content.truncated
}

/** 저장하지 않은 변경이 있는가. draft 가 null 이면 편집을 시작조차 안 한 것이다. */
export function isDraftDirty(draft: string | null, baselineText: string): boolean {
  return draft !== null && draft !== baselineText
}

/** 파일의 줄바꿈 표기. */
export type Eol = 'lf' | 'crlf'

/**
 * 원본이 CRLF 파일인지 본다.
 *
 * `<textarea>` 의 value 는 명세상 개행이 LF 로 정규화된다. 그대로 저장하면 CRLF 파일을 열어
 * 오타 하나만 고쳐도 **모든 줄이 바뀐 diff** 가 나온다 — 고친 적 없는 줄까지 리뷰에 올라온다.
 * 그래서 열 때 표기를 기억했다가 저장할 때 되돌려 준다.
 *
 * 섞여 있으면 다수결이 아니라 CRLF 로 본다. 편집기가 만드는 파일은 보통 한 표기로 통일돼
 * 있고, 섞인 파일에서 LF 를 골라 CRLF 줄을 뭉개는 쪽이 그 반대보다 손해가 크다.
 */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? 'crlf' : 'lf'
}

/** `<textarea>` 가 LF 로 정규화한 초안을 원본의 줄바꿈 표기로 되돌린다. */
export function applyEol(text: string, eol: Eol): string {
  // 이미 CRLF 인 줄을 두 번 바꾸지 않도록 먼저 LF 로 모은 뒤 한 번에 편다.
  const lf = text.replace(/\r\n/g, '\n')
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}
