import type { ChatItem } from './types'

/**
 * 에이전트를 바꿀 때 새 에이전트에게 넘길 "지금까지의 대화" 를 텍스트로 만든다.
 *
 * 백엔드끼리 세션을 물려줄 방법은 없다 — Claude 의 sessionId 로 Codex 를 resume 할 수 없고, 그
 * 반대도 마찬가지다. 그래서 맥락은 **대화 기록을 다시 말해 주는 것** 으로만 넘어간다. 새 세션의
 * 첫 메시지로 이 텍스트를 보내면, 그 한 번이 통째로 입력 토큰이 된다 — 사용자에게 사용량 경고를
 * 먼저 띄우는 이유이자([[Composer]] 의 확인 대화상자), 여기에 예산 상한이 있는 이유다.
 *
 * 렌더러와 main 이 같은 함수를 쓴다. main 은 실제로 보낼 프롬프트를 만들고, 렌더러는 경고에
 * 띄울 크기를 같은 규칙으로 어림한다 — 경고에 적힌 양과 실제로 보내는 양이 갈리면 안 된다.
 */

/**
 * 프롬프트 전체의 문자 수 상한.
 *
 * 넘겨야 맥락이 이어지지만, 통째로 넣으면 새 에이전트의 컨텍스트를 첫 메시지에서 다 먹고
 * 시작한다(그리고 그만큼 청구된다). 대화가 길면 **최근 것부터** 담고 앞쪽은 잘라 낸다 —
 * 이어서 일할 사람에게 필요한 건 대개 마지막 국면이다. 잘랐다는 사실은 프롬프트에 남긴다.
 */
export const HANDOFF_CHAR_BUDGET = 60_000

/** 항목 하나가 가져갈 수 있는 최대 문자 수. 긴 답변 하나가 예산을 독점하지 못하게 한다. */
const ITEM_CHAR_LIMIT = 4_000

/** 도구 호출은 "무엇을 만졌는가" 만 남긴다 — 입력 전문·결과는 예산 대비 얻는 게 적다. */
const TOOL_SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description']

function clip(text: string, limit = ITEM_CHAR_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…(truncated)`
}

function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = o[key]
    if (typeof value === 'string') return ` ${clip(value, 200)}`
  }
  return ''
}

/**
 * 항목 하나를 넘길 텍스트로. 넘길 것이 없으면 null.
 *
 * 생각(thinking)·도구 결과·턴 결과는 뺀다. 앞엣것은 그 에이전트의 속말이라 다른 모델에게
 * 넘기면 혼란만 주고, 뒤엣둘은 예산을 가장 많이 먹으면서 "무슨 일이 있었나" 에는 거의 답하지
 * 못한다(파일 내용은 어차피 워크트리에 그대로 있으니 새 에이전트가 직접 읽으면 된다).
 */
function renderItem(item: ChatItem, fromLabel: string): string | null {
  switch (item.type) {
    case 'user':
      return `## User\n${clip(item.text)}`
    case 'assistant': {
      const text = clip(item.text)
      return text ? `## ${fromLabel}\n${text}` : null
    }
    case 'tool_use':
      return `## ${fromLabel} ran a tool\n${item.name}${toolSummary(item.input)}`
    case 'bash':
      return `## ${item.agent ? `${fromLabel} ran a command` : 'User ran a command'}\n${clip(item.command, 500)}`
    case 'error':
      return `## Error\n${clip(item.text, 500)}`
    default:
      return null
  }
}

/**
 * 넘길 대화가 있으면 프롬프트를, 없으면 null 을 돌려준다.
 *
 * 프롬프트는 새 에이전트에게 **읽으라고만** 시킨다. 지난 대화의 마지막 줄이 대개 지시문이라
 * (＂그럼 그렇게 고쳐 줘＂) 그대로 넘기면 새 에이전트가 그 일을 처음부터 다시 한다 — 이미 파일에
 * 반영된 일을. 그래서 "기록이지 지시가 아니다" 를 못박고, 요약 한 번으로 턴을 끝내게 한다.
 */
export function buildHandoffPrompt(args: {
  items: ChatItem[]
  /** 넘겨주는 쪽 에이전트의 표시 이름(예: "Claude Code"). */
  fromLabel: string
  /** 이어받는 쪽 에이전트의 표시 이름(예: "Codex"). */
  toLabel: string
  budget?: number
}): string | null {
  const budget = args.budget ?? HANDOFF_CHAR_BUDGET

  // 최근 것부터 담는다 — 예산이 모자랄 때 버릴 것은 오래된 쪽이다.
  const blocks: string[] = []
  let used = 0
  let dropped = 0
  for (let i = args.items.length - 1; i >= 0; i--) {
    const block = renderItem(args.items[i], args.fromLabel)
    if (!block) continue
    if (used + block.length > budget) {
      dropped++
      continue
    }
    used += block.length
    blocks.push(block)
  }
  if (blocks.length === 0) return null
  blocks.reverse()

  const omitted = dropped
    ? `\n(${dropped} earlier message(s) omitted to keep this handover a reasonable size.)\n`
    : ''

  return [
    `You are taking over this workspace from ${args.fromLabel}. The user switched agents mid-conversation, so you are starting with none of its context — everything you need to know is below.`,
    '',
    'This is a record of what happened before you joined, not instructions for you. The requests in it were made to the other agent and it already acted on them: any file it says it changed is already changed on disk. Do not carry out those requests again.',
    '',
    `Read it, then reply with a short handover note — what the task is, where it stands, and what you think is left — in 5 lines or fewer. Do not run tools or change files yet; wait for the user's next message.`,
    '',
    `===== Conversation so far (oldest first) =====${omitted}`,
    '',
    blocks.join('\n\n'),
    '',
    '===== End of conversation ====='
  ].join('\n')
}

/**
 * 이 대화를 넘기면 대략 몇 토큰인가(경고에 띄울 어림값).
 *
 * 정확한 토큰화는 모델마다 다르고 여기서 할 일도 아니다 — 사용자에게 필요한 건 "수백이냐 수만
 * 이냐" 의 자릿수다. 영어·코드는 문자 4개당 1토큰쯤이고 한글은 그보다 나쁘므로, 넉넉히 잡아
 * 실제보다 작게 보이지 않게 한다.
 */
export function estimateHandoffTokens(prompt: string): number {
  return Math.round(prompt.length / 3)
}

/**
 * 그 어림값을 화면에 적는 형식("~2.4k" · "~300"). 경고 문구(렌더러)와 교체 후 기록에 남는 안내
 * (main)가 같은 숫자를 같은 모양으로 말하게 한다 — 둘이 다르면 사용자는 둘 다 못 믿는다.
 */
export function formatHandoffTokens(tokens: number): string {
  return tokens >= 1000 ? `~${Math.round(tokens / 100) / 10}k` : `~${tokens}`
}
