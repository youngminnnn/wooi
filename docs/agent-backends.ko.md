# 에이전트 백엔드 확장 로드맵

[English](./agent-backends.md) · **한국어**

ditto 는 AI 코딩 에이전트를 `AgentBackend` 추상화 뒤에 두어, 여러 백엔드를 교체·확장할 수 있게
설계돼 있다(`src/main/agent/*`). 이 문서는 그 확장 계획을 담는 살아있는 문서다.

v1.0.0 은 **Claude Code 전용**으로 출시하고, 이후 버전에서 OpenAI **Codex** 백엔드를 단계적으로
추가한다. 이 문서는 현재 그중 **Phase 1(한 세션에서 Codex 단독 사용)** 까지를 다룬다.

> ⚠️ 이 문서는 살아있는 문서다. 아래의 세부 사항(범위·단계 구성·파일 구조·개념 매핑 등)은
> 설계가 발전하고 조사가 진행됨에 따라 언제든 변경될 수 있다.

---

## 0. 현재 구조 진단 (출발점)

Codex를 붙일 수 있도록 **백엔드 추상화 계층이 이미 선제적으로 구축**되어 있다.

- `src/main/agent/backend.ts` — `AgentBackend` 인터페이스 + `AgentCapabilities` + `AgentBackendMeta`
- `src/main/agent/orchestrator.ts` — `workspace.agentBackend` 기준 라우팅, 미지원 capability 가드
- `src/main/agent/registry.ts` — `createBackend(id)` 분기가 **구체 구현(Claude SDK)을 아는 유일한 지점**
- `src/shared/types.ts` — `AgentBackendId`, `Workspace.agentBackend`, store 마이그레이션(v4→v5)

즉 "새 백엔드는 식별자·구현·capabilities만 추가"라는 설계 의도가 코드에 반영돼 있다.

### 그러나 남아 있는 결합

추상화는 **main의 오케스트레이션 레이어에만** 있고, 그 위(UI)와 아래(실행/인증/설정)는
여전히 Claude 전제다.

