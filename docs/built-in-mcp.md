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

The 14 core tools are available in every workspace. `claude_subagent` and
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
- Read-only tools run without an approval prompt. State-changing tools follow the
  workspace's permission mode and normally show an approval card before running. Full
  Access runs them without approval.
- Claude's in-process server knows the caller from the session. The Codex transport
  learns it from the environment Wooi gives the tool server for that thread, so the model
  never states which workspace it is and cannot claim another one. Wooi still rejects a
  caller that is not currently running a turn. No transport argument is added to any tool
  schema, so a `workspaceId` argument always means the workspace the tool acts on.
- Tool failures are returned to the agent as readable MCP errors so it can correct the
  request and retry.

## Workspace tools

### `create_workspace`

Creates an independent workspace from the repository's default branch.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Branch name. If omitted, Wooi generates one. |
| `task` | string | No | First message for the new workspace. Providing it starts a turn immediately. |

The new workspace does not have a stack parent, does not report back to the caller, and
does not appear in `check_stacked_work`. Uncommitted changes in the caller do not affect
creation because the new branch starts from the remote default branch.

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

Reports do not automatically enter the parent's agent context. Call this tool when a
child's result affects the next action or before using `notify_child`.

### `report_to_parent`

Records a result for the workspace this one was stacked on.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `summary` | string | Yes | Self-contained description of completed work, decisions, or the blocker. |
| `status` | `done` \| `blocked` | No | Defaults to `done`. |

The report does not interrupt or start a turn in the parent. A later report replaces the
earlier one. Independent workspaces have no parent and cannot use this tool successfully.

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
agent. Declining a held message discards it; the sender is not told.

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

The result says whether the message was delivered or held. A held message may never
arrive, so an agent should never block waiting for a reply.

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

## Implementation map

The tool catalog and schemas live in `src/main/agent/tools/catalog.ts`; handlers are
registered in `src/main/agent/tools/index.ts`. Claude uses the in-process adapter in
`src/main/claude/wooiMcp.ts`, while Codex uses the stdio adapter in
`src/main/codex/toolShim.ts`. Both transports forward execution to the same registry and
handlers under `src/main/agent/tools/`.
