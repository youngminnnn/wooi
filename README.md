# Wooi

**Run multiple AI coding agents at once — each in its own git worktree, each shipping its own PR.**

**English** · [한국어](./README.ko.md)

![Wooi demo](docs/demo.gif)

Wooi is a macOS desktop app for orchestrating multiple **AI coding agents** in
parallel, each on its own isolated git worktree. Each task runs in its own dedicated
worktree + branch + agent session, and every session starts with **an empty input box
and no automatic prompt** — nothing runs until you send your first message.

> **Agent support** — Wooi currently drives **Claude Code** (via the Claude
> Agent SDK). Support for more agents such as **Codex** is planned.

## Why Wooi

- 🧵 **True parallelism** — kick off a refactor, a feature, and a bugfix at the same
  time, and watch all three from one sidebar.
- 🔒 **Isolated by default** — a separate worktree + branch per task means agents never
  collide in a shared working tree.
- 🚢 **PR-native** — jump straight from an agent's diff to a GitHub PR in one click.
- 🕵️ **No telemetry** — no servers of its own; transcripts stored locally only.

**[Download the latest release →](https://github.com/youngminnnn/wooi/releases)**

## Installation

Wooi ships as a **signed and notarized** `.dmg` (Apple Developer ID), so it opens
without Gatekeeper warnings.

1. Download the latest `.dmg` from the
   [Releases page](https://github.com/youngminnnn/wooi/releases) and drag **Wooi**
   into **Applications**.
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
2. **Signing in** to Claude and GitHub. If a CLI isn't installed, an install link is
   shown. **Claude sign-in finishes in-app** through your browser, while **GitHub
   sign-in opens your Terminal**. The **GitHub CLI (`gh`) is required** — you can't
   finish onboarding (or use the app) until `gh` is installed and signed in. You can
   change connections anytime under **Settings → Integrations**.

Wooi **reuses the credentials of your installed Claude Code and `gh` CLIs** — no
separate API key is needed.

### Requirements

- macOS (Apple Silicon)
- [Claude Code](https://claude.com/claude-code) — required, and signed in.
- `git`
- `gh` (GitHub CLI) — **required**. Wooi uses it for branch/PR management, and a hard
  gate blocks the app until it's installed and signed in.

## Features

### Workspaces

- **No default prompt** — the input box starts empty; the session begins only when you
  send your first message.
- **Automatic creation** — workspaces get an auto-generated name (like
  `witty-otter`) and branch off the repo's default branch. Turn on **manual setup** in
  Settings to choose the name and base branch yourself. Rename a workspace by
  double-clicking its name in the header.
- **Per-workspace model & reasoning effort** — set from the status line above the input
  box, or by typing `/model` and `/effort`. When unset they follow the global settings;
  changing them resumes the same conversation. Effort ranges through to **ultracode**.
- **Sessions resume across restarts** — your conversation context is restored, so the
  next message after a restart continues where you left off.

### Permissions

- **Cycle permission modes with Shift+Tab** (same as Claude Code): default → accept
  edits → plan → auto. The current mode is shown below the input box.
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

- **Slash-command autocomplete** — type `/` to see the Claude Code commands/skills
  available in that worktree.
- **Inline shell commands** — start a message with `!` to run it as a shell command in
  the worktree, with the output shown right in the chat.
- **Image attachments** — paste or drop images into the input box to send them along.
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
- Prompts and code are sent to **Anthropic** through the Claude Agent SDK. When you use
  the PR features, metadata is sent to **GitHub** via the `gh` CLI.
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

[MIT](./LICENSE) © youngminnnn. You are free to use, modify, and redistribute the
software under the terms of the MIT License.
