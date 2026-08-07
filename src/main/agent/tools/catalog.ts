import { z } from 'zod'
import { AGENT_BACKEND_IDS, AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'

/**
 * 에이전트에게 노출하는 Wooi 도구의 **정의**(이름 · 설명 · 스키마). 실행부는 [[agent/tools]] 에 있다.
 *
 * 정의와 실행을 가른 이유: 정의는 전송 계층(호스트의 인프로세스 MCP 서버, 나중에 Codex 용
 * stdio shim)이 읽어야 하고, 실행은 메인만 할 수 있다. 한 파일에 두면 전송 계층이 메인의
 * store·git 을 끌어오게 된다.
 *
 * shared/ 가 아니라 여기에 두는 이유: 렌더러는 이 목록을 쓰지 않는데, shared/ 에 두면 zod 가
 * 렌더러 번들로 딸려 들어간다.
 */

/** MCP 서버 이름. 도구는 모델에게 `mcp__wooi__<name>` 으로 보인다. */
export const WOOI_MCP_SERVER_NAME = 'wooi'

/**
 * 서버 수준 안내. 도구 하나하나의 설명이 아니라 "Wooi 가 무엇이고 이 도구들이 왜 있는가" 를 둔다.
 *
 * 시스템 프롬프트(systemPrompt.ts)에 적지 않는다 — 거기는 Claude Code 기본 프롬프트를 얇게
 * 보정하는 자리이고, 도구 설명으로 불리면 그 의도가 무너진다.
 */
export const WOOI_MCP_INSTRUCTIONS = [
  'These tools control Wooi itself — the desktop app hosting this conversation.',
  'Each Wooi workspace is a git worktree with its own branch, and they can be stacked:',
  'one workspace branches off another so their pull requests review as a chain.',
  'The tools always act on the workspace you are running in; you cannot target another one.',
  '',
  'Stacked workspaces hand work back and forth: a parent starts a child with a task, the child',
  'reports back when it finishes or gets stuck, and the parent reads those reports on its next',
  'turn. Reports do not interrupt whoever is working — nothing arrives in your conversation on',
  'its own, so check for it when the answer would change what you do.'
].join(' ')

export interface AgentToolSpec {
  /** 모델에게 보이는 이름. 사용자가 CLAUDE.md 규칙에 적게 되므로 **한번 정하면 바꾸기 어렵다**. */
  name: string
  description: string
  inputSchema: z.ZodRawShape
  /**
   * MCP 표준 힌트. `readOnlyHint` 는 권한 정책의 근거다 — 상태를 바꾸지 않는 도구는 승인을 물어도
   * 의미가 없고, 매번 카드가 뜨면 정작 물어야 할 도구의 카드가 묻힌다(session.ts canUseTool).
   */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
  /**
   * true 면 매 요청 시스템 프롬프트에 정의가 항상 실린다. 기본은 지연 로딩(tool search)이다 —
   * 도구가 늘수록 프롬프트 비용이 선형으로 늘기 때문에, 항상 보여야 할 것만 켠다.
   */
  alwaysLoad?: boolean
}

/**
 * 워크스페이스와 무관하게 언제나 있는 도구들.
 *
 * 여기 없는 것도 있다 — 위임 서브에이전트 도구는 멀티 에이전트 워크스페이스에서만 존재하므로
 * 목록이 아니라 함수([[agentToolsFor]])로 만든다.
 */
export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'create_stacked_workspace',
    description: [
      'Create a new Wooi workspace stacked on top of the current one: a fresh git worktree on a',
      'new branch that forks from this workspace’s branch, so its pull request targets this',
      'branch instead of the default branch.',
      '',
      'Use this when the work you just finished is a complete, reviewable unit and the next piece',
      'should ship as a separate pull request layered on it — rather than growing this branch.',
      '',
      'The new workspace forks from the committed tip of this branch, so commit your work first;',
      'the call fails while this worktree has uncommitted changes. It starts with an empty',
      'conversation and does not steal the user’s screen — tell the user it is ready and what it',
      'is for.'
    ].join(' '),
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'Branch name for the new workspace, following the repository’s branch naming convention ' +
            '(e.g. "feat/inline-login"). Omit to let Wooi generate one.'
        ),
      task: z
        .string()
        .optional()
        .describe(
          'The task to hand the new workspace, sent as its first message — it starts working on ' +
            'this right away. Write it for an agent that cannot see this conversation: what to ' +
            'build, why it is a separate pull request, and anything you already decided that it ' +
            'should not revisit. Omit only if the user will drive that workspace themselves.'
        )
    },
    annotations: { title: 'Create a stacked workspace', readOnlyHint: false }
  },
  {
    name: 'report_to_parent',
    description: [
      'Report back to the workspace this one was stacked on: what you finished, or what you are',
      'blocked on. Call this when the task you were handed is done or cannot proceed — it is the',
      'only way the parent finds out, since nothing crosses between workspaces on its own.',
      '',
      'Write the summary for an agent that never saw your conversation: what changed, what you',
      'decided and why, and anything it must know before building on your branch. Reporting again',
      'replaces your previous report. This does not interrupt the parent — it reads the report on',
      'its next turn, and the user is shown it in the parent’s conversation.'
    ].join(' '),
    inputSchema: {
      summary: z
        .string()
        .describe('What you did, decided, or got stuck on. Written for someone with no context.'),
      status: z
        .enum(['done', 'blocked'])
        .optional()
        .describe(
          '"done" if the task is complete, "blocked" if it needs a decision from the parent or ' +
            'the user. Defaults to "done".'
        )
    },
    annotations: { title: 'Report to the parent workspace', readOnlyHint: false }
  },
  {
    name: 'check_stacked_work',
    description: [
      'List the workspaces stacked directly on this one, with whether each is currently running,',
      'its branch and pull request, and the last report it sent back.',
      '',
      'Reports never arrive in your conversation on their own, so call this when a child’s result',
      'would change what you do next — before building on its branch, before opening a pull',
      'request that depends on it, or when the user asks how the stack is going.'
    ].join(' '),
    inputSchema: {},
    annotations: { title: 'Check stacked workspaces', readOnlyHint: true }
  },
  {
    name: 'open_pull_request',
    description: [
      'Open a pull request for this workspace’s branch, pushing it to the remote first if needed.',
      '',
      'There is no base argument: Wooi targets the parent workspace’s branch when this one is',
      'stacked, and the repository’s default branch otherwise. Use this rather than `gh pr create`,',
      'which cannot know that and silently targets the default branch.'
    ].join(' '),
    inputSchema: {
      title: z.string().describe('Pull request title.'),
      body: z.string().describe('Pull request description, in Markdown.'),
      draft: z.boolean().optional().describe('Open it as a draft. Defaults to false.')
    },
    annotations: { title: 'Open a pull request', readOnlyHint: false }
  }
]

