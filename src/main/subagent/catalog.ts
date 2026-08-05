import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'

/**
 * 위임 서브에이전트 도구의 **정의** — 이름 · 서버 안내 · 인자 문구.
 *
 * #211 의 `agent/tools/catalog` 과 같은 역할이지만 별도 서버로 남긴다. 그쪽 도구는 메인으로 올려
 * **즉시 반환**하는 규약이고(claude/host.ts callMain), 이쪽은 agent-host 안에서 부모 세션의
 * canUseTool 을 직접 쓰며 분 단위로 블로킹한다. 정의를 합치는 것과 실행을 합치는 것은 다른
 * 문제이고, 실행 모델이 다른 것을 한 채널에 얹으면 그 규약이 깨진다.
 *
 * 두 전송 계층(Claude 의 SDK in-process 서버 · Codex 의 stdio shim)이 이 파일만 읽는다. 각자
 * 문구를 들고 있으면 메인을 무엇으로 골랐느냐에 따라 위임이 걸리기도 하고 안 걸리기도 한다.
 *
 * ## 이름이 백엔드별인 이유 — 첫 판에서 진 기록
 *
 * 처음에는 도구 하나(`delegate`) + `backend` enum 인자였다. Codex 메인 워크스페이스에서
 * "codex, claude 서브에이전트를 각각 생성해서 구현해줘" 라고 했더니 모델은 이 도구를 **한 번도
 * 부르지 않고** 자기 네이티브 서브에이전트 둘을 띄운 뒤 "이 환경에는 Claude 모델 선택지가 없어서
 * claude 서브에이전트도 Codex 계열로 실행됩니다" 라고 답했다. MCP 핸드셰이크도 tools/list 도
 * 정상이었다(실측). 도구가 없어서가 아니라 **모델이 설명을 읽고 도달하는 데 실패**한 것이다.
 *
 * 그래서 판단을 설명에서 **이름**으로 옮긴다. 사용자가 "claude 서브에이전트" 라고 말할 때
 * `claude_subagent` 라는 이름이 있으면 매칭이 기계적이다. 부수 효과로 잘못된 enum 값이 원천적으로
 * 불가능해지고, "어느 제품인가" 가 인자가 아니라 구조가 된다.
 *
 * 도구 이름은 사용자가 CLAUDE.md 규칙에 적게 되므로 **한번 정하면 바꾸기 어렵다**.
 */

/**
 * 위임 도구의 MCP 서버 이름. 도구는 모델에게 `mcp__wooi_agents__claude_subagent` 로 보인다.
 * `-` 를 쓰지 않는다 — codex 의 `mcp_servers.<name>` 키 규칙(`[A-Za-z0-9_-]`)과 Claude 의
 * `mcp__<server>__<tool>` 조합 양쪽에서 안전한 문자만 쓴다.
 */
export const DELEGATE_MCP_SERVER_NAME = 'wooi_agents'

export interface DelegateToolSpec {
  /** 모델에게 보이는 이름(서버 접두사 제외). */
  name: string
  /** 이 도구가 띄우는 에이전트 종류. 이름에 박혀 있으므로 인자가 아니다. */
  backend: AgentBackendId
  description: string
}

/** `claude` → `claude_subagent`. 이름만으로 어느 제품인지 읽히는 것이 요점이다. */
export function delegateToolName(backend: AgentBackendId): string {
  return `${backend}_subagent`
}

export function delegateTools(backends: AgentBackendId[]): DelegateToolSpec[] {
  return backends.map((backend) => {
    const label = AGENT_BACKEND_LABELS[backend] ?? backend
    return {
      name: delegateToolName(backend),
      backend,
      description:
        `Start a ${label} subagent in this workspace and wait for its result. ` +
        `It really runs on ${label} — not on your own model. ` +
        `Use this whenever the user asks for a ${label} subagent, or asks ${label} to do ` +
        'something, by name. ' +
        'Your own built-in subagent mechanism cannot run this product, so a request naming it is ' +
        'always this tool. ' +
        'Call it once per subagent you want; several can run at the same time. ' +
        'The subagent works in this same worktree under your permission mode, starts from an ' +
        'empty context, and reports back exactly once as text — it cannot ask you anything ' +
        'mid-run, so put everything it needs into the prompt.'
    }
  })
}

/**
 * 서버 수준 안내. 도구 하나하나의 설명이 아니라 **환경에 대한 사실**을 둔다.
 *
 * 이 자리가 따로 필요한 이유: 실패했을 때 모델이 한 말은 "이 환경에는 Claude 선택지가 없다" 였다.
 * 그건 도구에 대한 오해가 아니라 **환경에 대한 오해**이고, 도구 설명은 그걸 고치기에 잘못된
 * 자리다(도구를 열어 봐야 읽히므로). 안 열어 봐도 읽히는 곳에 사실을 적는다.
 */
export function delegateServerInstructions(backends: AgentBackendId[]): string {
  const labels = backends.map((id) => AGENT_BACKEND_LABELS[id] ?? id)
  // 목록을 영어 문장으로 잇는다. 둘일 때 "A and B are all …" 은 어색하고, 어색한 문장은
  // 모델이 사실로 읽는 데 방해가 된다 — 이 문장의 목적이 정확히 "사실을 믿게 하는 것"이다.
  const names =
    labels.length <= 1
      ? (labels[0] ?? 'No agent')
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  const verb = labels.length === 1 ? 'is' : labels.length === 2 ? 'are both' : 'are all'
  return (
    `This is a multi-agent Wooi workspace. ${names} ${verb} installed and available here, ` +
    'whichever one you are yourself, and each has a subagent tool below. ' +
    'When the user names a product, use its tool — your own built-in subagent mechanism only ' +
    'runs your own model, so it cannot satisfy that request. ' +
    'When the user names no product, your built-in subagents are still the better choice: they ' +
    'share your context and cost less.'
  )
}

/** 인자 설명. 스키마 표현(zod / JSON Schema)만 다르고 문구는 두 전송 계층이 공유한다. */
export const DELEGATE_ARG_TEXT = {
  description: 'A 3-6 word label for this task, shown while it runs (e.g. "Audit auth flow").',
  prompt:
    'The complete task brief. The subagent starts with a blank context and cannot see this ' +
    'conversation, so restate every fact it needs: files, constraints, and what to return.'
} as const