| 계층 | Claude 결합 지점 | 파일 |
|---|---|---|
| 렌더러(UI) | capabilities/backend를 **전혀 모름**. 모델·effort·슬래시명령·권한모드·MCP가 Claude 하드코딩 | `src/renderer/**` |
| 데이터 모델 | `PermissionMode`(plan/acceptEdits), `EffortSetting`(ultracode), `ChatItem`(thinking/costUsd/task/compacting) | `src/shared/types.ts` |
| 프로세스 실행 | Claude Agent SDK 직결 (`@anthropic-ai/claude-agent-sdk`) | `src/main/claude/{session,host,executable}.ts` |
| 인증 | `claude auth login/status`, `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `~/.claude.json` | `src/main/auth.ts`, `src/main/claude/mcp.ts` |
| 모델 목록 | `claude-opus-4-8[1m]` 등 하드코딩 | `src/renderer/src/lib/models.ts` |
| 워크스페이스 생성 | `agentBackend: DEFAULT_AGENT_BACKEND` 하드코딩, 선택 UI 없음 | `src/main/ipc.ts` |

### Agent-agnostic (손댈 필요 없음)

git worktree/PR 관리, 터미널·스크립트, 파일 브라우저·diff, 트랜스크립트 저장
(`transcripts/{workspaceId}.jsonl`), 알림·테마·사이드바 구조는 백엔드와 무관하게 재사용된다.

---

## Phase 0 — 공통 기반 (어느 시나리오든 선행)

Codex 구현 이전에, **UI가 백엔드 capability를 인지**하도록 만드는 기반 작업.
현재 렌더러는 backend/capabilities 개념을 전혀 모르므로 이 작업이 후속 단계의 전제가 된다.

### 0-1. 렌더러로 capabilities/meta 노출

- [ ] `AgentBackendMeta`(capabilities 포함)를 렌더러가 읽을 수 있게 노출
      (예: `evt:state`/`Workspace`에 capabilities 스냅샷 포함, 또는 `api.getBackendMeta(workspaceId)` 신설)
- [ ] `src/renderer/src/store.ts` 가 활성 워크스페이스의 capabilities 를 보관
- [ ] `src/shared/api.ts` / `src/preload/index.ts` 계약 갱신

### 0-2. UI capability 게이팅

capabilities 기준으로 조건부 렌더로 전환한다.

| 위치 | 게이트할 capability |
|---|---|
| `Composer.tsx` — `/mcp` McpPanel | `mcp` |
| `Composer.tsx` — `/rewind` RewindPanel | `rewind` |
| `Composer.tsx` — `/btw` SideAnswer | `sideQuestion` |
| `Composer.tsx` — `/context`·`/usage`·`/agents`·`/permissions` 카드 | `interactiveCommands` |
| `Composer.tsx` / `SettingsModal.tsx` — effort 피커 | `effort` |
| `Composer.tsx` — 슬래시 자동완성 | `slashCommands` |

### 0-3. 하드코딩 목록을 백엔드별 데이터로

- [ ] `src/renderer/src/lib/models.ts` — backend별 모델 맵(또는 meta 공급)으로
- [ ] `src/renderer/src/lib/effort.ts` — backend별 effort 옵션으로
- [ ] `src/renderer/src/lib/permission.ts` — backend별 권한모드 집합 + Shift+Tab 순환 재정의

**완료 기준(DoD):** Claude 백엔드에서 기존 동작이 100% 동일하게 유지되며(회귀 없음),
capability 를 임의로 false 로 바꾸면 해당 UI 가 사라진다.

---

## Phase 1 — 한 세션에서 Codex 단독 사용

한 워크스페이스를 Codex 백엔드로 구동한다. Claude 구현(`src/main/claude/*`)을 참고 모델로
`src/main/codex/*` 를 신규 작성한다.

> ⚠️ **선행 조사 필요:** Codex CLI 의 실행 방식, JSON 이벤트 스키마, 세션 재개 방식,
> 인증 플로우, 모델 ID, approval/sandbox 모델은 **공식 문서로 확정**한 뒤 착수한다.
> 아래 표의 "Codex" 열은 매핑해야 할 대상 개념을 가리키며, 정확한 값은 조사 결과로 채운다.

### 1-1. 식별자·레지스트리 등록

- [ ] `src/shared/types.ts` — `AgentBackendId = 'claude' | 'codex'`
- [ ] `src/main/agent/backend.ts` — `CODEX_META`(id·label·defaultModel·capabilities) 정의
- [ ] `src/main/agent/registry.ts` — `AGENT_BACKENDS['codex']` + `createBackend` 분기 추가

### 1-2. Codex 백엔드 구현

Claude 대응 파일을 참고해 신규 작성한다.

| 신규 파일 | 역할 | 참고 |
|---|---|---|
| `src/main/codex/manager.ts` | `implements AgentBackend` (호스트 프로세스 spawn·프록시) | `claude/manager.ts` |
| `src/main/codex/host.ts` | Codex CLI 실행 유틸리티 프로세스 진입점 | `claude/host.ts` |
| `src/main/codex/session.ts` | Codex 스트림 → `ChatItem`/`ChatEvent` 어댑터 | `claude/session.ts` |
| `src/main/codex/executable.ts` | 패키징 빌드에서 Codex 바이너리 경로 해석 | `claude/executable.ts` |

- [ ] 핵심 메서드 구현: `sendMessage`·`interrupt`·`setModel`·`setPermissionMode`·`clearSession`·
      `respondPermission`·`dispose`/`disposeAll`·`abortAll`
- [ ] Codex 이벤트를 기존 `ChatItem` 형태로 매핑 (assistant / tool_use / tool_result / result)
      — `thinking`·`task`·`costUsd` 등 Claude 고유 항목은 대응되는 것만 채우고 나머지는 생략
- [ ] capability-게이트 메서드는 **미지원 시 no-op/명확한 에러** (오케스트레이터가 이미 가드)

### 1-3. 개념 매핑 (Claude ↔ Codex)

| 개념 | Claude | Codex(대상) | 처리 |
|---|---|---|---|
| 권한/승인 | `PermissionMode` default/acceptEdits/plan/auto | approval + sandbox 모델 | backend별 모드 집합으로 분리 |
| reasoning effort | low~max + ultracode | (Codex 자체 단계) | backend별 effort 옵션 |
| 세션 재개 | `sessionId` (SDK resume) | (Codex session/rollout id) | 기존 `sessionId: string` 재사용 |
| MCP | 지원 | (지원 여부 확인) | capability 로 on/off |
| 모델 ID | `claude-*` | (Codex 모델 ID) | backend별 모델 목록 |

### 1-4. 인증

- [ ] `src/main/auth.ts` — `getCodexStatus()` + Codex 로그인 플로우(`codexLoginStart` 등) 추가
- [ ] `src/shared/types.ts` — `CodexAuthStatus` + `AuthStatus.codex`
- [ ] IPC 채널 추가 (`auth:codexLoginStart` 등) + `evt:codexLogin`
- [ ] `src/renderer/src/components/CodexLoginModal.tsx` 신설 (`ClaudeLoginModal.tsx` 참고)
- [ ] `IntegrationsPanel.tsx` / `OnboardingModal.tsx` 에 Codex 카드 추가
- [ ] 환경변수/설정 경로 분기: `OPENAI_API_KEY`, `~/.codex/` (Claude 의 `ANTHROPIC_*`·`~/.claude.json` 대응)

### 1-5. 워크스페이스 생성 시 백엔드 선택

- [ ] `src/main/ipc.ts` — `workspace:create` 가 하드코딩(`DEFAULT_AGENT_BACKEND`) 대신 선택값 저장
- [ ] `src/renderer/src/components/NewWorkspaceModal.tsx` — 백엔드 선택 UI
- [ ] (선택) 워크스페이스 생성 후 백엔드 변경 허용 여부 결정

**완료 기준(DoD):**

- 새 워크스페이스를 Codex 로 생성해 대화 1턴이 정상 스트리밍·도구 실행·권한 프롬프트까지 동작
- Codex 로그인/로그아웃이 앱 내에서 완결
- Codex 미지원 기능(예: `/rewind`, `/btw`)은 UI 에서 자동으로 숨겨짐
- Claude 워크스페이스 동작은 회귀 없음

---

## 리스크 & 메모

- **가장 작업량이 몰리는 곳은 Phase 0** (렌더러 capability 인지). 여기가 후속 UI 게이팅 전부의 전제다.
- **개념 매핑이 핵심 리스크** — 권한모드·effort·인증·설정 경로의 의미론이 Claude/Codex 간 달라서,
  shared 타입을 백엔드별로 분리하는 판단이 필요하다.
- 트랜스크립트는 backend 중립적이라 저장 계층은 그대로 쓸 수 있다.
