import { z } from 'zod'
import {
  AGENT_BACKEND_IDS,
  AGENT_BACKEND_LABELS,
  type AgentBackendId,
  type EffortSetting
} from '@shared/types'
import { AGENT_BACKENDS } from '../backend'

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
 * **매 요청 시스템 프롬프트에 실린다.** 도구 정의는 대체로 지연 로딩이라(alwaysLoad 는 모델이
 * 이름을 모른 채로 도달해야 하는 몇 개만 켠다) 검색될 때만 비용을 내지만, 이 문장은 스택을
 * 한 번도 쓰지 않는 워크스페이스까지 전부 낸다.
 * 그래서 여기에는 **상시 알아야 하는 것만** 둔다 — "스택이라는 게 있고, 대상을 받는 도구는
 * 자기가 만든 것만 지목할 수 있다". 한때 여기 같이 있던 인계 규약(자식이 보고한다 · 보고는 저절로 오지 않는다)은
 * 필요한 쪽에 필요한 순간 전달하는 편이 싸고 정확해서 옮겼다. 부모는 create_stacked_workspace
 * 결과로, 자식은 인계 메시지로 받는다([[agent/tools/stackedWorkspace]]).
 */
export const WOOI_MCP_INSTRUCTIONS = [
  'These tools control Wooi itself — the desktop app hosting this conversation.',
  'Each workspace is a git worktree on its own branch, and workspaces can be stacked:',
  'one branches off another so their pull requests review as a chain.',
  // 한때 "도구는 언제나 자기 자신에게만 작용한다" 였다. archive_workspace 가 대상을 인자로 받으면서
  // 그 문장이 거짓이 됐고, 거짓인 채로 두면 모델은 남을 지목할 수 있다는 것도, 아무나 지목할 수는
  // 없다는 것도 모른 채 시도하게 된다. 실제 경계를 그대로 적는다([[agent/tools/target]]).
  'Most tools act on the workspace you are running in; the ones that take a workspace id can only',
  'name a workspace you created yourself.',
  // 이 한 줄이 없으면 `send_to_workspace` 는 사실상 없는 도구다. 도구 검색은 **이미 무엇을 찾는지
  // 알 때** 통하는 경로인데, 다른 워크스페이스에 말을 걸 수 있다는 것 자체를 모르는 모델에게는
  // 검색해 볼 단어가 없다 — check_related_work 를 alwaysLoad 로 둔 것과 같은 실패다. 정의 전체를
  // 상시 싣는 대신(그쪽은 ≈250 토큰) 능력의 존재만 알린다.
  'One exception: `send_to_workspace` can message any open workspace, in any repository —',
  'use it instead of asking the user to relay something to work happening elsewhere.'
].join(' ')

/**
 * Solo 워크스페이스에만 붙는 한 문장.
 *
 * 지연 로딩된 도구의 **이름**은 프롬프트에 있지만 설명은 없다. 그래서 "codex 서브에이전트에게
 * 시켜" 라는 요청을 받은 모델이 이름 목록을 훑어도 `switch_to_agent_team` 이 그 답이라는 것을
 * 알 수 없다 — 그 이름에는 codex 도 subagent 도 없다. 실측(dev 트랜스크립트 349b8642)에서 모델은
 * Wooi 도구를 아예 찾아보지 않고 `codex exec` 를 셸로 돌렸다.
 *
 * 그 공백을 메우는 다리다. 도구 정의를 통째로 상시 로딩하는 것(alwaysLoad, ≈250 토큰)보다 훨씬
 * 싸면서, 필요한 연결 하나를 정확히 만들어 준다. 팀 워크스페이스에는 붙이지 않는다 — 거기서는
 * 위임 도구가 이름부터 `codex_subagent` 라 다리가 필요 없다.
 */
const SOLO_INSTRUCTIONS =
  'This workspace is Solo: you cannot run other agent products (Claude Code, Codex) as ' +
  'subagents here, and running their CLIs from the shell is not a substitute — it bypasses ' +
  'approval and hides the work from the user. If the user asks for one, call ' +
  '`switch_to_agent_team` first.'

/**
 * 이 워크스페이스에 실을 서버 수준 안내. 팀으로 **바꿀 수 있는** Solo 일 때만 한 줄이 붙는다.
 *
 * 바꿀 수 없는 워크스페이스(실험 스위치 꺼짐·조율 못 하는 백엔드)에는 붙이지 않는다 — 부르면
 * 반드시 실패하는 도구를 권하는 것은 안내가 아니라 함정이고, 모델은 그 실패를 자기 잘못으로
 * 읽는다(createIndependentWorkspace 가 report_to_parent 안내를 뺀 것과 같은 이유).
 */
