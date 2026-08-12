# Wooi

**Parallel agents are the easy part. Landing their work isn't.**

**English** · [한국어](./README.ko.md)

![Wooi demo](docs/demo.svg)

Wooi is a macOS desktop app for orchestrating multiple **AI coding agents** in
parallel, each on its own isolated git worktree. Each task runs in its own dedicated
worktree + branch + agent session, and every session starts with **an empty input box
and no automatic prompt** — nothing runs until you send your first message.

Running agents side by side is the *horizontal* axis, and isolated worktrees already
cover it. **Worktrees solve file collisions; they don't solve dependencies** — when task
B builds on task A's schema change, isolation is the thing in the way. Wooi adds the
*vertical* axis: dependent work branches off the work it depends on, and Wooi keeps the
whole chain valid as parents merge. Agents can build those chains themselves through
Wooi's built-in tools, and every review lands on the diff instead of in a transcript.

> **Agent support** — Since v1.4.0, Wooi supports both **Claude Code** (via the
> Claude Agent SDK) and **OpenAI Codex** (via the Codex CLI). Choose an agent when
> creating a workspace, then switch between them later with `/agent`. When a conversation
> is already under way, Wooi carries its context into the next message to the new agent.

## Why Wooi

- 🧱 **The whole stacked-PR lifecycle** — the whole app knows what a chain is, not
  just the branch you're standing on. Work that builds on other work branches off it
  instead of off the default branch. **Restack** rebases onto the latest parent and
  pushes with `--force-with-lease`; when a parent merges, a **merge cascade** retargets
  each child PR to the grandparent and rebases the children onto it; a PR that drifts
  onto the wrong base gets **flagged instead of silently accepted**. And if an agent
  builds a chain outside Wooi, the app reads GitHub's stack object first and falls back
  to reconstructing it from the PRs' base links. It can then **review every layer as one
  stack**, restack it, and keep the remainder valid as layers merge.
- 🤖 **Agents orchestrate the app, not just the repo** — every session gets a built-in
  MCP server. `check_related_work` shows which files the other workspaces are touching
  *before* an agent starts, `create_workspace` / `create_stacked_workspace` let it split
  a task into a chain of reviewable PRs, and `report_to_parent` / `notify_child` carry
  results and updates along that chain. An agent can also ask to turn a solo workspace
  into an **agent team**, or send a text message to another workspace under that
  workspace's receive policy. Files, diffs, and transcripts never cross that boundary.
  One prompt can end up as a three-PR stack you never arranged. See the
  [built-in MCP reference](docs/built-in-mcp.md).
- 🔍 **The diff and the stack are the review surface** — every agent can review a PR now; what's
  missing is somewhere to work the result. A Wooi review is its own entity with its own
  worktree, so the agent reads past the changed hunks without touching your checkout.
  Findings are **anchored to diff lines** with a severity badge, editable, discardable,
  and postable one at a time or as a batch. Files carry a **viewed** mark that
  auto-clears when a new commit changes that file, replies to your comments are polled so
  you can ask a follow-up, and verdicts are guarded — approve is hidden on your own PR,
  and a verdict is held back if the findings it rests on failed to post. A stacked review
  reads all layers in one session to find ordering, boundary, and cross-layer dependency
  problems; in an ordinary workspace, you can comment on a diff line and send that exact
  location back to the agent.
- 🎛️ **Two agent backends, integrated deeply** — Claude Code and OpenAI Codex, each
  supported down to the details rather than reduced to a lowest common denominator:
  `/rewind` and `/btw` where the backend has them, per-backend permission modes,
  reasoning effort and fast mode, account rate limits normalized into one readable
  status line, and your own MCP servers inherited from your CLI config. You can switch
  the main agent during a conversation, with Wooi carrying the existing context into the
  next message. See
  [agent backends](docs/agent-backends.md).
