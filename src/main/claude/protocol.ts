import { normalizePermissionMode } from '@shared/types'
import type {
  AgentBackendId,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  EffortLevel,
  EffortSetting,
  ImageAttachment,
  McpAction,
  PermissionDecision,
  PermissionMode,
  PermissionRequest
} from '@shared/types'
import { CLAUDE_META } from '../agent/backend'

/**
 * main ↔ agent-host(유틸리티 프로세스) 메시지 프로토콜.
 *
 * Claude Agent SDK 의 query() 실행(자식 CLI 의 스트림 파싱·고용량 처리)은 메인 프로세스가
 * 아니라 별도 유틸리티 프로세스(host.ts)에서 돈다. 그래야 SDK/스트리밍 경로에서 네이티브
 * fatal 이 나도 메인(=앱 + 다른 모든 세션)이 함께 죽지 않고, 메인은 호스트의 종료를 감지해
 * 영향받은 세션만 idle 로 되돌리고 호스트를 다시 띄울 수 있다.
 *
 * store·트랜스크립트·렌더러 IPC·권한 UI 라우팅은 메인이 계속 소유하므로, 호스트는 영속/표시가
 * 필요한 모든 것을 이 프로토콜로 메인에 위임한다(persist·event·sessionId·permissionRequest).
 */

/**
 * Claude Code 가 이해하는 권한 모드만 추린 부분집합.
 *
 * 공용 `PermissionMode` 는 모든 백엔드의 모드를 합친 유니온이라 Codex 전용 값('readOnly' 등)이
 * 섞여 있다. 그런 값이 Agent SDK 로 새면 CLI 가 거부하거나 조용히 엉뚱하게 동작하므로, 호스트로
 * 넘어가는 경계에서 타입으로 못 박는다 — 변환은 아래 `claudeMode()` 한 곳에서만 일어난다.
 */
export type ClaudePermissionMode = Extract<
  PermissionMode,
  'default' | 'acceptEdits' | 'plan' | 'auto'
>

/**
 * CLI 가 보고한 모드 문자열이 우리가 UI 로 보여 줄 수 있는 값인지 가른다.
 *
 * `claudeMode()` 와 달리 **모르는 값을 기본 모드로 접지 않는다** — CLI 는 우리 모드 선택지에 없는
 * bypassPermissions·dontAsk 로도 갈 수 있는데, 그걸 'default' 로 접어 표시하면 실제보다 안전해
 * 보이는 거짓말이 된다. 그런 값은 아예 반영하지 않고 마지막으로 알던 모드를 유지한다.
 */
export function asClaudeMode(mode: string | undefined): ClaudePermissionMode | null {
  return CLAUDE_META.permissionModes.some((m) => m.id === mode)
    ? (mode as ClaudePermissionMode)
    : null
}

/** Claude Agent SDK 가 받는 effort 단계(Codex 전용 'minimal' 제외). */
export type ClaudeEffortLevel = Exclude<EffortLevel, 'minimal'>

/** 임의의 권한 모드를 Claude 가 아는 값으로 좁힌다. 모르는 값은 Claude 기본 모드로 떨어진다. */
export function claudeMode(mode: PermissionMode | null | undefined): ClaudePermissionMode {
  // CLAUDE_META.permissionModes 로 걸러진 값이므로 이 단언은 안전하다.
  return normalizePermissionMode(CLAUDE_META, mode) as ClaudePermissionMode
}

/**
 * effort 선택값을 SDK 의 effort 옵션으로 좁힌다.
 * - 'ultracode' 는 effort 가 아니라 별도 모드라 여기서는 null(별도 경로로 전달)
 * - Codex 전용 'minimal' 은 Claude 의 최저 단계인 'low' 로 환산(사용자 의도="가장 빠르게" 보존)
 * - null 이면 지정하지 않아 모델 기본 동작을 따른다
 */
export function claudeEffort(effort: EffortSetting | null | undefined): ClaudeEffortLevel | null {
  if (!effort || effort === 'ultracode') return null
  return effort === 'minimal' ? 'low' : effort
}

/** 세션을 만들 때 필요한 설정. 메인이 store 에서 계산해 명령과 함께 호스트로 보낸다. */
export interface SessionConfig {
  cwd: string
  repoPath: string | null
  model: string | null
  /** reasoning effort 선택값(ultracode 포함). null 이면 지정하지 않는다(모델 기본 동작). */
  effort: EffortSetting | null
  /** fast mode(`/fast`) 사용 여부. true 면 settings 레이어로 fastMode 를 켜서 query 를 연다. */
  fastMode: boolean
  permissionMode: ClaudePermissionMode
  autoCompact: boolean
  autoResumeAfterRateLimit?: boolean
  resumeSessionId: string | null
  /** `/add-dir` 로 더해진 작업 루트(절대 경로). 비어 있으면 cwd 만 쓴다. */
  additionalDirs: string[]
  /**
   * 이 세션이 위임할 수 있는 에이전트 종류. 비어 있으면 위임 도구를 노출하지 않는다
   * (기존 단일 에이전트 워크스페이스). 모드·실험 스위치·capability 판단은 메인이 이미 끝내고
   * 결과만 실어 보내므로, 호스트는 이 목록만 보면 된다.
   */
  delegateBackends: AgentBackendId[]
  /**
   * 위임받을 백엔드의 모델·effort 기본값. 호스트에는 store 가 없으므로 메인이 계산해 실어 보낸다.
   * 백엔드가 늘어도 항목만 늘면 되도록 Record 로 넘긴다.
   */
  agentDefaults: Partial<
    Record<AgentBackendId, { model: string | null; effort: EffortSetting | null }>
  >
}

