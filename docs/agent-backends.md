# Agent Backend Roadmap

**English** · [한국어](./agent-backends.ko.md)

ditto keeps its AI coding agents behind an `AgentBackend` abstraction so backends can be
swapped and extended (`src/main/agent/*`). This is a living document tracking that expansion.

v1.0.0 ships as **Claude Code only**; later versions add the OpenAI **Codex** backend in
stages. This document currently covers up to **Phase 1 (running Codex alone in one session)**.

> Phase 2 (using Claude + Codex together in a single session) carries larger design decisions —
> notably the cross-session context-sharing policy — so it is out of scope here and only
> previewed in the final section.

---

## 0. Current-state assessment (starting point)

A **backend abstraction layer is already in place** so Codex can be attached.

- `src/main/agent/backend.ts` — `AgentBackend` interface + `AgentCapabilities` + `AgentBackendMeta`
- `src/main/agent/orchestrator.ts` — routes by `workspace.agentBackend`, guards unsupported capabilities
- `src/main/agent/registry.ts` — `createBackend(id)` is the **only place that knows a concrete impl (the Claude SDK)**
- `src/shared/types.ts` — `AgentBackendId`, `Workspace.agentBackend`, store migration (v4→v5)

In other words, the design intent — "a new backend only adds an id, an impl, and capabilities" —
is already reflected in the code.

### But the coupling that remains

The abstraction lives **only in main's orchestration layer**. Above it (UI) and below it
(execution / auth / config) still assume Claude.

