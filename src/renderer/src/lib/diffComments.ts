import { mentionWithRange } from './mention'

/**
 * Changes 탭의 diff 라인에 남기는 코멘트.
 *
 * PR 리뷰의 지적(ReviewFinding)과 달리 **에이전트에게 보낼 채팅 메시지의 재료**일 뿐이다.
 * 어디에도 영속하지 않고(store 의 휘발성 슬라이스에만 산다) 전송하는 순간 사라진다 — 코멘트가
 * 남아 있어야 하는 곳은 대화 기록이지 별도 저장소가 아니다.
 */
export interface DiffCommentAnchor {
  /** diff 에 나온 그대로의 워크트리 상대경로. */
  path: string
  /**
   * 삭제된 파일인지. 삭제된 파일은 워크트리에 없어 `@경로` 멘션이 아무것도 첨부하지 못하므로,
   * 메시지에 멘션 대신 "(deleted file)" 라벨과 옛 줄 범위를 적는다.
   */
  deleted: boolean
  /** 줄 범위(1-based, 양끝 포함). 새 파일 기준 — 삭제된 파일일 때만 옛 파일 기준이다. */
  from: number
  to: number
}

export interface DiffComment extends DiffCommentAnchor {
  id: string
  body: string
}

/** "src/main/git.ts:120-124" — 목록·툴팁에서 쓰는 짧은 위치 표기. */
export function commentLocation(c: DiffCommentAnchor): string {
  return c.from === c.to ? `${c.path}:${c.from}` : `${c.path}:${c.from}-${c.to}`
}

/** `isSendCommentsShortcut` 이 읽는 것만 추린 모양. 테스트가 진짜 KeyboardEvent 없이도 부를 수 있다. */
interface ShortcutEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  target: EventTarget | null
}

/**
 * 이 타건이 "모아 둔 코멘트를 전송" 으로 가야 하는가.
 *
 * 입력창에서 눌렀으면 아니다 — 그 자리의 ⌘↵ 가 임자다(코멘트 상자는 저장, Composer 는 턴을
 * 멈추고 전송).
 *
 * 판단 기준이 지금 포커스가 아니라 **누른 자리**(`target`)인 것이 핵심이다. 코멘트 상자에서
 * ⌘↵ 를 누르면 저장이 처리되며 상자가 사라지고, 그 타건이 window 까지 올라올 때쯤엔 포커스가
 * 이미 body 로 빠져 있다. 포커스로 판단하면 가드가 뚫려 **저장과 전송이 한 타건에 함께**
 * 일어난다(실측). `target` 은 요소가 사라진 뒤에도 원래 눌린 자리를 가리킨다.
 */
export function isSendCommentsShortcut(e: ShortcutEvent): boolean {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return false
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el) return true
  return el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable
}

/**
 * 모아 둔 코멘트를 에이전트에게 보낼 한 통의 메시지로 만든다.
 *
 * 각 코멘트는 `@경로#L시작-끝` 멘션과 본문뿐이다. 코드는 싣지 않는다 — 멘션이 그 범위의 파일
 * 내용을 그대로 첨부하므로, 본문에 또 적으면 같은 코드를 두 번 보내는 셈이라 코멘트 수만큼
 * 토큰만 늘어난다.
 *
 * 삭제된 줄에 단 코멘트도 마찬가지로 코드를 싣지 않는다. 멘션이 가리키는 것은 그 코드가 **있던
 * 자리**이므로, 무엇이 지워졌는지는 에이전트가 `git diff` 로 확인한다 — 메시지가 항상 짧은 편이
 * 낫고, 지워진 내용은 어차피 워크트리에서 언제든 다시 읽을 수 있다.
 */
export function composeDiffCommentsMessage(comments: DiffComment[]): string {
  const blocks = comments.map((c, i) => `### ${i + 1}. ${locationHeading(c)}\n\n${c.body.trim()}`)
  return [intro(comments.length), ...blocks].join('\n\n')
}

function intro(n: number): string {
  return n === 1
    ? 'I left a comment on the diff in the Changes tab. Address it at the exact location below.'
    : `I left ${n} comments on the diff in the Changes tab. Address each one at the exact location below.`
}

/**
 * 위치 제목. 살아 있는 파일은 멘션으로 적어 CLI 가 그 범위를 첨부하게 하고, 삭제된 파일은
 * 첨부할 내용이 없으므로 경로와 옛 줄 범위만 알린다.
 */
function locationHeading(c: DiffCommentAnchor): string {
  const range = c.from === c.to ? `line ${c.from}` : `lines ${c.from}-${c.to}`
  if (c.deleted) return `\`${c.path}\` (deleted file, ${range} of the old file)`
  return mentionWithRange(c.path, c.from, c.to).trim()
}
