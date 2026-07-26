import type { FileHit } from '@shared/types'

/**
 * 커서 직전의 `@토큰`을 찾는 정규식. Claude Code CLI 의 멘션 추출 규칙과 맞췄다 —
 * 줄 시작이거나 공백(또는 CJK 문장부호) 뒤의 `@` 만 멘션이라서 `foo@bar.com` 은 걸리지 않는다.
 * CLI 는 공백이 든 경로를 `@"path with space"` 형태로만 인식하므로 아직 닫히지 않은 따옴표도 받는다.
 */
const MENTION_RE = /(^|[\s。、？！])@("[^"]*|[^\s@"]*)$/

export interface MentionToken {
  /** `@` 뒤에 지금까지 입력된 부분 경로(따옴표는 벗겨서). */
  query: string
  /** 입력 문자열에서 `@` 문자가 있는 위치(수락 시 이 자리부터 치환한다). */
  at: number
}

/** 커서 기준 `@` 토큰. 멘션 상태가 아니면 null. */
export function findMention(text: string, caret: number): MentionToken | null {
  const m = MENTION_RE.exec(text.slice(0, caret))
  if (!m) return null
  const raw = m[2]
  return { query: raw.startsWith('"') ? raw.slice(1) : raw, at: m.index + m[1].length }
}

/**
 * 후보를 입력창에 넣을 문자열로. 공백이 든 경로는 CLI 규칙대로 따옴표로 감싼다.
 * 디렉토리는 `/` 로 끝내 하위를 이어서 좁힐 수 있게 하고(따옴표는 열어 둔다), 파일은 공백으로 끊는다.
 */
export function mentionToken(hit: FileHit): string {
  const spaced = /\s/.test(hit.path)
  if (hit.isDir) return spaced ? `@"${hit.path}/` : `@${hit.path}/`
  return spaced ? `@"${hit.path}" ` : `@${hit.path} `
}

/**
 * 파일 경로와 선택 라인 범위를 CLI 가 이해하는 멘션으로 만든다.
 * `@src/app.ts#L40-80` 처럼 범위를 주면 그 구간만 첨부되므로, 큰 파일을 통째로 넣지 않아도 된다.
 */
export function mentionWithRange(path: string, from?: number, to?: number): string {
  const spaced = /\s/.test(path)
  const range =
    from === undefined ? '' : to === undefined || to === from ? `#L${from}` : `#L${from}-${to}`
  return spaced ? `@"${path}${range}" ` : `@${path}${range} `
}

/** 입력창 초안 끝에 멘션을 덧붙인다(앞에 공백이 없으면 넣어 준다). */
export function appendMention(draft: string, token: string): string {
  if (!draft) return token
  return /\s$/.test(draft) ? draft + token : `${draft} ${token}`
}
