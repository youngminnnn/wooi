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

Only the **latest release** receives security fixes.

## Threat model & security posture

Wooi is a local macOS desktop app. Everything runs on your machine, with one
optional exception — remote access, which has its own section below.
Understanding what the app does — and does not — do helps scope reports.

**What Wooi does**

- Runs **AI coding agents** (Claude Code via the Claude Agent SDK, or Codex via
  the Codex CLI) that can read and write files inside isolated git worktrees,
  and execute tools/commands.
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

- Wooi collects **no analytics/telemetry**. It has no backend except the
  end-to-end encrypted relay used by remote access, which is off by default.
- Prompts and code are sent to the provider for the selected agent: **Anthropic**
  through the Claude Agent SDK, or **OpenAI** through the Codex CLI. PR metadata
  is sent to **GitHub** via the `gh` CLI.
- Settings and transcripts are stored **locally only**
  (`~/Library/Application Support/Wooi/`).
- Wooi reuses credentials managed by the installed Claude Code, Codex, and `gh` CLIs.

See [`PRIVACY.md`](./PRIVACY.md) for details.

## Remote access (optional, off by default)

Remote access lets a paired phone watch and control sessions through a relay the
maintainer operates. It is the app's only network-facing surface, so it gets its
own posture.

**What the design assumes**

- **The relay is untrusted.** It stores ciphertext and metadata only. Session
  keys are agreed between the two devices during pairing and never leave them,
  so a full compromise of the relay database should not reveal message content.
- **Row-level security, not UI checks.** Every table is gated by Postgres RLS on
  "is this machine yours, or a device paired to it". Revoking a device takes
  effect at that layer — the phone loses row access and Realtime channel
  authorization at the same moment, not after the app decides to hide something.
- **Default deny for commands.** The phone can invoke only an allowlist of
  channels. Everything that spawns a shell, opens a native dialog, or changes
  repositories is unreachable, and a test asserts those channels stay
  unreachable.
- **No privilege escalation.** The phone can lower a workspace's permission mode
  but never raise it, and "always allow" is limited to the current session.
- **Replay protection.** Commands carry a sequence number and timestamp; the
  laptop rejects replays and stale requests.
- **Pairing is confirmed by a human.** A QR code alone is not enough — both
  screens show six digits derived from the shared secret, and the key is only
  created after you confirm they match. A photograph of the QR does not grant
  access.

**In scope for reports**

- Reading another user's rows, or joining another machine's Realtime channel.
- Anything that lets the relay operator, or a passive observer, recover plaintext.
- Reaching a channel outside the remote allowlist, or escalating permission mode
  from the phone.
- Forging or replaying commands, or bypassing the pairing confirmation.

**Known and accepted**

- The relay sees metadata: identifiers, timing, sizes, and your phone's device
  name. [`PRIVACY.md`](./PRIVACY.md) enumerates it.
- A phone that is unlocked and in an attacker's hands can act as you. The
  biometric gate before approving permissions is the mitigation, not a guarantee.
  Revoke the device from the desktop.
- The relay operator can deny service (they run it). Confidentiality does not
  depend on them; availability does.

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
- Vulnerabilities in third-party CLIs (`git`, `gh`, Claude Code, Codex) or the models
  themselves — report those upstream.
- Gatekeeper behavior caused by modifying or repackaging the signed and notarized app.
