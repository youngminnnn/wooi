import { useState } from 'react'
import { FOLD, DENSITY_SHORTCUT, fold } from '@shared/toolDisplay'
import { formatToolSummary } from '@shared/toolSummary'
import type { ChatItem } from '@shared/types'
import { SELECTABLE, unlessSelecting } from '../../lib/selection'

/**
 * 도구 결과 본문. 접힌 상태가 기본이고, 눌러서(또는 ⌃O 로 한꺼번에) 원문을 펼친다.
 *
 * 접힌 모습은 두 갈래다 — 구조화 요약이 있으면 그 한 줄("Read a.ts (120 lines)"), 없으면 원문
 * 앞 세 줄. 어느 쪽이든 **원문으로 가는 길은 막지 않는다**: 요약은 요약일 뿐이라, 도구가 실제로
 * 뭘 돌려줬는지 확인해야 하는 순간이 반드시 온다.
 *
 * 줄바꿈 기회가 없는 결과도 있다 — MCP 도구는 공백 없는 JSON 한 줄을 돌려준다. 그대로 두면 그
 * 한 줄이 카드를 밀고 나가 대화 전체에 가로 스크롤이 생기므로, 단어 안에서도 끊는다(break-words).
 * 여느 줄글은 평소처럼 띄어쓰기에서 끊기니 이 규칙이 눈에 띄는 곳은 그런 한 줄짜리 결과뿐이다.
 *
 * 실패한 결과는 요약을 쓰지 않는다. 실패는 수치가 아니라 원인을 읽어야 하는 것이라 언제나
 * 메시지 본문을 보여 주고, 대신 접는 한도를 넉넉히(FOLD.error) 잡는다.
 */
export function ToolResultBody({
  result,
  verbose
}: {
  result: Extract<ChatItem, { type: 'tool_result' }>
  verbose: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = verbose || open

  const summary = result.isError ? null : result.summary
  const folded = fold(result.text, result.isError ? FOLD.error : FOLD.lines)
  const body = summary ? formatToolSummary(summary) : folded.head

  // 요약만 보이는 상태에서는 원문 전체가 "더 볼 것" 이다. 요약이 없을 때만 잘린 줄 수를 센다.
  const hidden = summary ? (result.text.trim() ? -1 : 0) : folded.remaining
  if (hidden === 0)
    return <pre className="whitespace-pre-wrap break-words font-[inherit]">{body}</pre>

  return (
    <button
      type="button"
      className={`block w-full text-left ${SELECTABLE}`}
      onClick={unlessSelecting(() => setOpen((value) => !value))}
    >
      <pre className="whitespace-pre-wrap break-words font-[inherit]">
        {expanded ? result.text : body}
      </pre>
      <span className="text-neutral-600 hover:text-neutral-400">
        {expanded
          ? 'Collapse'
          : hidden < 0
            ? `Show output (${DENSITY_SHORTCUT} to expand)`
            : `… +${hidden} lines (${DENSITY_SHORTCUT} to expand)`}
      </span>
    </button>
  )
}
