<!--
  DRAFT — 이 문서는 기술적 사실에 기반한 초안이며 법적 자문이 아니다.
  배포 전 관할·책임 조항 등은 법무 검토를 거쳐야 한다.
-->

# Privacy Policy

_Last updated: 2026-08-16 · Version 1_

Wooi is a local macOS desktop application that orchestrates parallel AI coding
agents — [Claude Code](https://claude.com/claude-code) and
[OpenAI Codex](https://developers.openai.com/codex) — over isolated
git worktrees. This policy explains what data the app handles and where it goes.

## Summary

Wooi does not collect analytics or telemetry, and it does not transmit your code
or conversations to the developer. Your code and conversations leave your machine
only when sent to the third‑party services you connect (Anthropic or OpenAI, and
optionally GitHub) to make the app function.

One optional feature is different, and it is described in full below: **remote
access** lets a phone you have paired watch and control your sessions. It is off
by default. When you turn it on, traffic passes through a relay server operated
by the developer — but it is end‑to‑end encrypted, so the relay carries
ciphertext it cannot read.

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
- Remote access keys and paired devices — `remote.json`, sealed with macOS
  Keychain (`safeStorage`). If the Keychain is unavailable, remote access refuses
  to run rather than storing keys in plain text.
- A record of what your phone did — `logs/remote.log` (device, channel,
  workspace, outcome), so you can answer "what did my phone do?" 

Git worktrees for your workspaces are created under `~/wooi/workspaces/`, outside
the user‑data directory so you can browse them directly.

These files are not uploaded anywhere by Wooi. You can delete a workspace from
within the app, or remove the user‑data and `~/wooi/workspaces/` directories to
erase all local data.

## Remote access (optional, off by default)

Remote access lets a phone you have paired see your workspaces, read
conversations, answer permission prompts, and send follow‑up messages. Your code
and the agents keep running on your computer; the phone is only a control
surface. The feature is off until you turn it on, and while it is off the app
makes no connection to the relay at all.

Turning it on asks for your consent separately from these terms, because it is
the one feature that sends anything to a server the developer runs.

### The relay

Your computer and your phone reach each other through a relay hosted on
[Supabase](https://supabase.com/privacy) and operated by the developer of Wooi.
Your computer only makes outbound connections to it — nothing on your machine is
made reachable from the internet.

### What is encrypted

Everything with substance. When you pair, your computer and phone agree on a key
that neither the relay nor the developer ever sees, and every payload is sealed
with it (XChaCha20‑Poly1305). That covers:

- messages, prompts, and agent output
- code, diffs, and file paths
- workspace and branch names
- permission requests and your answers to them

### What the relay operator can see

Encryption hides content, not the fact that traffic happened. Stored in plain
text on the relay:

- **Identifiers** — a random UUID for your computer and one for each paired
  phone, plus the anonymous account IDs they authenticate with. These are
  generated by Wooi and are not linked to your name or email.
- **Your phone's name and platform** — for example `SM‑F741N` / `android`, so
  the app can show you which device you are approving during pairing and which
  devices are paired. Your **computer's** name is not sent; it is delivered to
  your phone inside the encrypted channel instead.
- **Timing and size** — when your computer was last connected, when commands and
  state snapshots were written, how many there were and how many bytes each
  ciphertext is.
- **Notification events** — that a notification of a given kind
  (`needsInput`, `completed`, `error`) was sent at a given time, and the opaque
  workspace UUID it concerned. The workspace's name passes through in the
  banner text (see [Notifications](#notifications)) but is not stored.
- **Your phone's push token** — the address the push service delivers to.
- Supabase, as the host, also processes ordinary connection metadata such as IP
  addresses.

Taken together this is enough to see *that* you were working and roughly how
much, and — apart from a workspace name in a notification banner — never
*what* you were working on.

### Notifications

When your computer is running something that needs you and you are away from it,
it can send a notification to your phone. The banner names the workspace and
what happened — "design-tokens finished" — so that you can tell from the
lock screen whether it is worth picking up the phone.

**The workspace's name is the one thing Wooi sends in the clear.** The banner
text passes through [Expo's push service](https://expo.dev/privacy) and then
Apple's or Google's push network, and those services can read it, as can the
relay that hands it to them. Nothing else does: the relay only ever accepts a
banner of the form `<name> finished`, and the notification's payload — the
workspace this is really about, and everything the app shows once you open it —
still travels as ciphertext and is decrypted on your phone.

If you would rather no name left your computer, turn notifications off in
Settings → Remote. Everything else on your phone keeps working.

### Where the keys live

- On your computer: `remote.json`, sealed with the macOS Keychain.
- On your phone: the iOS Keychain / Android Keystore, through
  `expo-secure-store`, and only readable while the device is unlocked.

### Turning it off and deleting your data

- **Revoke a device** removes that phone's access immediately — the relay stops
  serving it, not just the app's interface.
- **Delete all remote data** removes your computer's record from the relay along
  with every paired device, queued command, and state snapshot, and erases the
  local keys. Every phone would have to pair again.
- Data also expires on its own: pairing codes after 5 minutes, commands after
  6 hours, notification records after 2 days, and a computer that has not
  connected for 180 days is removed entirely.

## Telemetry

Wooi does not include analytics, crash reporting, or telemetry at this time. If
this changes, this policy will be updated and consent will be requested.

## Changes to this policy

When this policy is updated in a way that affects how your data is handled, the
version number above is incremented and you will be asked to review and accept
the updated terms before continuing to use the app.

The remote access section was added without incrementing the version, because the
feature is off by default and cannot send anything until you enable it — and
enabling it asks for your consent at that moment, where the decision is actually
being made. Users who never turn it on are unaffected, and re‑prompting everyone
for a feature they are not using would train people to click through consent
screens.

## Contact

Questions about this policy can be sent to <youngmin3306@gmail.com>.