| Layer | Claude coupling | File |
|---|---|---|
| Renderer (UI) | **Has no notion of capabilities/backend.** Models, effort, slash commands, permission modes, MCP are hardcoded to Claude | `src/renderer/**` |
| Data model | `PermissionMode` (plan/acceptEdits), `EffortSetting` (ultracode), `ChatItem` (thinking/costUsd/task/compacting) | `src/shared/types.ts` |
| Process execution | Directly bound to the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `src/main/claude/{session,host,executable}.ts` |
| Auth | `claude auth login/status`, `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `~/.claude.json` | `src/main/auth.ts`, `src/main/claude/mcp.ts` |
| Model list | Hardcoded (`claude-opus-4-8[1m]`, etc.) | `src/renderer/src/lib/models.ts` |
| Workspace creation | `agentBackend: DEFAULT_AGENT_BACKEND` hardcoded, no picker UI | `src/main/ipc.ts` |

### Agent-agnostic (no changes needed)

git worktree/PR management, terminal & scripts, file browser & diff, transcript storage
(`transcripts/{workspaceId}.jsonl`), and the notifications/theme/sidebar structure are reused
regardless of backend.

---

## Phase 0 — Common foundation (precedes any scenario)

Before implementing Codex, make the **UI aware of backend capabilities**. The renderer today has
no concept of backend/capabilities, so this work is a prerequisite for the later stages.

### 0-1. Expose capabilities/meta to the renderer
- [ ] Expose `AgentBackendMeta` (including capabilities) so the renderer can read it
      (e.g. include a capabilities snapshot in `evt:state`/`Workspace`, or add `api.getBackendMeta(workspaceId)`)
- [ ] Have `src/renderer/src/store.ts` hold the active workspace's capabilities
- [ ] Update the `src/shared/api.ts` / `src/preload/index.ts` contract

### 0-2. Gate the UI on capabilities
Switch to conditional rendering driven by capabilities.

| Location | Capability to gate on |
|---|---|
| `Composer.tsx` — `/mcp` McpPanel | `mcp` |
| `Composer.tsx` — `/rewind` RewindPanel | `rewind` |
| `Composer.tsx` — `/btw` SideAnswer | `sideQuestion` |
| `Composer.tsx` — `/context`·`/usage`·`/agents`·`/permissions` cards | `interactiveCommands` |
| `Composer.tsx` / `SettingsModal.tsx` — effort picker | `effort` |
| `Composer.tsx` — slash-command autocomplete | `slashCommands` |

### 0-3. Turn hardcoded lists into per-backend data
- [ ] `src/renderer/src/lib/models.ts` — a per-backend model map (or supplied by meta)
- [ ] `src/renderer/src/lib/effort.ts` — per-backend effort options
- [ ] `src/renderer/src/lib/permission.ts` — per-backend permission-mode set + redefine the Shift+Tab cycle

**Definition of Done:** the Claude backend behaves 100% identically (no regression), and flipping a
capability to false makes the corresponding UI disappear.

---

## Phase 1 — Running Codex alone in one session

Drive a workspace with the Codex backend. Author `src/main/codex/*` anew, using the Claude
implementation (`src/main/claude/*`) as the reference model.

> ⚠️ **Investigation required first:** the Codex CLI's invocation, JSON event schema, session-resume
> mechanism, auth flow, model IDs, and approval/sandbox model must be **confirmed from official docs**
> before starting. The "Codex" column below points at the target concept to map; fill in exact values
> from the investigation.

### 1-1. Register the id / registry
- [ ] `src/shared/types.ts` — `AgentBackendId = 'claude' | 'codex'`
- [ ] `src/main/agent/backend.ts` — define `CODEX_META` (id·label·defaultModel·capabilities)
- [ ] `src/main/agent/registry.ts` — add `AGENT_BACKENDS['codex']` + a `createBackend` branch

### 1-2. Implement the Codex backend
Author anew, referencing the matching Claude files.

| New file | Role | Reference |
|---|---|---|
| `src/main/codex/manager.ts` | `implements AgentBackend` (spawns/proxies the host process) | `claude/manager.ts` |
| `src/main/codex/host.ts` | Utility-process entry point that runs the Codex CLI | `claude/host.ts` |
| `src/main/codex/session.ts` | Adapter: Codex stream → `ChatItem`/`ChatEvent` | `claude/session.ts` |
| `src/main/codex/executable.ts` | Resolve the Codex binary path in packaged builds | `claude/executable.ts` |

- [ ] Implement core methods: `sendMessage`·`interrupt`·`setModel`·`setPermissionMode`·`clearSession`·
      `respondPermission`·`dispose`/`disposeAll`·`abortAll`
- [ ] Map Codex events onto the existing `ChatItem` shapes (assistant / tool_use / tool_result / result) —
      Claude-specific items like `thinking`·`task`·`costUsd` are filled only where they correspond, otherwise omitted
- [ ] Capability-gated methods should be **a no-op / clear error when unsupported** (the orchestrator already guards)

### 1-3. Concept mapping (Claude ↔ Codex)

| Concept | Claude | Codex (target) | Handling |
|---|---|---|---|
| Permission/approval | `PermissionMode` default/acceptEdits/plan/auto | approval + sandbox model | split into a per-backend mode set |
| reasoning effort | low~max + ultracode | (Codex's own levels) | per-backend effort options |
| Session resume | `sessionId` (SDK resume) | (Codex session/rollout id) | reuse the existing `sessionId: string` |
| MCP | supported | (confirm support) | on/off via capability |
| Model ID | `claude-*` | (Codex model IDs) | per-backend model list |

### 1-4. Auth
- [ ] `src/main/auth.ts` — add `getCodexStatus()` + a Codex login flow (`codexLoginStart`, etc.)
- [ ] `src/shared/types.ts` — `CodexAuthStatus` + `AuthStatus.codex`
- [ ] Add IPC channels (`auth:codexLoginStart`, etc.) + `evt:codexLogin`
- [ ] Add `src/renderer/src/components/CodexLoginModal.tsx` (reference `ClaudeLoginModal.tsx`)
- [ ] Add a Codex card to `IntegrationsPanel.tsx` / `OnboardingModal.tsx`
- [ ] Branch env vars/config paths: `OPENAI_API_KEY`, `~/.codex/` (mirrors Claude's `ANTHROPIC_*`·`~/.claude.json`)

### 1-5. Backend picker on workspace creation
- [ ] `src/main/ipc.ts` — have `workspace:create` store the chosen value instead of the hardcoded `DEFAULT_AGENT_BACKEND`
- [ ] `src/renderer/src/components/NewWorkspaceModal.tsx` — a backend picker UI
- [ ] (Optional) decide whether to allow changing the backend after creation

**Definition of Done:**
- Create a workspace with Codex and have one turn work end-to-end: streaming, tool execution, permission prompts
- Codex login/logout completes inside the app
- Codex-unsupported features (e.g. `/rewind`, `/btw`) are hidden automatically in the UI
- No regression in Claude-workspace behavior

---

## Risks & notes

- **The heaviest lift is Phase 0** (renderer capability awareness). It is the prerequisite for all later UI gating.
- **The core risk is the concept mapping** — permission modes, effort, auth, and config paths differ semantically
  between Claude and Codex, so a decision to split the shared types per-backend is needed.
- Transcripts are backend-neutral, so the storage layer can be reused as-is.

## Phase 2 preview (out of scope)

Using Claude + Codex together in one session. This breaks the current "one backend per workspace"
assumption and requires, up front: adding a `backend` tag to `ChatItem`, per-turn routing, and a
**cross-session context-sharing policy between Claude↔Codex** (a product decision, not just engineering).
Covered in a separate document.
