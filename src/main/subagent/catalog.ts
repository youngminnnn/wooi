import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'
import { WOOI_MCP_SERVER_NAME, delegateToolName } from '../agent/tools/catalog'

/**
 * Codex 스레드의 `developerInstructions` 에 실을 문장.
 *
 * 도구의 **정의**는 여기 없다 — 다른 Wooi 도구와 함께 [[agent/tools/catalog]] 에 있고, 두 전송
 * 계층(Claude 인프로세스 서버 · Codex stdio shim)이 거기서 가져간다. 이 파일에 남은 것은 Codex
 * 에만 필요한 한 가지, "그 도구들이 존재한다는 사실을 문장으로 알리기" 뿐이다.
 *
 * ## 왜 이게 따로 필요한가 — 측정으로 밝혀진 것
 *
 * Codex 는 MCP 도구를 모델의 도구 목록에 **눈에 띄게 올려 주지 않는다**. 실측:
 *
 *  - 서버는 `status: "ready"` 까지 정상 로드된다.
 *  - 모델에게 "쓸 수 있는 도구를 전부 나열하라" 고 하면 `claude_subagent` 가 **안 나온다**
 *    (사용자가 등록해 둔 다른 MCP 서버의 도구도 마찬가지로 안 나온다 — 우리만의 문제가 아니다).
 *  - 그런데 **이름을 대고 부르라고 하면 정확히 부른다**. 즉 없는 게 아니라 안 보이는 것이다.
 *
 * 그래서 "claude 서브에이전트 만들어줘" 같은 자연스러운 요청에서 0/5 였다. 도구 이름을 백엔드별로
 * 바꿔도 숫자가 움직이지 않았다 — 모델이 **존재를 모르는데** 이름이 좋은 것은 소용이 없다.
 * 여기에 도구 이름을 적어 주자 같은 문장이 바로 걸렸다.
 *
 * Claude 쪽은 SDK 가 도구 정의를 프롬프트에 직접 싣기 때문에 이 문제가 없다.
 */
/**
 * Solo 워크스페이스의 Codex 스레드에 실을 문장.
 *
 * 위 주석의 실측이 여기서 더 아프다. Codex 에게 MCP 도구는 **이름조차 보이지 않으므로**,
 * Solo 워크스페이스의 Codex 는 `switch_to_agent_team` 이 존재한다는 사실 자체를 알 길이 없다.
 * Claude 는 이름 목록이라도 보지만(그것만으로는 부족하다는 것이 dev 트랜스크립트 349b8642 의
 * 교훈이다) Codex 는 그마저 없다.
 *
 * 팀으로 바꿀 수 있는 워크스페이스에만 싣는다 — 부르면 반드시 실패하는 도구를 권하지 않는다.
 */
export function soloThreadInstructions(): string {
  return [
    'This is a Solo Wooi workspace: you cannot run other coding agent products (Claude Code,',
    'Codex) as subagents here, and running their CLIs from the shell is not a substitute — that',
    'bypasses approval and hides the work from the user.',
    `If the user asks for one, call the \`${WOOI_MCP_SERVER_NAME}\` MCP server's`,
    '`switch_to_agent_team` tool first; the user approves the switch and the subagent tools',
    'arrive on your next turn, which Wooi starts on its own as soon as this one ends.'
  ].join('\n')
}

export function delegateThreadInstructions(backends: AgentBackendId[]): string {
  const lines = backends.map(
    (backend) =>
      `- \`${delegateToolName(backend)}\` — starts a subagent running on ` +
      `${AGENT_BACKEND_LABELS[backend] ?? backend}.`
  )
  return [
    'This is a multi-agent Wooi workspace. Besides your own built-in subagents, the',
    `\`${WOOI_MCP_SERVER_NAME}\` MCP server gives you one subagent tool per coding agent product:`,
    ...lines,
    'These really run that product, not your own model. When the user asks for a subagent of a',
    'named product — or asks that product to do something — call its tool; your built-in subagent',
    'mechanism cannot satisfy that request. When no product is named, prefer your built-in',
    'subagents: they share your context and cost less.'
  ].join('\n')
}
