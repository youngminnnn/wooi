<!--
  DRAFT — 이 문서는 기술적 사실에 기반한 초안이며 법적 자문이 아니다.
  배포 전 관할·책임 조항 등은 법무 검토를 거쳐야 한다.
-->

# Privacy Policy

_Last updated: 2026-08-02 · Version 1_

Wooi is a local macOS desktop application that orchestrates parallel AI coding
agents — [Claude Code](https://claude.com/claude-code) and
[OpenAI Codex](https://developers.openai.com/codex) — over isolated
git worktrees. This policy explains what data the app handles and where it goes.

## Summary

Wooi has **no servers of its own**. It does not collect analytics or telemetry,
and it does not transmit your data to the developer. Your code and conversations
leave your machine only when sent to the third‑party services you connect
(Anthropic or OpenAI, and optionally GitHub) to make the app function.

## What data is processed, and where it goes

- **Prompts, code, and file contents** — When you send a message or an agent reads
  or edits files, that content is sent to the provider for the workspace's selected
  agent: **Anthropic** through the Claude Agent SDK, or **OpenAI** through the Codex
  CLI. Processing is governed by the provider's privacy policy and the terms of your
  Claude, ChatGPT, or OpenAI API account:
  [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy) ·
  [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/). When you
  review a pull request, the same applies to its diff and to the files the agent
  reads in the review worktree.
- **Repository metadata and pull requests** — If you use the GitHub features,
  Wooi invokes the GitHub CLI (`gh`) on your machine, which communicates with
  **GitHub** under [GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
  This includes review comments and verdicts you choose to post.
- **Authentication** — Wooi uses credentials managed by your installed Claude Code,
  Codex, and GitHub CLIs. Claude and Codex can be connected through an in-app browser
  flow; Codex also accepts an OpenAI API key. Wooi passes credentials to the relevant
  CLI and does **not** include them in conversation transcripts.

## What is stored locally

The following are stored only on your machine, under the app's user‑data
directory (`~/Library/Application Support/Wooi/`):

- App settings (connected repositories, workspaces, preferences) — `wooi.json`
- Conversation transcripts — `transcripts/*.jsonl`
- PR review sessions (diff, findings, activity) — `reviews/*.jsonl`
- Diagnostic logs (errors and CLI detection) — `logs/main.log`

Git worktrees for your workspaces are created under `~/wooi/workspaces/`, outside
the user‑data directory so you can browse them directly.

These files are not uploaded anywhere by Wooi. You can delete a workspace from
within the app, or remove the user‑data and `~/wooi/workspaces/` directories to
erase all local data.

## Telemetry

Wooi does not include analytics, crash reporting, or telemetry at this time. If
this changes, this policy will be updated and consent will be requested.

## Changes to this policy

When this policy is updated in a way that affects how your data is handled, the
version number above is incremented and you will be asked to review and accept
the updated terms before continuing to use the app.

## Contact

Questions about this policy can be sent to <youngmin3306@gmail.com>.
