# Security Policy

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

If you discover a security vulnerability in Wooi, report it privately using
**[GitHub's private vulnerability reporting](https://github.com/youngminnnn/wooi/security/advisories/new)**
(Security → Advisories → *Report a vulnerability*).

If that is unavailable, email **youngmin3306@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- the Wooi version and your macOS version.

This is a single-maintainer project, so please allow a reasonable amount of time
for a response before any public disclosure. We aim to acknowledge reports within
a few days.

## Supported versions

Wooi is pre-1.0 and ships from `main`. Only the **latest release** receives
security fixes.

## Threat model & security posture

Wooi is a local macOS desktop app with no backend of its own. Understanding what
it does — and does not — do helps scope reports.

**What Wooi does**

- Runs **AI coding agents** (Claude Code, via the Claude Agent SDK) that can read
  and write files inside isolated git worktrees, and execute tools/commands.
- Executes **git** and **`gh`** commands, per-workspace **login-shell terminals**,
  and user-provided **Setup / Dev / Archive scripts**.
- Supports **inline shell commands** (messages starting with `!`) run in the
  worktree.

Because the app's core purpose is to run agents and shell commands on your behalf,
**arbitrary code execution within the worktree is expected behavior**, not a
vulnerability. Only run agents/scripts on repositories and prompts you trust.

**Electron hardening**

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, and
communicates with the main process only through a `contextBridge`-exposed API in
the preload script. Reports about the renderer gaining unintended Node/native
access, IPC handlers that can be abused to escape the worktree, or command
injection through unsanitized inputs are in scope.

**Data & privacy**

- Wooi collects **no analytics/telemetry** and has no servers of its own.
- Prompts and code are sent to **Anthropic** through the Claude Agent SDK; PR
  metadata is sent to **GitHub** via the `gh` CLI.
- Settings and transcripts are stored **locally only**
  (`~/Library/Application Support/Wooi/`).
- Wooi reuses the credentials of your installed Claude Code and `gh` CLIs.

See [`PRIVACY.md`](./PRIVACY.md) for details.

## In scope

- IPC / preload bridge weaknesses that let the renderer or remote content escape
  the intended sandbox.
- Command injection reachable from untrusted-but-normal input (repo metadata,
  branch names, file paths) rather than from a user deliberately running a shell
  command.
- Credential or transcript leakage beyond the documented local storage.

## Out of scope

- Arbitrary code execution that results from a user intentionally running an
  agent, script, or `!` shell command.
- Vulnerabilities in third-party CLIs (`git`, `gh`, Claude Code) or the models
  themselves — report those upstream.
- The unsigned/ad-hoc-signed macOS build warning ("손상됨" / "damaged"); code
  signing & notarization are planned for the 1.0 release.
