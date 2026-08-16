import { useMemo, useState } from 'react'
import { toolActivity, toolDisplayName, toolUseSummary } from '@shared/toolDisplay'
import type { ChatItem } from '@shared/types'
import { ToolResultBody } from './ToolResultBody'
import { ToolCardWooi } from './ToolCardWooi'
import { ToolCardTerminal } from './ToolCardTerminal'
import { SkillCard } from './SkillCard'

/**
 * 도구 호출 한 건 — 호출과 그 결과를 **한 덩어리로** 그린다.
 *
 * 예전에는 호출 행과 결과 상자가 형제 항목으로 따로 놓여, 결과가 어느 호출의 것인지 눈으로
 * 이어 붙여야 했다. 묶고 나면 결과는 호출에 딸린 것이 되고, 그래서 접어 둘 수 있다.
 *
 * 이 컴포넌트는 판단만 한다 — 무엇을 보여 줄지 정하고, 어떻게 생겼는지는 스타일 컴포넌트에
 * 넘긴다. 두 스타일이 같은 값을 받으므로 외형을 바꿔도 내용은 달라지지 않는다.
 */
export function ToolCard({
  use,
  result,
  pending,
  style,
  verbose,
  children
}: {
  use: Extract<ChatItem, { type: 'tool_use' }>
  result?: Extract<ChatItem, { type: 'tool_result' }>
  pending: boolean
  style: 'wooi' | 'terminal'
  verbose: boolean
  /** 접지 않고 항상 보일 것(파일 변경 diff). */
  children?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const stat = useMemo(() => (use.diff ? diffStat(use.diff) : null), [use.diff])

  // 스킬은 도구를 하나 쓴 것이 아니라 "이 절차로 일한다" 는 선언이다. 도구 로그에 섞어 접어 두면
  // 대화의 방향이 바뀐 지점이 보이지 않으므로 전용 블록으로 세운다.
  if (use.name === 'Skill') return <SkillCard name={toolUseSummary(use.name, use.input)} />

  const props = {
    name: toolDisplayName(use.name),
    summary: toolUseSummary(use.name, use.input),
    activity: toolActivity(use.name, use.input),
    pending,
    open,
    toggle: () => setOpen((value) => !value),
    stat,
    result: result ? (
      // 대화 검색·점프가 결과 항목 id 로 이 자리를 찾아온다 — 묶더라도 id 는 남긴다.
      <div data-item-id={result.id}>
        <ToolResultBody result={result} verbose={verbose} />
      </div>
    ) : undefined,
    details: (
      <pre className="ml-4 mt-1 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-neutral-400">
        {JSON.stringify(use.input, null, 2)}
      </pre>
    ),
    children
  }
  return style === 'terminal' ? <ToolCardTerminal {...props} /> : <ToolCardWooi {...props} />
}

/** 통합 diff 의 추가/삭제 줄 수(파일 헤더 ---/+++ 는 제외). */
function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}
