import type {
  AgentBackendId,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  PermissionDecision,
  PermissionMode,
  RewindActionResult,
  SlashCommandInfo
} from '@shared/types'

/**
 * AI 코딩 에이전트 백엔드 추상화.
 *
 * ditto 의 나머지 코드(IPC·오케스트레이터)는 이 인터페이스에만 의존하고, 특정 에이전트 SDK
 * (현재 Claude Agent SDK)에는 직접 의존하지 않는다. 그래서 Claude 결합은 단일 구현
 * (claude/manager.ts 의 SessionManager)과 레지스트리(registry.ts)에만 갇혀 있고,
 * 추후 다른 백엔드는 식별자·구현·capabilities 만 추가하면 붙는다.
 *
 * 핵심 메서드(보내기·중단·권한·정리)는 모든 백엔드가 반드시 지원해야 한다. capability-게이트
 * 메서드(사이드 질문·인터랙티브 명령·MCP·rewind 등)는 Claude 고유 풍부함을 노출하며, 지원하지
 * 않는 백엔드에서는 오케스트레이터가 capabilities 로 가드해 호출을 막거나 명확한 에러로 끊는다.
 */
export interface AgentBackend {
  /** 이 백엔드의 식별·표시·기능 메타데이터. */
  readonly meta: AgentBackendMeta

  // ── 핵심 (모든 백엔드 필수) ──────────────────────────────────────────────
  sendMessage(workspaceId: string, text: string, images?: ImageAttachment[]): void
  interrupt(workspaceId: string): Promise<void>
  setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void>
  setModel(workspaceId: string, model: string | null): void
  /** 세션 맥락을 비우고 새 세션으로 시작(워크스페이스·worktree 유지). */
  clearSession(workspaceId: string): void
  respondPermission(requestId: string, decision: PermissionDecision): void
  dispose(workspaceId: string): void
  disposeAll(): void
  /** 인증 무효화 등으로 모든 세션을 한꺼번에 정리하고 진행 상태를 idle 로 되돌린다. */
  abortAll(): void

  // ── capability-게이트 (선택 기능) ────────────────────────────────────────
  /** /btw — 메인 맥락을 건드리지 않는 1회성 사이드 질문(capabilities.sideQuestion). */
  sideQuestion(workspaceId: string, question: string): void
  /** /mcp·/context·/usage 등 인터랙티브 명령 카드(capabilities.interactiveCommands). */
  runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult>
  /** /mcp 패널의 서버별 동작(capabilities.mcp). */
  mcpAction(workspaceId: string, serverName: string, action: McpAction): Promise<McpServerInfo[]>
  /** /rewind — 체크포인트로 파일 되돌리기(capabilities.rewind). */
  rewindAction(workspaceId: string, userMessageId: string): Promise<RewindActionResult>
  /** reasoning effort / ultracode 오버라이드(capabilities.effort). */
  setEffort(workspaceId: string, effort: EffortSetting | null): void
  /** 입력창 자동완성용 슬래시 명령 목록(capabilities.slashCommands). */
  listCommands(cwd: string): Promise<SlashCommandInfo[]>
}

/** 백엔드가 지원하는 선택 기능 집합. UI·오케스트레이터가 노출/가드 여부를 판단한다. */
export interface AgentCapabilities {
  /** /btw 사이드 질문 */
  sideQuestion: boolean
  /** /rewind 파일 체크포인트 되돌리기 */
  rewind: boolean
  /** /mcp 서버 패널 + 재연결/활성화 동작 */
  mcp: boolean
  /** reasoning effort / ultracode 단계 */
  effort: boolean
  /** /context·/usage·/agents 등 인터랙티브 명령 패널 */
  interactiveCommands: boolean
  /** 슬래시 명령 자동완성 */
  slashCommands: boolean
}

/** 백엔드 1개의 식별·표시·기본값·capabilities. */
export interface AgentBackendMeta {
  id: AgentBackendId
  /** 사용자에게 보여 줄 이름(예: "Claude Code"). */
  label: string
  /** 이 백엔드의 기본 모델 ID. */
  defaultModel: string
  capabilities: AgentCapabilities
}

/** Claude Code 백엔드의 기본 모델. store 기본값과 백엔드 메타가 같은 출처를 보도록 여기서 정의한다. */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8[1m]'

/** Claude Code 백엔드 메타. Claude Agent SDK 의 전체 기능을 지원한다. */
export const CLAUDE_META: AgentBackendMeta = {
  id: 'claude',
  label: 'Claude Code',
  defaultModel: CLAUDE_DEFAULT_MODEL,
  capabilities: {
    sideQuestion: true,
    rewind: true,
    mcp: true,
    effort: true,
    interactiveCommands: true,
    slashCommands: true
  }
}