/** /btw 사이드 질문 진행 상황(호스트 → 메인 → 렌더러). 'start' 는 메인이 직접 보낸다. */
export type SideQuestionUpdate =
  | { workspaceId: string; id: string; phase: 'delta'; text: string }
  | { workspaceId: string; id: string; phase: 'done' }
  | { workspaceId: string; id: string; phase: 'error'; message: string }

/** 메인 → 호스트 명령. */
export type HostCommand =
  | {
      type: 'send'
      workspaceId: string
      config: SessionConfig
      text: string
      images?: ImageAttachment[]
    }
  | { type: 'interrupt'; workspaceId: string }
  | { type: 'setPermissionMode'; workspaceId: string; mode: ClaudePermissionMode }
  | { type: 'dispose'; workspaceId: string }
  | { type: 'disposeAll' }
  | {
      type: 'runCommand'
      reqId: string
      workspaceId: string
      config: SessionConfig
      kind: CommandPanelKind
    }
  | {
      type: 'mcpAction'
      reqId: string
      workspaceId: string
      config: SessionConfig
      serverName: string
      action: McpAction
    }
  | {
      type: 'rewindAction'
      reqId: string
      workspaceId: string
      config: SessionConfig
      userMessageId: string
    }
  /**
   * 계정 레이트리밋 조회. 대상 워크스페이스를 메인이 고르지 않는 것이 핵심이다 —
   * 어느 세션에 라이브 Query 가 있는지는 호스트의 sessions 맵만 알기 때문에, 호스트가 직접
   * 살아 있는 세션을 골라 그 위에서 돌린다(공짜 경로).
   *
   * fallback 이 있으면 라이브 세션이 하나도 없을 때 단명 쿼리로 폴백한다. 이건 CLI 프로세스를
   * 새로 띄우고 MCP 서버까지 연결하는 비싼 경로라, 사용자가 명시적으로 갱신을 누른 경우에만 넘긴다.
   * fallback 이 null 이면 라이브 세션이 없을 때 아무것도 하지 않고 null 을 돌려준다.
   */
  | {
      type: 'refreshUsage'
      reqId: string
      fallback: { cwd: string; repoPath: string | null } | null
    }
  | { type: 'listCommands'; reqId: string; cwd: string }
  | {
      type: 'sideQuestion'
      workspaceId: string
      id: string
      cwd: string
      resumeSessionId: string | null
      model: string | null
      effort: EffortSetting | null
      question: string
    }
  | { type: 'permissionResponse'; requestId: string; decision: PermissionDecision }
  /**
   * 호스트가 올린 Wooi 도구 호출(`toolCall`)의 결과. 메인만 실행할 수 있는 일을 대신 해 주고
   * 돌려주는 회신이다 — 방향이 반대라는 것 말고는 `response` 와 같은 모양이다.
   */
  | { type: 'toolResult'; callId: string; ok: true; data: unknown }
  | { type: 'toolResult'; callId: string; ok: false; error: string }

/** 호스트 → 메인 이벤트. */
export type HostEvent =
  | { type: 'event'; workspaceId: string; event: ChatEvent }
  | { type: 'persist'; workspaceId: string; item: ChatItem }
  | { type: 'sessionId'; workspaceId: string; sessionId: string }
  | { type: 'rateLimit'; workspaceId: string }
  // 턴이 정상 result 없이 끝나(예: CLI 가 턴 도중 죽음) 'running' 에 갇혔을 때, 완료 알림 없이
  // workspace 를 idle 로 확정하도록 메인에 요청한다(메인의 forceIdle 로 연결).
  | { type: 'settleIdle'; workspaceId: string }
  | { type: 'permissionRequest'; request: PermissionRequest }
  // 세션이 스스로 바꾼 권한 모드(계획 승인 → acceptEdits/default). 메인이 store 에 반영하고
  // 렌더러로 방송한다 — 모드는 workspace 상태라 호스트만 알고 있으면 UI 와 어긋난다.
  | { type: 'permissionMode'; workspaceId: string; mode: ClaudePermissionMode }
  | { type: 'response'; reqId: string; ok: true; data: unknown }
  | { type: 'response'; reqId: string; ok: false; error: string }
  | { type: 'sideQuestion'; update: SideQuestionUpdate }
  /**
   * 에이전트가 Wooi 도구(`mcp__wooi__*`)를 호출했다 — 메인이 대신 실행하고 `toolResult` 로 회신한다.
   *
   * 도구가 하는 일(store 수정 · git · GitHub · 렌더러 방송)은 전부 메인 소유라, 호스트에서 도는
   * 인프로세스 MCP 서버는 스스로 아무것도 할 수 없고 이 왕복만 한다. `permissionRequest` →
   * `permissionResponse` 와 같은 패턴이며, 다른 점은 응답이 사용자가 아니라 메인에서 온다는 것뿐이다.
   *
   * workspaceId 는 **인자가 아니라 맥락**이다 — 호출한 세션에서 나오므로 모델이 남의 워크스페이스를
   * 지목할 방법이 없다.
   */
  | { type: 'toolCall'; callId: string; workspaceId: string; tool: string; args: unknown }
