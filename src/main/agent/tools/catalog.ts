import { z } from 'zod'

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
 *
 * **매 요청 시스템 프롬프트에 실린다.** 도구 정의는 지연 로딩(alwaysLoad 를 켜지 않는다)이라
 * 검색될 때만 비용을 내지만, 이 문장은 스택을 한 번도 쓰지 않는 워크스페이스까지 전부 낸다.
 * 그래서 여기에는 **상시 알아야 하는 것만** 둔다 — "스택이라는 게 있고 도구는 지금 이 워크스페이스
 * 에만 작용한다". 한때 여기 같이 있던 인계 규약(자식이 보고한다 · 보고는 저절로 오지 않는다)은
 * 필요한 쪽에 필요한 순간 전달하는 편이 싸고 정확해서 옮겼다. 부모는 create_stacked_workspace
 * 결과로, 자식은 인계 메시지로 받는다([[agent/tools/stackedWorkspace]]).
 */
export const WOOI_MCP_INSTRUCTIONS = [
  'These tools control Wooi itself — the desktop app hosting this conversation.',
  'Each workspace is a git worktree on its own branch, and workspaces can be stacked:',
  'one branches off another so their pull requests review as a chain.',
  'The tools always act on the workspace you are running in; you cannot target another one.'
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
      'The next piece should also be substantial: a new workspace starts from an empty context and',
      'has to rediscover the codebase, so a follow-up you could finish here in a few turns is',
      'cheaper to just finish here.',
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
            'should not revisit.\n\n' +
            'Also hand over what you already learned, so it does not pay to rediscover it: the ' +
            'files and symbols involved (as `path:line` where you know them), the commands you ' +
            'ran and what they reported, and the approaches you ruled out and why. Write down ' +
            'only what you are sure of — a wrong path costs more than a missing one, so leave ' +
            'out anything you are guessing at.\n\n' +
            'Omit this parameter entirely only if the user will drive that workspace themselves.'
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
  }
]

/** 읽기 전용으로 표시된 도구인가(카탈로그의 맨 이름으로 묻는다). */
export function isReadOnlyToolName(name: string): boolean {
  return AGENT_TOOLS.some((t) => t.name === name && t.annotations?.readOnlyHint === true)
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
