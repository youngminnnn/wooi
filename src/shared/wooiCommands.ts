/**
 * Wooi 내장 MCP 도구를 슬래시 명령으로 직접 부르기 위한 **커맨드 카탈로그**.
 *
 * 도구 자체의 정의는 [[agent/tools/catalog]] 에 있다. 여기 있는 것은 그 도구에 사람이 손으로
 * 닿는 입구다 — 에이전트가 스스로 부를 때까지 기다리지 않고 사용자가 `/wooi:pr` 로 곧장 부른다.
 *
 * shared/ 에 두는 이유: 세 곳이 같은 목록을 봐야 한다. 메인은 플러그인 파일을 만들고 인자를
 * 실행하며(ipc.ts), Codex 매니저는 자동완성 목록과 로컬 확장에 쓰고(codex/manager.ts),
 * 렌더러는 즉시 실행 명령을 가로챈다(Composer.tsx). 셋으로 나누면 반드시 어긋난다.
 * agent/tools/catalog 와 달리 zod 를 쓰지 않으므로 렌더러 번들에 얹혀도 문자열 몇 개다.
 */

import { AGENT_BACKEND_LABELS, type AgentBackendId } from './types'

/**
 * 커맨드 앞에 붙는 이름공간. `/wooi:pr` 처럼 보인다.
 *
 * Claude 플러그인은 `.claude-plugin/plugin.json` 의 `name` 을 그대로 접두사로 쓴다 — 즉 이 값이
 * 플러그인 이름이자 접두사다. 접두사가 있어야 사용자가 이미 가진 `/pr` 같은 개인 명령과 겹치지
 * 않는다. 한번 정하면 사용자가 손에 익히므로 바꾸기 어렵다.
 */
export const WOOI_COMMAND_NAMESPACE = 'wooi'

/**
 * 커맨드가 도구에 닿는 방식.
 *
 * - `direct` — Wooi 가 입력창에서 가로채 메인에서 도구를 그대로 실행한다. 턴도 토큰도 쓰지 않고
 *   결과가 카드로 뜬다. 인자가 없거나 기계적으로 파싱되는 도구만 여기 둔다.
 * - `agent` — 에이전트에게 "이 도구를 불러라" 고 시킨다. 제목·본문·인계문 같은 **산문 인자**는
 *   대화 맥락을 읽어야 쓸 수 있고, 그건 모델만 할 수 있다.
 *
 * 하나로 통일하지 않는 이유: 전부 direct 로 하면 사용자가 PR 본문을 직접 타이핑해야 하고,
 * 전부 agent 로 하면 "자식 목록 좀 보여줘" 같은 조회에까지 턴 비용을 낸다.
 */
export type WooiCommandMode = 'direct' | 'agent'

export interface WooiCommandSpec {
  /** 접두사를 뺀 이름. `/wooi:<name>` 으로 보인다. */
  name: string
  /** 이 커맨드가 부르는 [[agent/tools/catalog]] 의 도구 이름. */
  tool: string
  mode: WooiCommandMode
  /** 자동완성과 플러그인 frontmatter 에 함께 실린다. */
  description: string
  /** 자동완성이 보여 주는 인자 힌트(예: `<name>`). 인자가 없으면 생략. */
  argumentHint?: string
  /**
   * `agent` 모드에서 에이전트에게 보낼 프롬프트. `$ARGUMENTS` 는 사용자가 커맨드 뒤에 적은
   * 나머지 텍스트로 치환된다(Claude 플러그인 커맨드와 같은 규약).
   *
   * `direct` 모드에도 둔다. 그 커맨드는 평소 렌더러가 가로채지만, 플러그인 파일은 그대로
   * 만들어져 있어 인터셉트가 빗나가도 에이전트가 같은 일을 한다 — 죽은 파일이 아니라 폴백이다.
   */
  prompt: string
}

/**
 * `direct` 커맨드가 받은 나머지 텍스트를 도구 인자로 바꾼 결과.
 * `error` 가 있으면 실행하지 않고 그 문장을 사용자에게 보여 준다(사용법 안내).
 */
export type WooiCommandArgs = { args: Record<string, unknown> } | { error: string }

/** 공백으로 끊어 빈 조각을 버린다. 경로·이름 목록 파싱의 공통 부분. */
function words(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean)
}

