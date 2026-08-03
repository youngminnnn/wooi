# Wooi

**Run AI coding agents in parallel — and stack them when work builds on work.**

**English** · [한국어](./README.ko.md)

![Wooi demo](docs/demo.svg)

Wooi is a macOS desktop app for orchestrating multiple **AI coding agents** in
parallel, each on its own isolated git worktree. Each task runs in its own dedicated
worktree + branch + agent session, and every session starts with **an empty input box
and no automatic prompt** — nothing runs until you send your first message.

> **Agent support** — Since v1.4.0, Wooi supports both **Claude Code** (via the
> Claude Agent SDK) and **OpenAI Codex** (via the Codex CLI). Choose an agent when
> creating a workspace; that workspace keeps the selected agent for its lifetime.

## Why Wooi

- 🧱 **The stack is made of agents** — stack one agent's workspace on another's branch.
  When the parent merges, Wooi rebases the children and retargets their PR bases, so the
  rest of the stack stays valid.
- 🔍 **PR review, on the diff** — every agent reviews PRs now; the part that's missing is
  somewhere to work the result. Findings land inline on the diff they're about, each one
  editable, discardable, and postable on its own or as a batch.
- 🧵 **True parallelism** — kick off a refactor, a feature, and a bugfix at the same
  time, and watch all three from one sidebar.
- 🔒 **Isolated by default** — a separate worktree + branch per task means agents never
  collide in a shared working tree.
- 🚢 **PR-native** — jump straight from an agent's diff to a GitHub PR in one click.
- 🕵️ **No telemetry** — no servers of its own; transcripts stored locally only.

**[Download the latest release →](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg)**

## Installation

Wooi ships as a **signed and notarized** `.dmg` (Apple Developer ID), so it opens
without Gatekeeper warnings.

1. Download the
   [latest `.dmg`](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg)
   and drag **Wooi** into **Applications**. Older builds live on the
   [Releases page](https://github.com/youngminnnn/wooi/releases).
2. Open **Wooi** from Applications.

## Updating

Wooi updates itself: it checks GitHub Releases on launch, downloads new versions
in the background, and shows a **"Restart to update"** banner when ready. You can
also check manually in **Settings → About**.

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

### Workspaces

- **No default prompt** — the input box starts empty; the session begins only when you
  send your first message.
- **Automatic creation** — workspaces get an auto-generated name (like
  `witty-otter`) and branch off the repo's default branch. Turn on **manual setup** in
  Settings to choose the name and base branch yourself. Rename a workspace by
  double-clicking its name in the header.
- **Choose Claude Code or Codex** when creating a workspace. Agent-specific models,
  reasoning levels, permission modes, commands, and account usage are shown
  automatically. The selected agent cannot be changed after creation.
- **Per-workspace model & reasoning effort** — set from the status line above the input
  box, or by typing `/model` and `/effort`. When unset they follow the global settings;
  changing them resumes the same conversation. Available models and effort levels
  depend on the selected agent and model.
- **Sessions resume across restarts** — your conversation context is restored, so the
  next message after a restart continues where you left off.

### Stacked PRs

Not every task is independent — sometimes step 2 has to build on step 1. Wooi manages
those chains itself with plain `git` and `gh` — no extra stacking CLI needed.

- **Stack a workspace** — pick **Stack a new workspace** from a workspace's menu. The new
  workspace branches off that workspace's branch, and its PR targets that branch instead
  of the repo's default branch.
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
- **Curate before you post** — **Edit** reworks the wording inline, **Discard** drops the
  ones you don't want, **Comment** posts that finding on its own. Or tick the ones you want
  and post the batch; each goes out as its own review comment, and posted cards go quiet
  with a link to the comment on GitHub.
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

### Permissions

- **Cycle permission modes with Shift+Tab.** Claude Code offers default, accept edits,
  plan, and auto; Codex offers read only, auto, full access, and plan. The current mode
  is shown below the input box.
- Permission prompts offer **"Always allow"** (auto-approve that tool for the rest of
  the session) alongside Allow/Deny — Enter = Allow, Esc = Deny.

### Parallel-session visibility

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
- **Terminal** — a per-workspace login-shell terminal that survives workspace switches,
  so running commands and shell state are preserved when you return.

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
- **Shortcuts** — ↑/↓ to recall previous messages, ⌘1–9 and ⌘[ ⌘] to switch workspaces.

### Convenience

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

Requires **Node.js 20** (see [`.nvmrc`](./.nvmrc)) on **macOS (Apple Silicon)**.

```bash
git clone https://github.com/youngminnnn/wooi.git
cd wooi
nvm use          # optional, selects Node 20
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