/**
 * 이 워크스페이스가 지금 쓸 수 있는 도구 전부.
 *
 * 카탈로그가 상수가 아니라 함수인 이유: 위임 서브에이전트 도구(`claude_subagent` …)는 멀티
 * 에이전트 워크스페이스에만 있어야 한다. 늘 노출해 두고 호출 시점에 거절하면 모델에게 쓸 수 없는
 * 도구를 보여 주는 셈이라 계약이 나쁘다 — 없는 것은 보이지 않아야 한다.
 */
export function agentToolsFor(
  delegateBackends: AgentBackendId[] = [],
  /** 부르는 쪽이 도구 호출을 직렬화하는가(Codex). 설명 문구가 달라진다. */
  serialized = false
): AgentToolSpec[] {
  return [...AGENT_TOOLS, ...delegateToolSpecs(delegateBackends, serialized)]
}

/**
 * 백엔드마다 서브에이전트 도구 하나.
 *
 * 이름이 판단을 대신한다. 처음에는 도구 하나(`delegate`) + `backend` enum 이었는데, Codex 메인
 * 워크스페이스에서 "claude 서브에이전트를 만들어 줘" 라고 해도 모델이 자기 네이티브 서브에이전트를
 * 골랐다 — 설명을 읽고 도달하는 데 실패한 것이다. `claude_subagent` 라는 이름이 있으면 매칭이
 * 기계적이고, 잘못된 백엔드 값이 원천적으로 불가능해진다.
 *
 * 도구 이름은 사용자가 CLAUDE.md 규칙에 적게 되므로 한번 정하면 바꾸기 어렵다.
 */