export function wooiMcpInstructions(
  delegateBackends: AgentBackendId[] = [],
  canSwitchToAgentTeam = false
): string {
  if (delegateBackends.length || !canSwitchToAgentTeam) return WOOI_MCP_INSTRUCTIONS
  return `${WOOI_MCP_INSTRUCTIONS} ${SOLO_INSTRUCTIONS}`
}

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
   *
   * 기준은 "유용한가" 가 아니라 **"모델이 이름을 모른 채로 도달해야 하는가"** 다. 검색은 이미
   * 무엇을 찾는지 알 때 통하는 경로라, 그 단어가 떠오르지 않는 순간이 곧 실패 지점인 도구
   * (`claude_subagent` · `check_related_work`)만 켠다. 나머지는 필요할 때 찾아오면 된다.
   */
  alwaysLoad?: boolean
}

/**
 * 워크스페이스를 만드는 두 도구가 공유하는 **에이전트 설정** 파라미터 — 무엇으로, 어떤 모델과
 * 추론 강도로 돌릴지. 값의 검증은 [[agent/tools/agentOptions]] 가 한다.
 *
 * 스키마를 함수로 만든 이유는 문구가 갈리기 때문이다. 생략했을 때의 기본값이 독립 워크스페이스와
 * 스택 자식에서 다르고(스택은 부모 에이전트를 물려받는다), 그 차이는 모델이 알아야 고를 수 있다.
 */