- 🔒 **Quiet where it counts** — **no telemetry** and no servers of its own; transcripts
  stay local. Updates can wait for **"restart when work finishes"** instead of killing a
  running turn. Ignored-but-needed files like `.env` are **carried into every new
  worktree**, and sessions resume across restarts.

Wondering how this lines up with other tools? See the
[comparison page](https://youngminnnn.github.io/wooi/alternatives.html), where every
claim is sourced and dated.

**[Download the latest release →](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg)**

## Installation

Wooi ships as a **signed and notarized** `.dmg` (Apple Developer ID), so it opens
without Gatekeeper warnings. Apple Silicon only.

### Homebrew

```sh
brew install --cask youngminnnn/tap/wooi
```

That's it — the cask installs **Wooi.app** into **Applications**. Open it from
there and follow the onboarding.

**Already installed Wooi from the `.dmg`?** Homebrew won't take over an app it
didn't put there, and stops with `It seems there is already an App at
'/Applications/Wooi.app'`. Add `--adopt` to hand the copy you already have over
to Homebrew instead of replacing it — any version works, and the app on disk is
left exactly as it is:

```sh
brew install --cask --adopt youngminnnn/tap/wooi
```

### Or download the `.dmg`

1. Download the
   [latest `.dmg`](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg)
   and drag **Wooi** into **Applications**. Older builds live on the
   [Releases page](https://github.com/youngminnnn/wooi/releases).
2. Open **Wooi** from Applications.

## Updating

Wooi updates itself: it checks GitHub Releases on launch, downloads new versions
in the background, and shows a **"Restart to update"** banner when ready. Restarting
mid-turn would cut an agent off, so the banner also offers **"Restart when work
finishes"** — Wooi then waits until every workspace is idle and restarts on its own. You
can also check manually in **Settings → About**.

> **On v1.0.0?** That build predates auto-update, so it won't update on its own —
> download **v1.0.1 (or later) once** from the Releases page. Every version from
> v1.0.1 onward updates automatically.

## Concept

- **Repository** — connect a git repo (its main checkout).
- **Workspace** — one task = one dedicated git worktree + branch + agent session,
  created under `~/wooi/workspaces/<repo>/<branch>`.
- Each workspace runs **independently and in parallel** — while an agent works in one
  workspace, you can open another and keep going.
- **Setup / Dev / Archive scripts** — configured per repo (`npm install`, `npm run dev`,
  etc.). Setup runs automatically when a workspace is created (optional), Dev is
  started/stopped from the script panel, and Archive runs once when a workspace is
  archived.

## Getting started

When you first launch Wooi, onboarding walks you through:

1. **Consent** to the Terms / Privacy Policy (required to continue).
2. **Connecting** Claude Code or Codex, plus GitHub. You only need one coding agent.
   If a CLI isn't installed, an install link is shown; Claude and Codex sign-in finish
   in-app through your browser. Codex supports either a ChatGPT account or an OpenAI
   API key. **GitHub is optional here —
   you can skip it** and start working right away. Wooi asks for it the first time you
   reach a feature that needs it (opening a PR, merging, stacking, CI checks), then
   resumes whatever you were doing once you're connected. You can change connections
   anytime under **Settings → Integrations**.

Wooi reuses the credentials of your installed Claude Code, Codex, and `gh` CLIs.
An API key is not required when you sign in with a Claude or ChatGPT account.

### Requirements

- macOS (Apple Silicon)
- At least one supported coding agent, installed and signed in:
  - [Claude Code](https://claude.com/claude-code)
  - [OpenAI Codex CLI](https://developers.openai.com/codex) v0.128.0 or newer
    (`npm i -g @openai/codex`)
- `git`
- `gh` (GitHub CLI) — **needed for the PR, review, and stacking features**: creating/
  merging/closing PRs, PR review, stacked branches, and the Check tab. Everything that's
  pure `git` — connecting repos, creating workspaces, running agents, diffs, terminal,
  scripts — works without it.

## Features

Ordered by what sets Wooi apart, not by what you click first.

### Stacked PRs

Not every task is independent — sometimes step 2 has to build on step 1. Wooi manages
those chains itself with plain `git` and `gh` — no extra stacking CLI needed.

- **Stack a workspace** — pick **Stack a new workspace** from a workspace's menu. The new
  workspace branches off that workspace's branch, and its PR targets that branch instead
  of the repo's default branch.
- **Or let the agent stack it** — `create_stacked_workspace` opens the next workspace on
  top of the current branch when the work just finished is a complete, reviewable unit.
  See [Agent orchestration](#agent-orchestration-built-in-mcp) below.
- **Stack overview** — a **Stack** button appears in the header whenever the current
  workspace is part of a chain. It lists every branch in the stack with its PR state
  (draft / review required / changes requested / ready to merge / conflict / merged), PR
  number, and ahead/behind counts. Click an entry to jump to it, or open a PR for a
  branch that doesn't have one yet.
- **Restack** — **Restack onto `<base>`** rebases a workspace onto the latest parent
  branch and pushes with `--force-with-lease`. A conflict stops in the worktree so you
  can resolve it there.
- **Merge cascade** — when a parent PR merges, Wooi retargets each child PR's base to the
  grandparent branch and rebases the children onto it, so the rest of the stack stays
  valid instead of turning into a pile of conflicts.
- **Detected, not just declared** — if an agent builds a chain on its own with
  `git checkout -b` and `gh pr create`, Wooi reconstructs the stack from the PRs' base
  links and shows it the same way.
- **GitHub stacks come in too** — Wooi reads GitHub's server-side stack object when it is
  available, preserving its explicit layer order, and falls back to the PR base chain.
  If the remote branch has moved away from the local expectation, synchronization stops
  instead of overwriting it.
- **Review the stack as a stack** — one review session reads every layer together and
  looks for ordering, boundary, granularity, churn, and cross-layer dependency problems
  that separate PR reviews cannot see. Findings stay attached to the layer they concern.
- **The default base is the parent, for everyone** — stacking a workspace records the
  parent as that branch's `gh-merge-base`, so a bare `gh pr create` — yours or an
  agent's — targets the parent branch instead of the repo's default branch. If a PR
  still ends up on the wrong base, Wooi says so and offers to retarget it rather than
  quietly accepting it and dropping the stack.

### Agent orchestration (built-in MCP)

Wooi attaches a built-in MCP server named `wooi` to every Claude Code and Codex session
it starts — nothing to install or configure. The agent doesn't just edit files in its
worktree; it can drive Wooi itself: split a task, open the workspaces for the pieces,
stack them in dependency order, and pass results along the chain.

- **See the neighbours first** — `check_related_work` lists the other workspaces open on
  this repo and the file paths each one is changing, flags the overlaps with what this
  agent plans to touch, and tells it to check with you before editing those paths. Paths
  only — **diffs are never shared between workspaces**.
- **Fan out or stack up** — `create_workspace` starts an independent workspace off the
  default branch; `create_stacked_workspace` starts a child off the committed tip of the
  current branch, so its PR targets the current branch. Either can be handed a first
  message that starts the new agent's turn immediately.
- **Talk along the chain** — `report_to_parent` records a result for the workspace this
  one was stacked on (it doesn't interrupt the parent), `check_stacked_work` lists the
  children with their branch, PR, and latest report, and `notify_child` sends an update
  that starts a turn in a child — queued behind its current turn if it's busy.
- **Talk across workspaces** — `list_workspace_peers` and `send_to_workspace` carry a
  short text message to another open workspace, even outside the current repo. The
  receiver decides whether to accept, hold for approval, or refuse it. Files, diffs, and
  transcripts do not travel with the message.
- **Grow into a team when the work calls for it** — an agent can request a switch from a
  solo workspace to an agent team. Once approved, Wooi carries the conversation over and
  automatically continues the task after the switch.
- **Plus the everyday ones** — `open_pull_request` (Wooi picks the base: the parent
  branch when stacked, the default branch otherwise), `list_issues`, `archive_workspace`,
  and `run_script` / `stop_script` / `read_script_output` for the repo scripts you
  configured.
- **Fenced in** — most tools act only on the calling workspace; tools that take a
  `workspaceId` can only name a workspace that the caller created, `archive_workspace`
  can't archive its caller, and `notify_child` is limited to a direct stacked child.
  Read-only tools run without a prompt; state-changing ones follow the workspace's
  permission mode and show an approval card.
- **Explicit when useful** — built-in tools are also available as `/wooi:*` slash
  commands, so you can deliberately invoke the same orchestration path from the composer.

Every tool, input, and constraint is documented in the
[built-in MCP reference](docs/built-in-mcp.md).

### PR review

Getting an agent to review a pull request is the easy part — every agent does that now.
The hard part is what comes back: a wall of prose in a chat log, detached from the code it
describes, that you then have to translate into actual review comments by hand.

Wooi makes the diff the workspace instead. And since the PR is usually someone else's, a
review isn't the next step after your own work — it gets its own row in the sidebar and
runs alongside your workspaces instead of taking one over.

- **A diff you review on, not a transcript you read** — three panes: the changed files with
  a count of findings on each, the full diff in the middle, and a findings/activity sidebar.
  The footer keeps a running `N inline · M general` tally.
- **Findings land on the lines they're about** — each one is anchored to its hunk and
  rendered as a card right there in the diff, with a severity badge and a markdown body.
  If an agent cites a line that isn't part of the diff, the card says so and shows where it
  got moved to, so you catch a misplaced comment before it goes out instead of after.
- **Review a stack as one unit** — select a stacked PR and one session reads all of its
  layers together. It separates stack-level findings from layer findings, anchors each
  inline comment to the correct PR, and submits verdicts per layer without losing track
  of partial success.
- **Send your own diff feedback back to the agent** — in a regular workspace, comment on
  a changed line and reply with that file and line attached. The agent gets the code
  location instead of a detached description of it.
- **Curate before you post** — **Edit** reworks the wording inline, **Discard** drops the
  ones you don't want, **Comment** posts that finding on its own. Or tick the ones you want
  and post the batch; each goes out as its own review comment, and posted cards go quiet
  with a link to the comment on GitHub.
- **Keep your place in a big diff** — tick a file as **viewed** and it collapses out of
  your way. The mark is stored against a fingerprint of that file's contents, so when a
  new commit changes the file it goes back to unviewed on its own — and files that didn't
  change stay checked.
- **Start a review** — **Review PR** on the Overview board. Pick a repo, choose one of its
  open PRs (or type a number / URL), and say what you want looked at.
- **Claude or Codex** — pick the agent when you start. A review stays on the agent it was
  started with, and follow-up turns resume that same session.
- **Its own worktree** — the PR head is checked out under
  `~/wooi/reviews/<repo>/pr-<number>-<id>`, a worktree dedicated to that review, so the
  agent can read code outside the changed hunks and grep the rest of the tree without
  touching the checkout you're working in.
- **Activity timeline** — replies to comments you posted and new commits on the PR are
  polled automatically and land in the timeline. Ask a follow-up and the review picks up
  from there.
- **Verdicts** — comment, approve, or request changes. If findings are still unposted, Wooi
  offers to send them along and posts them first; if any fail, the verdict is held back
  rather than going out unsupported. Approve / request changes are hidden on your own PR
  (GitHub rejects those), and repeating the same verdict on a PR that hasn't moved is
  blocked.
- **Persistent** — reviews survive restarts and can be archived, restored, or deleted;
  deleting cleans up the review worktree too.

### Agent backends

Wooi supports two coding agents — **Claude Code** (Claude Agent SDK) and **OpenAI Codex**
(Codex CLI) — and follows each one down to its own controls instead of flattening both
into a shared subset. The renderer reads what the selected backend can do, so a workspace
only ever shows controls that actually work there.

- **Backend-specific controls** — models, reasoning-effort levels, permission modes,
  slash commands, and account details all come from the selected backend.
- **Switch agents without throwing the conversation away** — use `/agent` even after
  work has started. Claude and Codex cannot resume each other's native session IDs, so
  Wooi builds a bounded handoff from the conversation and sends it with your next message
  to the new agent, showing the estimated handoff cost first.
- **Permission modes, cycled with Shift+Tab** — Claude Code offers default, accept edits,
  plan, and auto; Codex offers read only, auto, full access, and plan. The current mode
  is shown below the input box. Permission prompts offer **"Always allow"**
  (auto-approve that tool for the rest of the session) alongside Allow/Deny —
  Enter = Allow, Esc = Deny.
- **Capabilities that only one side has** — `/rewind` (roll code back to a file
  checkpoint) and `/btw` (ask a side question without derailing the turn) show up where
  the backend supports them, and mid-turn steering is used where it exists instead of
  being queued.
- **Fast mode & effort** — pick them per workspace from the status line or with `/model`,
  `/effort`, and `/fast`; options that the current model doesn't support are marked
  rather than silently ignored.
- **Rate limits, normalized** — account usage from either backend is shown in one status
  line, pinned to the window that actually paces you (Claude's 5-hour session window,
  Codex's weekly window) so the number doesn't swap out from under you.
- **Wait for the limit, then continue** — when a backend reports a known reset time, Wooi
  shows it and avoids retrying turns that cannot succeed before the limit clears.
- **Your MCP servers come along** — servers configured in your own Claude/Codex CLI setup
  are resolved and injected into the session alongside Wooi's own `wooi` server.

See [agent backends](docs/agent-backends.md) for the full capability matrix.

### Workspaces

- **No default prompt** — the input box starts empty; the session begins only when you
  send your first message.
- **Automatic creation** — workspaces get an auto-generated name (like
  `witty-otter`) and branch off the repo's default branch. Turn on **manual setup** in
  Settings to choose the name and base branch yourself. Rename a workspace by
  double-clicking its name in the header.
- **Choose Claude Code or Codex** when creating a workspace — and change your mind with
  `/agent` later as well. If work has already started, the next agent receives a bounded
  handoff of the conversation; stacked workspaces initially inherit their parent's agent.
- **Per-workspace model & reasoning effort** — set from the status line above the input
  box, or by typing `/model` and `/effort`. When unset they follow the global settings;
  changing them resumes the same conversation.
- **Sessions resume across restarts** — your conversation context is restored, so the
  next message after a restart continues where you left off.

### Parallel-session visibility

- **Fan out one prompt** to several independent workspaces, compare their responses and
  diffs side by side, then adopt one winner and archive the alternatives.
- The sidebar distinguishes **running** (spinner), **awaiting permission** (yellow
  shield), and **unread responses** (blue dot).
- When the window is inactive, completions / errors / permission requests appear as OS
  notifications and a Dock badge count.
- The **"Needs input" / "Next unread"** buttons above the input box jump straight to the
  session that needs you.
- An **Overview board** (shown when no workspace is selected) lists every active session
  with status filters (All / Running / Needs input / Unread / Idle) and a **Stop all**
  action; click any card to jump in.

### Work area

A tabbed panel on top plus an interactive terminal below (resizable split):

- **All files** — a file tree of the worktree with a read-only, syntax-highlighted
  viewer.
- **Changes** — a per-file diff against the base branch (same meaning as a PR diff),
  covering commits + staged + unstaged + untracked files. The header summary
  (`N changed · ↑ahead · ↓behind`) opens this as a modal. When there's no PR and the
  branch is ahead, a **Create PR** button opens GitHub's PR page in your browser.
- **Check** — CI check results for the PR on the current branch.
- **Preview** — open the workspace's dev server inside Wooi, capture the page or pick a
  specific element into the composer, and send collected console and network failures to
  the agent. The preview runs in a separate, permission-denied session.
- **Terminal** — per-workspace login-shell terminals with multiple tabs. They survive
  workspace switches, so running commands and shell state are preserved when you return.

### Composing messages

- **Slash-command autocomplete** — type `/` to see the commands available for the
  workspace's selected agent.
- **File mentions** — type `@` to fuzzy-search the worktree and pull a file into your
  message, so the agent gets its contents without hunting for it first. The menu shows
  each file's size and warns when a file is big enough that the agent may truncate or
  skip it. Directory mentions (`@src/`) attach a listing. In the **All files** viewer,
  **Mention** adds the open file — select lines first and it narrows to just that range
  (`@src/app.ts#L40-80`).
- **Inline shell commands** — start a message with `!` to run it as a shell command in
  the worktree, with the output shown right in the chat.
- **Drag & drop** — drop files anywhere on the window: images become attachments, everything
  else becomes an `@` mention. Files inside the worktree are shortened to a relative path.
- **Image attachments** — paste or drop images to send them along.
- **Status line** — branch · directory · model · effort · context usage are always
  shown above the input box; long conversations **auto-compact** (toggleable), or run
  `/compact` manually.
- **Draft preservation & message queueing** — an in-progress message survives workspace
  switches, and you can queue follow-up messages while a turn is running.
- **Shortcuts** — ↑/↓ to recall previous messages, ⌘1–9 and ⌘↑ ⌘↓ to switch workspaces, ⌘[ to go
  back to the one you were just in.

### Convenience

- **Carried files** — a new worktree only contains git-tracked files, so ignored ones
  (`.env`, `CLAUDE.local.md`, …) would be missing. List them per repo and Wooi brings
  them into every new workspace: **Copy** for files each workspace needs its own version
  of (like `.env` with a per-workspace `$PORT`), **Link** to share one original.
- **Updates that wait for you** — when a new version is ready you can install it now, or
  pick **Restart when work finishes** and Wooi holds the restart until every workspace is
  idle, then counts down before restarting.
- **Open in editor / Reveal in Finder** — header buttons open the worktree in VS Code
  (`code`, falling back to Finder) or reveal it in Finder.

> Note: the diff viewer is read-only — no staging, commit, or revert from within Wooi.

## Privacy / Data

- Wooi has no servers of its own and **collects no analytics/telemetry**.
- Prompts and code are sent to the provider for the agent you select: **Anthropic**
  through the Claude Agent SDK, or **OpenAI** through the Codex CLI. When you use the
  PR features, metadata is sent to **GitHub** via the `gh` CLI.
- Settings and conversation transcripts are stored **locally only**
  (`~/Library/Application Support/Wooi/`).
- See [`PRIVACY.md`](./PRIVACY.md) and [`TERMS.md`](./TERMS.md) for details.

## Build from source

Requires **Node.js 24** (see [`.nvmrc`](./.nvmrc)) on **macOS (Apple Silicon)**.

```bash
git clone https://github.com/youngminnnn/wooi.git
cd wooi
nvm use          # optional, selects Node 24
npm install      # installs deps + Electron binary
npm run dev      # launch in development mode
```

Other useful scripts:

```bash
npm run typecheck   # node + web TypeScript
npm run lint        # eslint
npm test            # vitest unit tests
npm run build       # production build
npm run dist        # package a macOS build into release/
```

## Contributing

Contributions are welcome! Please read **[CONTRIBUTING.md](./CONTRIBUTING.md)** for
the dev setup, branch/commit conventions, and PR process, and follow the
[Code of Conduct](./CODE_OF_CONDUCT.md). To report a security issue, see
[SECURITY.md](./SECURITY.md) — please don't file security bugs as public issues.

## License

[Apache 2.0](./LICENSE) © youngminnnn. You are free to use, modify, and
redistribute the software under the terms of the Apache License 2.0, which also
includes an express patent grant.

The "Wooi" name and logo are trademarks and are not covered by that license —
see [TRADEMARK.md](./TRADEMARK.md). Contributors sign a
[CLA](./CLA.md) before their first PR is merged.