export function delegateToolSpecs(
  backends: AgentBackendId[],
  /**
   * 부르는 쪽이 도구 호출을 **직렬화**하는가.
   *
   * Codex 가 그렇다(실측: 두 서브에이전트를 요청하면 42초 간격으로 하나씩 시작했고, 겹치는 구간이
   * 0 이었다). Claude 는 한 메시지에 여러 tool_use 를 실어 겹쳐 돌린다. 우리 도구는 분 단위로
   * 블로킹하므로 이 차이가 사용자에게 그대로 보인다 — "둘 다 동시에 돌려서 비교해줘" 가 순차가
   * 된다. 모델이 미리 알고 말해 줄 수 있도록 설명에 적는다.
   */
  serialized = false
): AgentToolSpec[] {
  return backends.map((backend) => {
    const label = AGENT_BACKEND_LABELS[backend] ?? backend
    return {
      name: delegateToolName(backend),
      description: [
        `Start a ${label} subagent in this workspace and wait for its result.`,
        `It really runs on ${label} — not on your own model.`,
        `Use this whenever the user asks for a ${label} subagent, or asks ${label} to do`,
        'something, by name. Your own built-in subagent mechanism cannot run this product, so a',
        'request naming it is always this tool. Call it once per subagent you want.',
        serialized
          ? 'Your tool calls run one after another, so several subagents finish in sequence, not' +
            ' at the same time — say so if the user expects them to run together.'
          : 'Several can run at the same time.',
        'The subagent works in this same worktree under your permission mode, starts from an',
        'empty context, and reports back exactly once as text — it cannot ask you anything',
        'mid-run, so put everything it needs into the prompt.'
      ].join(' '),
      inputSchema: {
        description: z
          .string()
          .describe(
            'A 3-6 word label for this task, shown while it runs (e.g. "Audit auth flow").'
          ),
        prompt: z
          .string()
          .describe(
            'The complete task brief. The subagent starts with a blank context and cannot see ' +
              'this conversation, so restate every fact it needs: files, constraints, and what to return.'
          )
      },
      annotations: { title: `Run a ${label} subagent`, readOnlyHint: false },
      // 지연 로딩(tool search) 뒤에 두지 않는다. 실측에서 모델이 이 도구를 쓰기 전에 ToolSearch
      // 로 먼저 찾아 왔는데, 그건 **이름을 이미 알 때** 통하는 경로다. "codex 한테 시켜줘" 처럼
      // 이름 없이 말한 요청은 검색 단계에서 놓칠 수 있고, 그게 Codex 에서 겪은 "존재를 모른다"
      // 와 같은 실패다. 비용은 멀티 에이전트 워크스페이스에만 붙는다 — 그 외에는 도구 자체가 없다.
      alwaysLoad: true
    }
  })
}

/** `claude` → `claude_subagent`. 이름만으로 어느 제품인지 읽히는 것이 요점이다. */
export function delegateToolName(backend: AgentBackendId): string {
  return `${backend}_subagent`
}

/** 읽기 전용으로 표시된 도구인가(카탈로그의 맨 이름으로 묻는다). */
export function isReadOnlyToolName(name: string): boolean {
  // 위임 도구까지 포함해 본다 — 목록에 없는 이름을 "읽기 전용이 아님" 으로 떨어뜨리는 것이
  // 안전한 기본값이지만, 나중에 읽기 전용 위임 도구가 생기면 여기서 자동으로 반영된다.
  return agentToolsFor(AGENT_BACKEND_IDS).some(
    (t) => t.name === name && t.annotations?.readOnlyHint === true
  )
}

/**
 * 같은 판단을 모델에게 보이는 전체 이름(`mcp__wooi__x`)으로 한다.
 *
 * 접두사를 반드시 확인한다 — 남의 MCP 서버가 우연히 같은 도구 이름을 쓸 수 있고, 그것까지
 * 자동 승인하면 우리가 심사하지 않은 도구가 조용히 통과한다.
 */
export function isReadOnlyWooiTool(qualifiedName: string): boolean {
  const prefix = `mcp__${WOOI_MCP_SERVER_NAME}__`
  if (!qualifiedName.startsWith(prefix)) return false
  return isReadOnlyToolName(qualifiedName.slice(prefix.length))
}