function agentOptionParams(inherits: 'default' | 'parent'): z.ZodRawShape {
  const fallback =
    inherits === 'parent'
      ? 'Omit to inherit this workspace’s agent.'
      : 'Omit to use Wooi’s default agent.'
  // effort 는 백엔드 메타가 SSOT 다 — 백엔드가 단계를 늘리면 이 목록도 따라 늘어야 한다.
  const efforts = Array.from(
    new Set(Object.values(AGENT_BACKENDS).flatMap((meta) => meta.efforts.map((e) => e.id)))
  ) as [EffortSetting, ...EffortSetting[]]
  return {
    agentBackend: z
      .enum(AGENT_BACKEND_IDS as [AgentBackendId, ...AgentBackendId[]])
      .optional()
      .describe(
        `Agent that will run the new workspace. ${fallback} Available ` +
          `agents: ${AGENT_BACKEND_IDS.map((id) => `${id} (${AGENT_BACKEND_LABELS[id]})`).join(', ')}.`
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Model the new workspace runs on, written as that agent’s own model id (Claude Code ' +
          'takes ids like "claude-opus-5[1m]"; Codex has its own catalogue). Omit to use ' +
          'whatever the agent is configured to default to — do not guess an id to fill this in. ' +
          'Wooi rejects the call and lists the ids it accepts if this one is not among them. ' +
          'The model does not carry over from this workspace, so name it here to keep the new ' +
          'workspace on the same one.'
      ),
    effort: z
      .enum(efforts)
      .optional()
      .describe(
        'Reasoning effort for the new workspace. Omit to use that agent’s configured default. ' +
          'Which values an agent accepts differs; Wooi rejects the call and lists them if this ' +
          'one is not among them.'
      )
  }
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
      ...agentOptionParams('parent'),
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
      'Report once, for the task you were handed. That call closes the handoff, and whatever the',
      'user asks you for afterwards is ordinary work in this workspace: report again only when the',
      'parent has a decision waiting on the answer, not at the end of every turn. A later report',
      'replaces the earlier one.',
      '',
      'Write the summary for an agent that never saw your conversation: what changed, what you',
      'decided and why, and anything it must know before building on your branch. This does not',
      'interrupt the parent — it reads the report on its next turn, and the user is shown it in',
      'the parent’s conversation.'
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
    name: 'notify_child',
    description: [
      'Send a message to a workspace stacked directly on this one. Use it when something here',
      'invalidates what that workspace is working from — a decision you reversed, an interface you',
      'moved, review feedback that lands on its branch too. Its branch forks from yours, so it is',
      'building on facts only you can update.',
      '',
      'This is not the mirror image of `report_to_parent`, and the difference matters: a report',
      'only leaves a note, but this **starts a turn** in that workspace, because the user approves',
      'the call. Unlike the other tools that take a workspace id, this one does not mind a busy',
      'target — your message lands after its current turn rather than cutting it off.',
      '',
      'Call `check_stacked_work` first. That is where the ids come from, and it marks which',
      'children you created yourself — you can only message those.',
      '',
      'Handing over a whole new piece of work is `create_stacked_workspace`, not this.'
    ].join(' '),
    inputSchema: {
      workspaceId: z
        .string()
        .describe(
          'Which workspace to message — an id from `check_stacked_work`, and one you created.'
        ),
      message: z
        .string()
        .describe(
          'What that workspace needs to know, written for an agent that cannot see this ' +
            'conversation: what changed, and what it should do differently because of it.'
        )
    },
    annotations: { title: 'Message a stacked workspace', readOnlyHint: false }
  },
  {
    name: 'check_stacked_work',
    description: [
      'List the workspaces stacked directly on this one, with whether each is currently running,',
      'whether you created it, its branch and pull request, and the last report it sent back.',
      'A one-word `state` says why each child is or is not running — approval waits, usage limits,',
      'and errors otherwise look idle, and a child waiting for the user cannot report on its own.',
      '',
      'Reports never arrive in your conversation on their own, so call this when a child’s result',
      'would change what you do next — before building on its branch, before opening a pull',
      'request that depends on it, or when the user asks how the stack is going.',
      'It is also where `notify_child` gets its workspace ids.'
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
  },
  {
    name: 'run_script',
    description: [
      'Run a repository script by its user-defined name, restarting it if already running.',
      'Names differ per repository; if a name is wrong, the error lists the available names.',
      'Use this rather than running the command yourself: it outlives your session and its output',
      'goes to the panel the user is watching, so you both read the same log.'
    ].join(' '),
    inputSchema: {
      name: z.string().describe('Run script name, or the reserved name "setup".')
    },
    annotations: { title: 'Run a repository script', readOnlyHint: false }
  },
  {
    name: 'stop_script',
    description: 'Stop a named repository script. Invalid names return the available names.',
    inputSchema: {
      name: z.string().describe('Run script name, or the reserved name "setup".')
    },
    annotations: { title: 'Stop a repository script', readOnlyHint: false }
  },
  {
    name: 'read_script_output',
    description: [
      'Read a script’s recent output, along with whether it is still running and its exit code.',
      'The output is truncated from the start — you always get the end, where the errors are.'
    ].join(' '),
    inputSchema: {
      name: z.string().describe('Run script name, or the reserved name "setup".'),
      tailLines: z
        .number()
        .int()
        .optional()
        .describe('How many trailing lines to return. Defaults to 200, capped at 500.')
    },
    annotations: { title: 'Read script output', readOnlyHint: true }
  },
  {
    name: 'check_related_work',
    description: [
      'Find out whether another workspace is already changing the files you are about to touch.',
      'This repository has several workspaces open at once, each in its own worktree on its own',
      'branch — parents, children and unrelated siblings alike. Files you have not touched can be',
      'changing under you, and nothing tells you unless you ask; a collision you miss surfaces at',
      'merge time, when untangling it costs far more than asking now.',
      '',
      'Call it before you start editing, whenever any of these is true: the change spans more than',
      'a file or two, it is a refactor, a rename or a move, it touches something much of the',
      'codebase depends on, or the user mentions other work in flight. Pass `paths` with what you',
      'plan to change and you get the answer before the first edit; omit it to compare against what',
      'this workspace has already changed. Once per piece of work is enough — not every turn.',
      '',
      'You get paths only, never diffs. Each entry says whether you created that workspace, which',
      'is what decides whether you may act on it.'
    ].join(' '),
    inputSchema: {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Repository-relative paths you are about to change. Omit to compare against what this ' +
            'workspace has already changed.'
        )
    },
    annotations: { title: 'Check related work', readOnlyHint: true },
    // 지연 로딩(tool search) 뒤에 두지 않는다. 이 도구는 **모델이 부르려고 마음먹는 순간**이 곧
    // 실패 지점이다 — 겹침의 존재를 모르는 채로 편집을 시작하는 것이 정확히 이 도구가 막으려는
    // 상황인데, 그 상태의 모델에게는 검색해 볼 단어가 없다. 위임 도구에서 겪은 "존재를 모른다"
    // 와 같은 실패다(delegateToolSpecs). 이름을 이미 아는 사람만 찾아오는 도구는 소용이 없다.
    //
    // 상시 비용은 이 설명 하나(≈150 토큰)이고, 놓친 충돌 하나가 양쪽 diff 를 다 읽게 만드는
    // 비용보다 훨씬 싸다. 대신 설명은 "언제 부르는가" 부터 시작해 그 값을 하도록 쓴다.
    alwaysLoad: true
  },
  {
    name: 'list_workspace_peers',
    description: [
      'List the other Wooi workspaces open right now — across every repository, not just this',
      'one — with their branch, whether they are running, and whether a message would reach them',
      'immediately or wait for the user to approve it.',
      '',
      'This is where `send_to_workspace` gets its ids. Unlike `check_stacked_work`, which only sees',
      'workspaces stacked on this one, this sees every open workspace: siblings you have no',
      'relationship with, and work in other repositories.'
    ].join(' '),
    inputSchema: {},
    annotations: { title: 'List workspace peers', readOnlyHint: true }
  },
  {
    name: 'send_to_workspace',
    description: [
      'Send a short plain-text message to another open workspace — any of them, including ones in',
      'other repositories and ones you did not create.',
      '',
      'Use it when something you just learned changes what another workspace is working from: an',
      'interface you moved that its branch also calls, a decision the user made here that applies',
      'there too, a bug you already diagnosed that it is about to hit. Prefer it over telling the',
      'user to relay the message themselves.',
      '',
      'Only text crosses automatically. The other workspace cannot see this conversation or your',
      'diff, so write the message so it stands on its own — what changed, and what they should do',
      'differently. Point at commits and `path:line` rather than pasting code. For lengthy lists,',
      'designs, or dumps, write a file and send its absolute path instead; even across repositories,',
      'it can read files on the same machine when needed. Keep a sentence or two inline — an extra',
      'file read costs more.',
      '',
      'Delivery defaults to immediate for most workspaces, starting a paid turn as soon as it',
      'arrives, so send only when the recipient genuinely needs to know something. The',
      '**receiving** workspace still decides and may be set to `hold` or `refuse`. Call',
      '`list_workspace_peers` first to check `delivery`: `immediate`, `needs approval`, or `blocked`.',
      'Never block waiting for a reply; say what you sent and keep working.',
      '',
      'Use this rather than the built-in `SendMessage` tool for anything inside Wooi. Wooi',
      'workspaces are also Claude Code sessions, so they show up in `ListAgents` too, but reaching',
      'them that way requires a saved, explicit `accept`; Wooi’s default does not apply, so most',
      'will refuse the message. `SendMessage` is for sessions outside Wooi, such as the user’s own',
      'terminal.',
      '',
      'Handing over a whole new piece of work is `create_workspace`, not this.'
    ].join(' '),
    inputSchema: {
      // 이름이 `workspaceId` 가 아닌 것이 의도적이다. Codex 스레드는 한때 "wooi 도구에는 네
      // 워크스페이스 id 를 `workspaceId` 로 넘겨라" 라는 지침을 받았고, 그 문장이 대화 기록에
      // 남아 재개된 스레드가 대상 자리에 자기 id 를 적었다(실측). 지침은 무효를 선언해 고쳤지만,
      // 이름이 겹치지 않으면 애초에 그 규칙이 걸릴 자리가 없다.
      targetWorkspaceId: z
        .string()
        .describe(
          'Which workspace to message — an id from `list_workspace_peers`. This is the ' +
            'recipient, never yourself; Wooi already knows who is calling.'
        ),
      message: z
        .string()
        .describe(
          'What that workspace needs to know, written for an agent that cannot see this ' +
            'conversation and cannot ask you anything back.'
        )
    },
    annotations: { title: 'Message another workspace', readOnlyHint: false }
  },
  {
    name: 'list_issues',
    description: [
      'List open GitHub issues for this workspace’s repository, with number, title, author,',
      'labels, and URL. This tool only lists issues; it does not create a workspace.',
      'To start work on one, call `create_workspace` and include the issue details in its `task`',
      'so the new workspace can act without seeing this conversation.'
    ].join(' '),
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Maximum issues to return. Defaults to 30.')
    },
    annotations: { title: 'List open issues', readOnlyHint: true }
  },
  {
    name: 'list_repositories',
    description: [
      'List the repositories the user has added to Wooi — name, checkout path, default branch,',
      'and how many workspaces are open in each. The one this workspace lives in is marked',
      '`current`.',
      '',
      'This is where `create_workspace`’s `repo` values come from, so call it before starting work',
      'in another codebase: `list_workspace_peers` only reveals repositories that already have a',
      'workspace open, and a repository with no work in flight is exactly the one you would',
      'otherwise not know exists.',
      '',
      'It only lists them: nothing is opened, cloned or changed. Starting work in one of them is a',
      'separate `create_workspace` call that the user approves.'
    ].join(' '),
    inputSchema: {},
    annotations: { title: 'List repositories', readOnlyHint: true }
  },
  {
    name: 'create_workspace',
    description: [
      'Create a new Wooi workspace: a fresh git worktree on a new branch off the repository’s',
      'default branch, so its pull request stands on its own.',
      '',
      'Choose between this and `create_stacked_workspace` by dependency: if the next piece builds',
      'on the commits you just made, stack it; if it does not, use this. Stacking unrelated work',
      'makes its pull request wait for yours to merge, and blocks it whenever yours stalls.',
      '',
      'Uncommitted changes here do not matter — the new branch forks from the remote, not from',
      'this worktree. It starts with an empty conversation and does not steal the user’s screen,',
      'so tell the user it is ready and what it is for.',
      '',
      'It does not have to be this repository: `repo` puts the new workspace in any other',
      'repository the user has added to Wooi, which is how you hand over work that belongs in a',
      'different codebase instead of asking the user to go and start it themselves. Call',
      '`list_repositories` for the names you can pass.'
    ].join(' '),
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'Branch name for the new workspace, following the repository’s branch naming convention ' +
            '(e.g. "feat/inline-login"). Omit to let Wooi generate one.'
        ),
      repo: z
        .string()
        .optional()
        .describe(
          'Which repository to create it in, named exactly as `list_repositories` reports it. ' +
            'Omit for this workspace’s own repository, which is almost always what you want. ' +
            'Only repositories the user has already added to Wooi can be named; if two share a ' +
            'name, pass the full checkout path instead.'
        ),
      ...agentOptionParams('default'),
      task: z
        .string()
        .optional()
        .describe(
          'The task to hand the new workspace, sent as its first message — it starts working on ' +
            'this right away. Write it for an agent that cannot see this conversation and cannot ' +
            'ask you anything: what to build, and anything you already decided that it should not ' +
            'revisit.\n\n' +
            'Hand over what you already learned so it does not pay to rediscover it: the files and ' +
            'symbols involved (as `path:line` where you know them), the commands you ran and what ' +
            'they reported, and the approaches you ruled out and why. Write down only what you ' +
            'are sure of — a wrong path costs more than a missing one.\n\n' +
            'Omit this parameter entirely only if the user will drive that workspace themselves.\n\n' +
            'If `repo` sends it to a different repository, nothing you know about this one holds ' +
            'there — say which repository each path and command belongs to.'
        )
    },
    annotations: { title: 'Create a workspace', readOnlyHint: false }
  },
  {
    name: 'switch_to_agent_team',
    description: [
      'Turn this workspace from Solo into an agent team, so you can delegate work to subagents',
      'that run other agent products — Claude Code, Codex — as well as your own.',
      '',
      'Call this when the user explicitly asks for the work to be split across several agents:',
      'by product ("get Codex to review this", "run two Claude subagents") or by shape ("split',
      'this between agents and run them in parallel"). A workspace created as Solo has no',
      '`*_subagent` tools at all, and this tool is the only way to get them. There is no switch',
      'the user can flip to turn a Solo workspace into a team, so never answer by asking them to',
      'do it themselves — call this and let them approve it.',
      '',
      'The teammate tools arrive on your **next** turn, not this one: Wooi reopens the session the',
      'moment this turn ends and then continues on its own, carrying this conversation over. So',
      'finish the turn right after calling this — a line or two on what you are about to delegate',
      '— and do the delegating in the turn that starts by itself. Do not ask the user to reply',
      'first; nothing is waiting on them.',
      '',
      'This changes the workspace itself, not one task; it stays a team until the user switches it',
      'back from the header. Do not call it to reach for your own built-in subagents, which you',
      'already have: this is for running the other agent products.'
    ].join(' '),
    inputSchema: {
      reason: z
        .string()
        .describe(
          'One sentence on why this workspace needs teammates — what you plan to delegate, and ' +
            'to which agent. The user reads this on the approval card.'
        )
    },
    annotations: { title: 'Switch to an agent team', readOnlyHint: false }
  },
  {
    name: 'archive_workspace',
    description: [
      'Archive a workspace you created from here, once its work is finished or abandoned, so it',
      'stops cluttering the sidebar. Its worktree is removed; the branch, the pull request and the',
      'conversation stay, so the user can restore it.',
      '',
      'This works on workspaces you created with `create_workspace` or `create_stacked_workspace`,',
      'stacked or not. You cannot archive the workspace you are running in, or one the user made.',
      'The target must have no uncommitted changes — those would be lost — and no turn in flight.'
    ].join(' '),
    inputSchema: {
      workspaceId: z
        .string()
        .describe(
          'The workspace to archive, as returned when you created it, or listed by ' +
            '`check_stacked_work` / `check_related_work`.'
        )
    },
    annotations: { title: 'Archive a workspace', readOnlyHint: false }
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
