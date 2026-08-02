# Agent Backends

**English** · [한국어](./agent-backends.ko.md)

Wooi supports **Claude Code** and **OpenAI Codex** as interchangeable coding-agent
backends. Codex support is available from **Wooi v1.4.0**.

## Choosing an agent

Connect at least one agent under **Settings → Integrations**. When both CLIs are
available, the new-workspace dialog lets you choose Claude Code or Codex. The selected
backend is stored with the workspace and cannot be changed after creation; stacked
workspaces inherit their parent's backend.

| Backend | Runtime | Sign-in | Minimum version |
| --- | --- | --- | --- |
| Claude Code | Claude Agent SDK / installed `claude` CLI | Claude account | Current supported CLI |
| Codex | Installed `codex` CLI via `codex app-server` | ChatGPT account or OpenAI API key | 0.128.0 |

Install Codex with `npm i -g @openai/codex`. Wooi does not bundle the CLI. It reads the
CLI from your login-shell `PATH`, checks its version, and provides install/update guidance
in **Settings → Integrations** when needed.

## Backend-specific behavior

Wooi only shows controls supported by the selected backend. Models, reasoning-effort
levels, permission modes, slash commands, usage limits, and account details therefore
vary by workspace.

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Permission modes | Default, Accept edits, Plan, Auto | Read only, Auto, Full access, Plan |
| Reasoning effort | Backend model list, including Ultracode where supported | Model-specific list from Codex |
| MCP | Supported | Supported |
| In-app sign-in | Supported | Supported |
| Account rate limits | Supported | Supported |
| Steering during a turn | Queued for the next turn | Supported |
| Side question (`/btw`) | Supported | Not supported |
| Rewind | Supported | Not supported |

Codex enforces permissions with a combination of its OS sandbox, approval policy, and
collaboration mode. In particular, **Full access** disables the sandbox and approvals,
including network restrictions; use it only for repositories and prompts you trust.

## Architecture

Agent-independent code depends on the `AgentBackend` interface in
`src/main/agent/backend.ts`. `src/main/agent/registry.ts` exposes backend metadata,
availability checks, and concrete backend creation. Implementations live in:

- `src/main/claude/` — Claude Agent SDK session and host process
- `src/main/codex/` — Codex app-server protocol, event mapping, session, and host process

The renderer consumes `AgentBackendMeta` capabilities instead of hardcoding a backend.
Workspace records store `agentBackend`, while existing workspaces created before v1.4.0
continue to use Claude Code.
