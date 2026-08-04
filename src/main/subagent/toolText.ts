import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'

/**
 * 위임 도구의 사용자(모델) 대면 문구.
 *
 * 두 백엔드가 **같은 도구를 같게 이해해야** 한다. 그래서 Claude 쪽(claude/delegate.ts, SDK
 * in-process 서버)과 Codex 쪽(delegateServer.ts, stdio 서버)이 문구를 각자 들고 있지 않고 여기서
 * 가져간다 — 갈라지면 메인을 무엇으로 골랐느냐에 따라 위임이 걸리기도 하고 안 걸리기도 한다.
 *
 * ## 문구가 이 모양인 이유
 *
 * 첫 판에서 Codex 메인 워크스페이스에 "codex, claude 서브에이전트를 각각 생성해서 구현해줘"
 * 라고 했더니, 모델이 이 도구를 **한 번도 부르지 않고** 자기 네이티브 서브에이전트 둘을 띄운 뒤
 * "이 환경에는 Claude 모델 선택지가 없어서 claude 서브에이전트도 Codex 계열로 실행됩니다" 라고
 * 답했다. MCP 핸드셰이크와 tools/list 는 정상이었으므로(실측), 도구가 없어서가 아니라 **문구가
 * 졌다**. 두 가지가 원인이었다:
 *
 *  1. "같은 종류면 네이티브를 써라" 는 단서가 역효과였다. 사용자가 codex 하나 claude 하나를
 *     요구했는데, codex 쪽에서 네이티브를 고르는 순간 나머지도 같은 방식으로 흘러갔다.
 *     → 사용자가 **제품을 지목했으면** 그 단서를 적용하지 않는다고 못 박는다.
 *  2. 어휘가 어긋났다. 사용자와 모델은 "서브에이전트" 라고 말하는데 문구는 "coding agent
 *     product" 라고만 했다. 그 단어는 모델의 네이티브 기능이 이미 가져가 있었다.
 *     → 문구가 "subagent" 를 명시적으로 가져온다.
 *
 * 그리고 모델이 "Claude 선택지가 없다" 고 단언했으므로, **정말로 쓸 수 있다** 는 것을 문장으로
 * 적는다 — 도구 목록에 있다는 사실만으로는 모델이 그렇게 읽지 않았다.
 */
export function delegateToolDescription(backends: AgentBackendId[]): string {
  const names = backends.map((id) => AGENT_BACKEND_LABELS[id] ?? id).join(' and ')
  return (
    'Start a subagent that runs on a named coding agent product, and wait for its result. ' +
    `This workspace is multi-agent: ${names} are genuinely available to you here, whichever one ` +
    'you are yourself. ' +
    'Use this whenever the user names a product — "make a claude subagent", "have Codex review ' +
    'this", "run it on both and compare". A request for a subagent *of a named product* is always ' +
    'this tool, never your built-in subagent mechanism, because your built-in one can only run ' +
    'your own model. ' +
    'When the user does not name a product, prefer your built-in subagents: they share your ' +
    'context and cost less. ' +
    'Call this once per subagent you need; several can run at the same time. ' +
    'The subagent works in this same worktree under your permission mode, starts from an empty ' +
    'context, and reports back exactly once as text — it cannot ask you anything mid-run, so put ' +
    'everything it needs into the prompt.'
  )
}

/** 인자 설명. 스키마 표현(zod / JSON Schema)만 다르고 문구는 두 경로가 공유한다. */
export const DELEGATE_ARG_TEXT = {
  backend: 'Which agent product runs this subagent. Match the product the user named.',
  description: 'A 3-6 word label for this task, shown while it runs (e.g. "Audit auth flow").',
  prompt:
    'The complete task brief. The subagent starts with a blank context and cannot see this ' +
    'conversation, so restate every fact it needs: files, constraints, and what to return.'
} as const
