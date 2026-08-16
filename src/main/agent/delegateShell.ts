import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'
import { delegateToolName } from './tools/catalog'

/**
 * 에이전트가 **셸로** 다른 에이전트 제품을 돌리려는 시도를 알아본다.
 *
 * 왜 이런 것이 필요한가. 실측(dev 트랜스크립트 349b8642): Solo 워크스페이스에서 "codex
 * 서브에이전트에 구현을 지시해" 라고 했더니 모델은 `~/.claude/agents/` 를 뒤지고 `codex --help`
 * 를 읽은 뒤 `codex exec --sandbox workspace-write "..."` 를 Bash 로 돌렸다. Wooi 도구는 한 번도
 * 찾아보지 않았다 — 지연 로딩된 도구의 **이름**은 프롬프트에 있지만, "codex 서브에이전트" 를
 * 찾는 모델에게 `switch_to_agent_team` 이라는 이름은 아무것도 말해 주지 않기 때문이다.
 *
 * 그래서 발견을 모델의 상상력에 맡기지 않고, **셸로 새려는 순간을 붙잡아** 올바른 도구를
 * 지목한다. 이 경로는 조용히 나쁘다: 승인 카드도, 서브에이전트 활동 패널도, 권한 모드 상속도
 * 전부 우회하고, 사용자는 Bash 한 줄 뒤에서 다른 에이전트가 파일을 고치는 것을 보지 못한다.
 *
 * 순수 함수로 떼어 둔 이유는 두 곳에서 같은 판단을 해야 하기 때문이다 — Claude 는 세션의
 * canUseTool(호스트 프로세스), Codex 는 명령 승인 경로(메인)다. 판단이 갈리면 한쪽 백엔드에서만
 * 새는 구멍이 된다.
 */

/**
 * 비대화형 실행 형태만 잡는다.
 *
 * `codex --version` 이나 `claude --help` 같은 **탐색**은 잡지 않는다. 실측에서 모델은 그것부터
 * 했고, 거기서 막으면 "이 환경에는 codex 가 없다" 로 잘못 배운다. 우리가 막고 싶은 것은 알아보는
 * 일이 아니라 **일을 시키는** 일이다.
 *
 * 대화형 실행(`codex` · `claude` 를 인자 없이)도 잡지 않는다. 그건 애초에 에이전트의 Bash 안에서
 * 성립하지 않고(TTY 가 없다), 잡으면 사용자가 터미널 패널에서 돌리는 것까지 걸릴 여지가 생긴다.
 */
const LAUNCHERS: { backend: AgentBackendId; pattern: RegExp }[] = [
  // `codex exec …` · `codex e …`(별칭) · `codex review …`. 모두 비대화형 실행이다.
  { backend: 'codex', pattern: /(?:^|[\s;&|(])codex\s+(?:exec|e|review)(?:\s|$)/ },
  // Copilot 의 문서화된 헤드리스 실행만 잡는다. --acp 는 위임이 아니라 서버 탐색이라 제외한다.
  { backend: 'copilot', pattern: /(?:^|[\s;&|(])copilot\s+(?:.*\s)?(?:-p|--prompt)(?:\s|=|$)/ },
  // `claude -p …` · `claude --print …`. 헤드리스 실행의 표준 형태다.
  { backend: 'claude', pattern: /(?:^|[\s;&|(])claude\s+(?:.*\s)?(?:-p|--print)(?:\s|=|$)/ }
]

/** 이 명령이 어떤 에이전트 제품을 셸로 돌리려는 것인가. 아니면 null. */
export function delegateShellAttempt(command: string): AgentBackendId | null {
  // `npx codex exec`·`env FOO=1 codex exec` 처럼 앞에 뭐가 붙어도 걸리도록 경계만 본다.
  const text = command.trim()
  if (!text) return null
  return LAUNCHERS.find((l) => l.pattern.test(text))?.backend ?? null
}

/**
 * 가로챈 시도에 돌려줄 문장. **거절 사유가 아니라 대안 안내**여야 한다 — 모델이 이 문장을 읽고
 * 같은 턴에 올바른 도구를 부를 수 있어야, 사용자에게는 "셸로 새는 대신 물어봤다" 로 보인다.
 *
 * 여기서 모드를 대신 바꿔 주지 않는 것이 요점이다. 승인 없이 워크스페이스 상태가 바뀌면 사용자가
 * 판단할 카드가 사라진다. 대신 `switch_to_agent_team` 을 지목하고, 그 도구가 자기 카드를 띄운다.
 */
export function delegateShellGuidance(
  backend: AgentBackendId,
  /** 이 세션이 이미 팀인가(위임 도구를 들고 있는가). */
  isTeam: boolean,
  /** 팀이 아닐 때, 팀으로 바꿀 수 있는 워크스페이스인가. */
  canSwitch: boolean
): string {
  const label = AGENT_BACKEND_LABELS[backend] ?? backend
  const tool = delegateToolName(backend)
  const why =
    `Running ${label} through the shell hides it from Wooi: the user sees a Bash call instead ` +
    'of a subagent, its tool calls skip this workspace’s approval flow, and its progress never ' +
    'reaches the panel the user is watching.'

  if (isTeam) {
    return (
      `${why} This workspace is an agent team, so call \`${tool}\` instead — same run, routed ` +
      'through Wooi.'
    )
  }
  if (canSwitch) {
    return (
      `${why} This workspace is Solo, so \`${tool}\` does not exist here yet. Call ` +
      '`switch_to_agent_team` — the user approves that switch, and `' +
      tool +
      '` is available from your next turn, which Wooi starts on its own as soon as this one ' +
      'ends. Do not work around this with the shell.'
    )
  }
  // 바꿀 수도 없는 워크스페이스에서 대안 없이 막으면 그냥 능력을 뺏는 것이다. 사실만 말하고
  // 사용자에게 넘긴다.
  return (
    `${why} This workspace cannot run Wooi subagents, so there is no in-app equivalent — tell ` +
    'the user what you wanted to run and let them decide.'
  )
}
