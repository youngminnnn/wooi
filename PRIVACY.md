<!--
  DRAFT — 이 문서는 기술적 사실에 기반한 초안이며 법적 자문이 아니다.
  배포 전 관할·책임 조항 등은 법무 검토를 거쳐야 한다.
-->

# Privacy Policy

_Last updated: 2026-06-06 · Version 1_

Ditto is a local macOS desktop application that orchestrates parallel AI coding
agents — currently [Claude Code](https://claude.com/claude-code) — over isolated
git worktrees. This policy explains what data the app handles and where it goes.

## Summary

Ditto has **no servers of its own**. It does not collect analytics or telemetry,
and it does not transmit your data to the developer. Your code and conversations
leave your machine only when sent to the third‑party services you connect
(Anthropic and, optionally, GitHub) to make the app function.

## What data is processed, and where it goes

- **Prompts, code, and file contents** — When you send a message or an agent reads
  or edits files, that content is sent to **Anthropic** through the Claude Agent
  SDK (the bundled Claude Code CLI) to be processed by Claude. This is governed by
  [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy) and the
  terms of your Claude account.
- **Repository metadata and pull requests** — If you use the GitHub features,
  Ditto invokes the GitHub CLI (`gh`) on your machine, which communicates with
  **GitHub** under [GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- **Authentication** — Ditto reuses the credentials of your already‑installed
  Claude Code and GitHub CLI. It does **not** store, copy, or transmit your
  access tokens itself; sign‑in flows run in your Terminal.

## What is stored locally

The following are stored only on your machine, under the app's user‑data
directory (`~/Library/Application Support/Ditto/`):

- App settings (connected repositories, workspaces, preferences) — `ditto.json`
- Conversation transcripts — `transcripts/*.jsonl`
- Diagnostic logs (errors and CLI detection) — `logs/main.log`

Git worktrees for your workspaces are created under `~/ditto/workspaces/`, outside
the user‑data directory so you can browse them directly.

These files are not uploaded anywhere by Ditto. You can delete a workspace from
within the app, or remove the user‑data and `~/ditto/workspaces/` directories to
erase all local data.

## Telemetry

Ditto does not include analytics, crash reporting, or telemetry at this time. If
this changes, this policy will be updated and consent will be requested.

## Changes to this policy

When this policy is updated in a way that affects how your data is handled, the
version number above is incremented and you will be asked to review and accept
the updated terms before continuing to use the app.

## Contact

Questions about this policy can be sent to <youngmin3306@gmail.com>.
