# Built-in MCP Server

**English** · [한국어](./built-in-mcp.ko.md)

Wooi gives every coding-agent session a built-in MCP server named `wooi`. Its tools let
an agent coordinate workspaces, stacked pull requests, repository scripts, GitHub
issues, and optional subagents without leaving the conversation.

There is nothing to install or configure. Wooi attaches the server to Claude Code and
Codex sessions that it starts. This is an app-internal server, not a remote endpoint for
other MCP clients.

## Tool naming and availability

Tools normally appear to the agent as `mcp__wooi__<tool-name>`. Most tool definitions
are loaded on demand, so a tool may not be visible in the model's initial context even
though it is available through tool search.

The 21 core tools are available in every workspace. `claude_subagent` and
`codex_subagent` are added only when multi-agent mode is enabled and the corresponding
backend is available for delegation.

## Safety model

- Most tools act on the workspace that made the call. An agent cannot substitute a
  different caller workspace.
- Tools that accept a target `workspaceId` can target only a workspace created by the
  calling workspace. `archive_workspace` cannot archive its caller, and
  `notify_child` is further limited to a direct stacked child.
- `send_to_workspace` is the exception, and it moves the boundary instead of removing it:
  any open workspace can be addressed, in any repository, but the **receiving** workspace
  decides whether the message is delivered. See [Peer messages](#peer-messages).
- `create_workspace` is the one tool that creates something outside the caller's
  repository. Its `repo` input can only name a repository the user has already added to
  Wooi, and the approval card says which one it is.
- Read-only tools run without an approval prompt. State-changing tools follow the
  workspace's permission mode and normally show an approval card before running. Full
  Access runs them without approval.
- `set_workspace_name` is the one state-changing tool that never shows a card. It is not
  marked read-only — it does change state — but the change is one string in Wooi's own
  store: it never leaves the machine, one context-menu click undoes it, and the result
  appears in the sidebar immediately, so you see it happen rather than approving it in
  advance.
- Claude's in-process server knows the caller from the session. The Codex transport
  learns it from the environment Wooi gives the tool server for that thread, so the model
  never states which workspace it is and cannot claim another one. Wooi still rejects a
  caller that is not currently running a turn. No transport argument is added to any tool
  schema, so a `workspaceId` argument always means the workspace the tool acts on.
- Tool failures are returned to the agent as readable MCP errors so it can correct the
  request and retry.

## Workspace tools

### `create_workspace`

Creates an independent workspace from the repository's default branch, or from an
existing pull request's head branch.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Branch name. If omitted, Wooi generates one. Ignored when `pullRequestNumber` is set, because the branch comes from the pull request. |
| `pullRequestNumber` | integer | No | Open the workspace on this pull request's head branch instead of a new branch. Cannot be combined with a stack parent. |
| `repo` | string | No | Repository to create it in, by the name Wooi shows in the sidebar, or by its full checkout path. If omitted, the caller's own repository. |
| `task` | string | No | First message for the new workspace. Providing it starts a turn immediately. |

The new workspace does not have a stack parent, does not report back to the caller, and
does not appear in `check_stacked_work`. Uncommitted changes in the caller do not affect
creation because the new branch starts from the remote default branch.

`repo` is the one place a tool reaches outside the caller's repository to create
something. Names come from `list_repositories`. Only repositories the user has added to
Wooi can be named; an unknown name is rejected with the registered names listed, and an
ambiguous one (two repositories sharing a folder name) is rejected with their paths. The
branch forks from that repository's own default branch, the approval card names it, and
the handoff message tells the new workspace which repository it is in so it does not
trust paths from the caller's.

`pullRequestNumber` checks out the pull request's head branch so commits made there
update that pull request. The base comes from the pull request, not from the caller — a
workspace cannot be stacked on a parent and checked out at a pull request head at the
same time, and that combination is rejected. If a workspace for that pull request already
exists the tool returns it instead of creating a second one on the same branch. Pull
requests from a fork are only accepted when Wooi can push to the fork.

### `list_repositories`

Lists the repositories the user has added to Wooi. Takes no input and runs without an
approval prompt.

| Field | Description |
| --- | --- |
| `name` | What to pass as `create_workspace`'s `repo`. |
| `path` | Checkout path, and the disambiguator when two repositories share a name. |
| `defaultBranch` | The branch a new workspace there would fork from. |
| `current` | Present only on the repository this workspace lives in. |
| `openWorkspaces` | How many non-archived workspaces exist in it. |
| `ambiguousName` | Present only when another repository shares the name, so `path` must be used. |

This is the only way an agent learns about a repository that has no workspace open —
`list_workspace_peers` reports the repository of open workspaces only. Listing changes
nothing; starting work in one of them is a separate `create_workspace` call that shows an
approval card.

### `create_stacked_workspace`

Creates a direct child workspace from the committed tip of the current branch. The
child's pull request will target the current branch.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Branch name. If omitted, Wooi generates one. |
| `task` | string | No | Complete handoff sent as the child's first message. Providing it starts a turn immediately. |

The current worktree must be clean. Commit changes before calling this tool; otherwise
the child could not reliably start from the work just completed.

### `archive_workspace`

Archives a workspace created by the caller and removes its worktree.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `workspaceId` | string | Yes | ID returned at creation or by a workspace inspection tool. |

The target must be idle and have no uncommitted changes. Its branch, pull request, and
conversation are retained, so the user can restore it from the sidebar.

### `set_workspace_name`

Sets the name a workspace shows in the sidebar. It changes the display name only — the git
branch and the worktree directory keep the names they were created with.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | A short 2–6 word name. An empty string clears the agent-set name. |
| `workspaceId` | string | No | Omit for the calling workspace; otherwise a workspace the caller created. |

Unlike `archive_workspace`, the target may be running a turn: renaming interrupts nothing.

The name is stored separately from the one a user types in the sidebar rename box, and it
never overwrites it. Wooi resolves the displayed name as **user's name → pull request title →
agent's name → worktree name**, so a name set here fills the gap before a pull request exists.
If the user has already renamed the workspace by hand, the call still succeeds but the display
does not change, and the result says so.

Wooi also sets this name on its own: when you accept a plan in plan mode, it names the
workspace from the plan — but only if the workspace has no user-set name, no agent-set name
yet, and no pull request. So a workspace names itself the first time it settles what it is
for, and a second plan later does not rename it out from under you.

### `check_related_work`

Lists other open workspaces for the same repository, including parents, children, and
unrelated siblings. Results contain changed paths, never diffs, and calculate overlaps
with the caller's paths.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `paths` | string[] | No | Repository-relative paths planned for the change. If omitted, uses paths already changed by the caller. |

Each result identifies the relationship, running state, branch, and whether the caller
created that workspace. Results are capped at 20 workspaces and 50 paths per workspace;
overlapping workspaces are prioritized. A `note` states whether anything overlaps and, when
it does, directs the caller to tell the user before editing those paths.

This tool's definition is always loaded into the system prompt (`alwaysLoad`). Left behind
tool search like the others, it is only reachable by an agent that already suspects an
overlap — which is exactly the agent that does not need it.

## Stacked-workspace coordination

### `check_stacked_work`

Lists direct child workspaces, their branches, running and pull-request state, whether
the caller created them, and the latest report from each child. It takes no input and is
read-only.

Each child has a compact `state` describing its current activity:

| `state` | Meaning |
| --- | --- |
| `running` | The agent's turn is running. |
| `waiting-for-user-permission` | A tool is waiting at an approval card. |
| `rate-limited` | The agent stopped at an account usage limit. |
| `ended-with-error` | The last turn ended with an error. |
| `background-tasks-running` | The agent is idle, but background shells are still running. |
| `idle` | None of the states above apply. |

`stateNote` appears only when the state needs a short explanation, such as the pending tool,
usage-limit reset time, a possibly stale running turn, or the background-shell count.
`lastActiveAt` is the workspace's last turn activity as epoch milliseconds. A child stopped at an
approval card cannot continue or report back on its own.

Reports do not automatically enter the parent's agent context. Call this tool when a
child's result affects the next action or before using `notify_child`.

### `await_stacked_work`

Registers a non-blocking wait for direct children's reports, then returns immediately so
the current turn can end. Wooi starts a new turn when all or any selected children report,
when none of the remaining children can progress, or when the timeout expires. Waiting uses
no tokens; the wake-up includes the reports.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `workspaceIds` | string[] | No | Direct child IDs; omit to wait for every non-archived direct child. |
| `until` | `all-reported` \| `any-reported` | No | Defaults to `all-reported`. |
| `timeoutMinutes` | number | No | Defaults to 60; minimum 1, maximum 1440. |

The waiting banner shows the condition and deadline and lets the user stop waiting.

### `report_to_parent`

Records a result for the workspace this one was stacked on.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `summary` | string | Yes | Self-contained description of completed work, decisions, or the blocker. |
| `status` | `done` \| `blocked` | No | Defaults to `done`. |

The report does not interrupt or start a turn in the parent. A later report replaces the
earlier one. Independent workspaces have no parent and cannot use this tool successfully.

### `ask_for_decision`

Raises a decision for the user without blocking the workspace turn. The agent stops work that
depends on the answer, and the answer returns as a new user turn. The user can instead hand the
question to the parent workspace when one exists.

- `question` — the decision and what is at stake
- `options` — optional closed set of 2–4 choices
- `recommendation` — optional choice the agent would make on its own

### `notify_child`

Sends a message to a direct stacked child created by the caller.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `workspaceId` | string | Yes | Child ID from `check_stacked_work`. |
| `message` | string | Yes | Self-contained update explaining what changed and how the child should respond. |

Unlike a report, this starts a turn in the child. If the child is busy, the message is
queued after its current turn.

## Peer messages

Stacked coordination runs along one axis: a parent wakes its children, and children only
leave a note. Peer messages are the other axis — any open workspace can send a short
plain-text message to any other, including workspaces in a different repository and ones
it did not create.

Only text crosses. Conversation history, files, and diffs never do.

### Inbound policy

Because sending is open, the boundary sits on the receiving side. Each workspace has an
inbound policy, changed from its sidebar row menu:

| Policy | Behaviour |
| --- | --- |
| `hold` (default) | Wooi keeps the message and shows an approval banner. Nothing reaches the agent until you deliver it. |
| `accept` | The message is delivered immediately, starting a turn. |
| `refuse` | The message is rejected and the sender is told. |

The default is `hold` because delivering a message starts a paid turn in the receiving
workspace, and that cost should be approved by you rather than by another workspace's
agent. Declining a held message still does not wake or notify the sender, but the sender
can ask for that message's status later and learn that it was declined.

One exception: a workspace delivers immediately to a workspace **it created**, since you
already approved that relationship when you approved the creating tool call. `refuse`
overrides even that. `notify_child` follows the same rules.

Wooi drops an identical message repeated to the same target within a minute, and a
workspace holds at most 20 pending messages, discarding the oldest beyond that.

### `list_workspace_peers`

Lists every open workspace except the caller, across all repositories, with its branch,
repository, running state, and whether a message would arrive immediately or wait for
approval. It takes no input and is read-only. Results are capped at 30, with
same-repository workspaces first.

### `send_to_workspace`

Sends a plain-text message to another open workspace.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `targetWorkspaceId` | string | Yes | Recipient id from `list_workspace_peers`. Never your own — Wooi already knows who is calling. |
| `message` | string | Yes | Self-contained text: what changed and what the other workspace should do differently. |

Wooi wraps the message with its origin before delivering it, so the receiving agent reads
it as news from another workspace rather than as a new task from the user. The wrapper
also states that the message carries no authority: it cannot approve anything, and the
receiving agent should not change settings or project instructions because another
workspace asked it to.

The result says whether the message was delivered or held and carries a `messageId`. A
held message may never arrive, so an agent should never block waiting for a reply; it can
use that id to check later. A `refuse` policy throws immediately and produces no id.

### `check_message_status`

Reads outcomes for messages sent by the calling workspace. It never wakes another
workspace and takes an optional input:

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `messageId` | string | No | Id returned by `send_to_workspace` or `notify_child`. Omit it to list the 10 most recent retained messages. |

Recorded outcomes are `delivered`, `waiting-for-target-turn-to-end`,
`waiting-for-user-approval`, `returned-waiting-for-user-approval`,
`delivered-after-user-approval`, `declined-by-user`, `dropped-target-inbox-full`,
`dropped-target-workspace-gone`, and `not-delivered-duplicate`. Wooi keeps no message body in this ledger, only an 80-character
excerpt, and retains at most the latest 50 messages per workspace for 7 days.

An evicted id returns `unknown-expired`; a valid but unrecorded id returns
`unknown-no-such-message` (a malformed id uses the same status with a more specific note).
If Wooi restarted while a message was only in the in-memory turn-end buffer, it returns
`unknown-lost-when-wooi-restarted` because delivery can no longer be proven.

### Sessions outside Wooi

Claude Code 2.1.224+ lets sessions on one machine message each other directly, and a Wooi
workspace is such a session. Wooi configures that channel rather than leaving it to
defaults:

- Each workspace announces itself as `wooi/<repository>/<branch>`, so it is recognisable
  in `/list-agents` from your own terminal instead of showing a random worktree name.
- Inbound native messages follow the same workspace policy, collapsed to two values:
  `accept` stays `accept`, and both `hold` and `refuse` become `refuse`. Wooi cannot hold
  a message that arrives outside its own channel — the approval dialog belongs to the
  terminal UI, which an app-hosted session has no way to show — so wanting approval is
  read as not letting it through unapproved. This also closes the obvious bypass: a Wooi
  workspace is reachable by native `SendMessage` too, but a held workspace refuses there
  as well, so both routes converge on one policy.
- Messages leaving this machine require your approval (`isolatePeerMachines`), because
  cross-machine delivery travels through Anthropic's servers while same-machine delivery
  does not.
- A native message that does arrive is recorded in the conversation with its sender.
  Without that it would reach the model but appear nowhere, and the agent would look like
  it changed course for no reason.

Agents should use `send_to_workspace` for other Wooi workspaces and the built-in
`SendMessage` only for sessions outside the app. Codex workspaces have no native
equivalent, which is why the Wooi tools exist for both backends.

## Pull requests and GitHub issues

### `open_pull_request`

Opens a pull request for the current branch and pushes the branch first when necessary.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | Yes | Pull-request title. |
| `body` | string | Yes | Markdown pull-request description. |
| `draft` | boolean | No | Whether to create a draft. Defaults to `false`. |

Wooi chooses the base automatically: the parent branch for a stacked workspace, or the
repository's default branch otherwise. The branch must contain at least one commit not
already in the base. If an open pull request already exists, the tool returns it instead
of creating another.

### `list_issues`

Lists open GitHub issues for the current repository with their number, title, author,
labels, and URL. It is read-only and does not create a workspace.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | No | Maximum number of issues. Defaults to 30; maximum 100. |

Starting work on an issue is a separate `create_workspace` call whose `task` should
include all issue details the new agent needs.

### `list_pull_requests`

Lists open GitHub pull requests for the current repository with their number, title,
head and base branches, author, URL, and whether a workspace can be created from each
one. It is read-only and does not create a workspace.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | No | Maximum number of pull requests. Defaults to 30; maximum 100. |

A pull request whose head lives in a fork Wooi cannot push to is listed with the reason,
rather than being hidden — a tool that silently omits it leaves the agent unable to tell
"no such pull request" from "no permission". Starting work on one is a separate
`create_workspace` call with `pullRequestNumber`.

## Repository scripts

Script names come from the repository settings. The reserved name `setup` addresses the
setup script. Invalid names return the available choices.

### `run_script`

Starts a configured script in the background, or restarts it if it is already running.
The process outlives the agent turn and writes to the same script panel the user sees.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Configured script name or `setup`. |

### `stop_script`

Stops a configured script if it is running.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Configured script name or `setup`. |

### `read_script_output`

Returns the most recent output together with running state and exit code. It is
read-only.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Configured script name or `setup`. |
| `tailLines` | integer | No | Trailing lines to return. Defaults to 200; maximum 500. |

Output keeps the end of the log, is limited to approximately 8 KiB, and reports whether
it was truncated.

## Agent team mode

### `switch_to_agent_team`

Turns a Solo workspace into an agent team, which is what makes the subagent tools below
exist. Use it when the user explicitly asks for the work to be split across agents in a
workspace that was created Solo.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | string | Yes | One sentence on what the agent plans to delegate and to which agent. Shown on the approval card. |

The switch is one-way: there is no tool that returns a workspace to Solo, because that
takes away a capability nobody asked to lose. The user can switch back from the
conversation header.

Subagent tools are bound to a session when that session opens, so they do not appear in
the turn that made the call. Wooi reopens the session the moment that turn ends, resumes
the same conversation and continues it on its own, so the tools are available from the
turn right after. The user does not have to send anything for that to happen: they asked
for the work in the message that led here, and the continuation is that work. The tool
result says so; an agent that calls it should end its turn and delegate in the next one.

Calling it in a workspace that is already a team changes nothing and does not reopen the
session. The call fails when the workspace's main agent cannot coordinate a team, because
the switch would produce a team with no usable teammates.

## Optional subagent tools

When multi-agent mode enables delegation, Wooi exposes one tool per available backend:

- `claude_subagent`
- `codex_subagent`

Each starts a subagent in the same worktree, waits for one final text result, and uses
the parent workspace's permission mode. The subagent begins with empty conversational
context and cannot ask questions mid-run.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | string | Yes | Short 3–6 word label shown while the task runs. |
| `prompt` | string | Yes | Complete, self-contained task brief including files, constraints, and expected result. |

Claude can launch several Wooi subagent tool calls concurrently. Codex currently
serializes MCP tool calls, so multiple delegated runs complete one after another.

## Slash commands

Every tool also has a slash command, so you can trigger it yourself instead of waiting for the
agent to decide to call it. Commands are namespaced with the plugin name, so they never collide
with your own commands: `/wooi:pr`, `/wooi:children`, and so on. The catalog is
`src/shared/wooiCommands.ts`.

| Command | Tool | How it runs |
| --- | --- | --- |
| `/wooi:pr [extra instructions]` | `open_pull_request` | agent |
| `/wooi:new <what it should do>` | `create_workspace` | agent |
| `/wooi:stack <what it should do>` | `create_stacked_workspace` | agent |
| `/wooi:report [what to report]` | `report_to_parent` | agent |
| `/wooi:ask [what to ask about]` | `ask_for_decision` | agent |
| `/wooi:notify <what changed>` | `notify_child` | agent |
| `/wooi:send <what changed>` | `send_to_workspace` | agent |
| `/wooi:message-status [message id]` | `check_message_status` | direct |
| `/wooi:team [what to delegate]` | `switch_to_agent_team` | agent |
| `/wooi:repos` | `list_repositories` | direct |
| `/wooi:peers` | `list_workspace_peers` | direct |
| `/wooi:children` | `check_stacked_work` | direct |
| `/wooi:await [workspace ids…]` | `await_stacked_work` | direct |
| `/wooi:related [paths…]` | `check_related_work` | direct |
| `/wooi:issues [limit]` | `list_issues` | direct |
| `/wooi:pulls [limit]` | `list_pull_requests` | direct |
| `/wooi:run <name>` | `run_script` | direct |
| `/wooi:stop <name>` | `stop_script` | direct |
| `/wooi:logs <name> [lines]` | `read_script_output` | direct |
| `/wooi:archive <workspace id>` | `archive_workspace` | direct |
| `/wooi:rename [name]` | `set_workspace_name` | direct |

In a team-mode workspace, one more command per agent backend appears — `/wooi:claude` and
`/wooi:codex` — matching the `claude_subagent` and `codex_subagent` tools. They take
`<what it should do>` and hand it to the agent, which writes the full brief. They are absent
outside team mode, because the underlying tools are.

**Direct** commands run the tool in the main process and show the result in a card. They cost no
turn and no tokens, and they do not show an approval card — you named the tool yourself, so there
is nothing to confirm. Only the commands in the table above can run this way, and their arguments
go through a parser before reaching the tool.

**Agent** commands hand the request to the agent, because their arguments are prose that has to be
written from the conversation: a pull-request body, a handoff brief, a report. The command expands
into a prompt that tells the agent which tool to call.

### How each backend gets them

Wooi generates a Claude Code plugin from the catalog at startup and writes it under `userData`
(`src/main/agent/plugin.ts`). The plugin is passed to sessions with `skipMcpDiscovery`, since Wooi
already provides the `wooi` MCP server in-process. Claude Code then supplies both the autocomplete
entries and the prompt expansion, so nothing about the command list is hardcoded.

Two variants are generated — with and without the delegate commands — and a session is given the
one that matches its mode. They cannot be merged into one plugin: a plugin's name is also its
command prefix, so both must be named `wooi`, and a session can load only one of them.

Codex reads the same plugin format, but its slash-command handling lives in its TUI rather than in
the app-server protocol that Wooi drives, and there is no RPC to list or expand commands. So for
Codex, Wooi supplies the autocomplete entries and expands the prompt itself
(`src/main/codex/manager.ts`). Direct commands are intercepted in the composer and behave
identically on both backends.

## Implementation map

The tool catalog and schemas live in `src/main/agent/tools/catalog.ts`; handlers are
registered in `src/main/agent/tools/index.ts`. Claude uses the in-process adapter in
`src/main/claude/wooiMcp.ts`, while Codex uses the stdio adapter in
`src/main/codex/toolShim.ts`. Both transports forward execution to the same registry and
handlers under `src/main/agent/tools/`. Slash commands live in
`src/shared/wooiCommands.ts`; the generated Claude plugin is written by
`src/main/agent/plugin.ts` and direct execution goes through the `command:wooiRun` IPC handler in
`src/main/ipc.ts`.