/**
 * 커맨드 목록. 도구마다 하나씩 대응한다(wooiCommands.test 가 그 대응을 강제한다).
 *
 * 이름을 도구 이름 그대로(`/wooi:check_stacked_work`) 쓰지 않는 이유는 순전히 손가락이다 —
 * 접두사가 이미 출처를 말해 주므로 뒤는 짧을수록 좋다. 대응은 `tool` 필드에 적혀 있고,
 * 생성된 플러그인 파일 본문에도 도구 이름이 그대로 나온다.
 */
export const WOOI_COMMANDS: WooiCommandSpec[] = [
  {
    name: 'pr',
    tool: 'open_pull_request',
    mode: 'agent',
    description: 'Open a pull request for this workspace',
    argumentHint: '[extra instructions]',
    prompt: [
      'Open a pull request for this workspace by calling the `mcp__wooi__open_pull_request` tool.',
      '',
      'Write the title and body yourself. Read this branch’s commits and diff first if you have',
      'not already — the body should say what changed and why, not restate the commit subjects.',
      'Do not use `gh pr create`: it cannot know that a stacked workspace targets its parent',
      'branch, and would silently open against the default branch.',
      '',
      'Extra instructions from the user (may be empty): $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'new',
    tool: 'create_workspace',
    mode: 'agent',
    description: 'Create an independent workspace off the default branch',
    argumentHint: '<what it should do>',
    prompt: [
      'Create an independent Wooi workspace by calling the `mcp__wooi__create_workspace` tool.',
      '',
      'Write its `task` for an agent that cannot see this conversation and cannot ask you',
      'anything: what to build, and everything you already learned that it would otherwise pay to',
      'rediscover — files and symbols as `path:line`, commands you ran and what they reported,',
      'approaches you ruled out and why. Write down only what you are sure of.',
      '',
      'If the user named an agent, a model, or a reasoning effort for it, pass those as',
      '`agentBackend`, `model` and `effort` — otherwise leave them out and let Wooi pick.',
      '',
      'If the user named another repository, pass it as `repo` and write the task for that',
      'codebase — nothing you know about this one holds there.',
      '',
      'What the new workspace should do: $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'stack',
    tool: 'create_stacked_workspace',
    mode: 'agent',
    description: 'Create a workspace stacked on this branch',
    argumentHint: '<what it should do>',
    prompt: [
      'Create a stacked Wooi workspace by calling the `mcp__wooi__create_stacked_workspace` tool,',
      'so its pull request targets this branch instead of the default branch.',
      '',
      'It forks from the committed tip of this branch, so commit your work first — the call fails',
      'while this worktree is dirty. Write its `task` for an agent that cannot see this',
      'conversation: what to build, why it is a separate pull request, and what you already',
      'decided that it should not revisit.',
      '',
      'It runs on this workspace’s agent unless the user asked for another one; if they named an',
      'agent, a model, or a reasoning effort, pass those as `agentBackend`, `model` and `effort`.',
      '',
      'What the stacked workspace should do: $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'report',
    tool: 'report_to_parent',
    mode: 'agent',
    description: 'Report back to the workspace this one was stacked on',
    argumentHint: '[what to report]',
    prompt: [
      'Report back to the parent workspace by calling the `mcp__wooi__report_to_parent` tool.',
      '',
      'Write the summary for an agent that never saw this conversation: what changed, what you',
      'decided and why, and anything it must know before building on this branch. Set `status` to',
      '"blocked" instead of "done" if the work needs a decision from the parent or the user.',
      '',
      'What the user wants reported (may be empty — then report the work done so far): $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'notify',
    tool: 'notify_child',
    mode: 'agent',
    description: 'Send a message to a workspace stacked on this one',
    argumentHint: '<what changed>',
    prompt: [
      'Message a workspace stacked on this one by calling the `mcp__wooi__notify_child` tool.',
      '',
      'Call `mcp__wooi__check_stacked_work` first — that is where the workspace ids come from, and',
      'it marks which children you may message. Write the message for an agent that cannot see',
      'this conversation: what changed here, and what it should do differently because of it.',
      'If more than one child should hear it, call the tool once per child.',
      '',
      'What they need to know: $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'send',
    tool: 'send_to_workspace',
    mode: 'agent',
    description: 'Send a message to another open workspace',
    argumentHint: '<what changed>',
    prompt: [
      'Message another open workspace by calling the `mcp__wooi__send_to_workspace` tool.',
      '',
      'Call `mcp__wooi__list_workspace_peers` first — that is where the ids come from, and it tells',
      'you which workspaces would receive the message right away rather than holding it for the',
      'user. Write the message for an agent that cannot see this conversation, your files, or your',
      'diff: what changed, and what they should do differently. Point at commits and `path:line`',
      'rather than pasting code. Do not block waiting for a reply.',
      '',
      'If the user did not say which workspace, pick the ones the message actually affects and say',
      'which you chose.',
      '',
      'What they need to know: $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'message-status',
    tool: 'check_message_status',
    mode: 'direct',
    description: 'Check what happened to a sent workspace message',
    argumentHint: '[message id]',
    prompt: [
      'Call `mcp__wooi__check_message_status` with the message id below when present; otherwise',
      'list the recent sent-message outcomes.',
      '',
      'Message id: $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'repos',
    tool: 'list_repositories',
    mode: 'direct',
    description: 'List the repositories a workspace can be created in',
    prompt:
      'Call `mcp__wooi__list_repositories` and list the repositories the user has added to Wooi.'
  },
  {
    name: 'peers',
    tool: 'list_workspace_peers',
    mode: 'direct',
    description: 'List every other open workspace, across all repositories',
    prompt:
      'Call `mcp__wooi__list_workspace_peers` and summarize what each open workspace is working on.'
  },
  {
    name: 'team',
    tool: 'switch_to_agent_team',
    mode: 'agent',
    description: 'Turn this workspace into an agent team',
    argumentHint: '[what you want to delegate]',
    prompt: [
      'Turn this workspace into an agent team by calling the `mcp__wooi__switch_to_agent_team` tool.',
      '',
      'The teammate tools arrive on your **next** turn, not this one — Wooi reopens the session the',
      'moment this turn ends and then continues on its own. So finish the turn right after calling',
      'it: say what you will delegate and to which agent. Do not ask the user to reply; the next',
      'turn starts by itself and that is where you delegate.',
      '',
      'Write `reason` as one sentence the user will read on the approval card. If they did not say',
      'what to delegate, base it on what this conversation is about.',
      '',
      'What they want to delegate (may be empty): $ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'children',
    tool: 'check_stacked_work',
    mode: 'direct',
    description: 'List workspaces stacked on this one and their latest reports',
    prompt:
      'Call `mcp__wooi__check_stacked_work` and summarize what each stacked workspace is doing.'
  },
  {
    name: 'related',
    tool: 'check_related_work',
    mode: 'direct',
    description: 'Check whether another workspace is changing the same files',
    argumentHint: '[paths…]',
    prompt: [
      'Call `mcp__wooi__check_related_work` and tell the user whether anything overlaps.',
      'Paths to check (may be empty — then compare against what this workspace already changed):',
      '$ARGUMENTS'
    ].join('\n')
  },
  {
    name: 'issues',
    tool: 'list_issues',
    mode: 'direct',
    description: 'List open GitHub issues for this repository',
    argumentHint: '[limit]',
    prompt: 'Call `mcp__wooi__list_issues` and list the open issues. Limit (optional): $ARGUMENTS'
  },
  {
    name: 'pulls',
    tool: 'list_pull_requests',
    mode: 'direct',
    description: 'List open GitHub pull requests for this repository',
    argumentHint: '[limit]',
    prompt:
      'Call `mcp__wooi__list_pull_requests` and list the open pull requests. Limit (optional): $ARGUMENTS'
  },
  {
    name: 'run',
    tool: 'run_script',
    mode: 'direct',
    description: 'Run a repository script by name',
    argumentHint: '<name>',
    prompt: 'Call `mcp__wooi__run_script` to run the script named: $ARGUMENTS'
  },
  {
    name: 'stop',
    tool: 'stop_script',
    mode: 'direct',
    description: 'Stop a running repository script',
    argumentHint: '<name>',
    prompt: 'Call `mcp__wooi__stop_script` to stop the script named: $ARGUMENTS'
  },
  {
    name: 'logs',
    tool: 'read_script_output',
    mode: 'direct',
    description: 'Read a repository script’s recent output',
    argumentHint: '<name> [lines]',
    prompt: 'Call `mcp__wooi__read_script_output` and show the output for: $ARGUMENTS'
  },
  {
    name: 'archive',
    tool: 'archive_workspace',
    mode: 'direct',
    description: 'Archive a workspace created from here',
    argumentHint: '<workspace id>',
    prompt: 'Call `mcp__wooi__archive_workspace` to archive the workspace with id: $ARGUMENTS'
  },
  {
    name: 'rename',
    tool: 'set_workspace_name',
    mode: 'direct',
    // 사용자가 친 문장이 곧 이름이라 모델이 읽을 맥락이 없다 — direct 가 맞는 자리다.
    // 인자 없이 부르면 지운다. 사이드바 rename 상자는 displayName 만 다루므로,
    // 에이전트가 붙인 이름을 되돌리는 입구는 여기뿐이다.
    description: 'Rename this workspace (no argument clears the agent-set name)',
    argumentHint: '[name]',
    prompt: 'Call `mcp__wooi__set_workspace_name` to name this workspace: $ARGUMENTS'
  },
  {
    name: 'await',
    tool: 'await_stacked_work',
    mode: 'direct',
    description: 'Wait without spending tokens for stacked workspace reports',
    argumentHint: '[workspace ids…]',
    prompt:
      'Call `mcp__wooi__await_stacked_work` to wait for these child workspace ids (omit the list to wait for all): $ARGUMENTS'
  }
]

/**
 * 위임 서브에이전트 커맨드. 백엔드마다 하나씩, **team 모드 워크스페이스에만** 있다.
 *
 * 목록이 상수가 아니라 함수인 이유는 [[agent/tools/catalog]] 의 delegateToolSpecs 와 같다 —
 * 쓸 수 없는 도구를 보여 주면 안 되고, 위임 도구는 team 모드에서만 존재한다. 그래서 이 커맨드도
 * 그때만 자동완성에 실리고, 플러그인도 그때만 위임 커맨드가 든 변형이 붙는다([[agent/plugin]]).
 *
 * `agent` 모드인 것은 선택이 아니다. 서브에이전트는 빈 맥락으로 시작해 이 대화를 볼 수 없으므로
 * 브리프에 필요한 사실을 전부 다시 적어야 하고, 그건 대화를 읽은 모델만 할 수 있다 — 사용자가
 * 친 한 줄을 그대로 프롬프트로 넘기면 맥락 없는 서브에이전트가 된다. 결과가 갈 곳이 있어야
 * 한다는 점도 같다: 도구 결과는 부른 에이전트에게 돌아가 다음 판단에 쓰인다.
 */
export function delegateWooiCommands(backends: AgentBackendId[]): WooiCommandSpec[] {
  return backends.map((backend) => {
    const label = AGENT_BACKEND_LABELS[backend] ?? backend
    return {
      // 도구 이름이 `claude_subagent` 인 것과 같은 이유로 백엔드 이름을 그대로 쓴다 — 어느
      // 제품으로 띄우는지가 이름만으로 읽혀야 한다.
      name: backend,
      tool: `${backend}_subagent`,
      mode: 'agent' as const,
      description: `Run a ${label} subagent in this workspace`,
      argumentHint: '<what it should do>',
      prompt: [
        `Start a ${label} subagent by calling the \`mcp__wooi__${backend}_subagent\` tool.`,
        `It really runs on ${label} — do not substitute your own built-in subagent mechanism,`,
        'which cannot run that product.',
        '',
        'Write the `prompt` as a complete brief. The subagent starts from an empty context, cannot',
        'see this conversation, and cannot ask you anything mid-run, so restate every fact it',
        'needs: the files and symbols involved as `path:line`, the commands to run, the constraints,',
        'and exactly what to return. Give `description` a 3-6 word label shown while it runs.',
        '',
        'Call the tool once per subagent. If the request implies several, say how many you started',
        'and what each one is doing.',
        '',
        'What it should do: $ARGUMENTS'
      ].join('\n')
    }
  })
}

/** 이 워크스페이스가 지금 쓸 수 있는 커맨드 전부. `agentToolsFor` 와 같은 모양이다. */
export function wooiCommandsFor(delegateBackends: AgentBackendId[] = []): WooiCommandSpec[] {
  return [...WOOI_COMMANDS, ...delegateWooiCommands(delegateBackends)]
}

/**
 * `direct` 커맨드의 나머지 텍스트를 도구 인자로 바꾼다.
 *
 * 파서를 스펙 안에 함수로 넣지 않고 여기 한 곳에 모은 이유: 스펙은 플러그인 파일 생성에도
 * 쓰이는 순수 데이터라 직렬화 가능한 채로 두는 편이 낫고, 파싱 규칙이 한눈에 보인다.
 * 위임 커맨드는 전부 `agent` 모드라 여기 오지 않는다.
 *
 * 인자가 틀렸을 때 던지지 않고 `error` 를 돌려주는 이유: 이건 사용자의 오타지 프로그래밍
 * 오류가 아니다. 사용법 한 줄을 보여 주고 입력창에 남겨 두면 이어서 고쳐 칠 수 있다.
 */
export function parseWooiCommandArgs(name: string, raw: string): WooiCommandArgs {
  const rest = raw.trim()
  switch (name) {
    case 'children':
    case 'peers':
    case 'repos':
      return { args: {} }

    case 'message-status':
      return { args: rest ? { messageId: rest } : {} }
    case 'await': {
      const workspaceIds = words(rest)
      return { args: workspaceIds.length ? { workspaceIds } : {} }
    }

    case 'related': {
      const paths = words(rest)
      return { args: paths.length ? { paths } : {} }
    }

    case 'issues':
    case 'pulls': {
      if (!rest) return { args: {} }
      const limit = Number(rest)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return {
          error: `Usage: /wooi:${name} [limit] — limit must be a whole number from 1 to 100.`
        }
      }
      return { args: { limit } }
    }

    case 'run':
    case 'stop': {
      if (!rest) return { error: `Usage: /${WOOI_COMMAND_NAMESPACE}:${name} <script name>` }
      return { args: { name: rest } }
    }

    case 'logs': {
      const parts = words(rest)
      if (!parts.length) {
        return { error: `Usage: /${WOOI_COMMAND_NAMESPACE}:logs <script name> [lines]` }
      }
      // 마지막 조각이 숫자면 줄 수로 읽는다 — 스크립트 이름에 공백이 있을 수 있으므로 앞은 합친다.
      const maybeLines = parts.length > 1 ? Number(parts[parts.length - 1]) : NaN
      if (Number.isInteger(maybeLines) && maybeLines > 0) {
        return { args: { name: parts.slice(0, -1).join(' '), tailLines: maybeLines } }
      }
      return { args: { name: parts.join(' ') } }
    }

    case 'archive': {
      if (!rest) {
        return {
          error:
            `Usage: /${WOOI_COMMAND_NAMESPACE}:archive <workspace id> — ` +
            `run /${WOOI_COMMAND_NAMESPACE}:children to see the ids.`
        }
      }
      return { args: { workspaceId: rest } }
    }

    // 빈 인자를 오류로 막지 않는다 — 여기서는 그것이 "에이전트가 붙인 이름을 지운다" 라는
    // 뜻이고(도구가 같은 규약을 쓴다), 지우는 다른 입구가 없다.
    case 'rename':
      return { args: { name: rest } }

    default:
      return { error: `Unknown Wooi command: /${WOOI_COMMAND_NAMESPACE}:${name}` }
  }
}

/**
 * `/wooi:pr 급하게` → `{ spec, rest: '급하게' }`. Wooi 커맨드가 아니면 null.
 *
 * `delegateBackends` 를 넘기지 않으면 위임 커맨드(`/wooi:claude` …)는 **매치되지 않는다**.
 * 기본값이 빈 배열인 것이 맞다: 이 함수를 부르는 두 곳의 필요가 다르다. 렌더러는 즉시 실행
 * 커맨드만 가로채면 되고 위임 커맨드는 전부 `agent` 모드라 평범한 메시지로 흘려보내야 한다.
 * 확장이 필요한 Codex 매니저만 자기가 계산한 목록을 넘긴다.
 */
export function matchWooiCommand(
  text: string,
  delegateBackends: AgentBackendId[] = []
): { spec: WooiCommandSpec; rest: string } | null {
  const m = new RegExp(`^/${WOOI_COMMAND_NAMESPACE}:([\\w-]+)(?:\\s+([\\s\\S]*))?$`).exec(
    text.trim()
  )
  if (!m) return null
  const spec = wooiCommandsFor(delegateBackends).find((c) => c.name === m[1])
  return spec ? { spec, rest: (m[2] ?? '').trim() } : null
}

/** `agent` 모드에서 실제로 보낼 프롬프트. `$ARGUMENTS` 를 사용자가 적은 나머지로 바꾼다. */
export function expandWooiCommand(spec: WooiCommandSpec, rest: string): string {
  return spec.prompt.replaceAll('$ARGUMENTS', rest)
}

/** 자동완성에 실을 이름(`wooi:pr`). 슬래시는 붙이지 않는다 — SlashCommandInfo 규약과 같다. */
export function wooiCommandName(spec: WooiCommandSpec): string {
  return `${WOOI_COMMAND_NAMESPACE}:${spec.name}`
}
