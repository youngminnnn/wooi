import type {
  AgentAuthStatus,
  AgentBackendMeta,
  AgentRateLimits,
  CodexLoginMethod,
  CommandPanelKind,
  CommandResult,
  EffortOptionInfo,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionModeInfo,
  RewindActionResult,
  SlashCommandInfo
} from '@shared/types'

/**
 * AI 코딩 에이전트 백엔드 추상화.
 *
 * wooi 의 나머지 코드(IPC·오케스트레이터)는 이 인터페이스에만 의존하고, 특정 에이전트 SDK
 * (Claude Agent SDK · Codex app-server)에는 직접 의존하지 않는다. 그래서 백엔드 결합은 각
 * 구현(claude/manager.ts · codex/manager.ts)과 레지스트리(registry.ts)에만 갇혀 있고,
 * 새 백엔드는 식별자·구현·capabilities 만 추가하면 붙는다.
 *
 * 핵심 메서드(보내기·중단·권한·정리)는 모든 백엔드가 반드시 지원해야 한다. capability-게이트
 * 메서드(사이드 질문·인터랙티브 명령·MCP·rewind 등)는 백엔드 고유 풍부함을 노출하며, 지원하지
 * 않는 백엔드에서는 오케스트레이터가 capabilities 로 가드해 호출을 막거나 명확한 에러로 끊는다.
 */
export interface AgentBackend {
  /** 이 백엔드의 식별·표시·기능 메타데이터. */
  readonly meta: AgentBackendMeta
  /** 앱 시작 뒤 첫 사용자 턴의 프로세스 초기화 비용을 백그라운드로 옮긴다. */
  prewarm?(): void

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
  /**
   * 계정이 바뀐 뒤 세션 프로세스만 버린다 — **대화 맥락(sessionId)은 유지**해, 다음 메시지가
   * 새 자격증명으로 같은 대화를 이어가게 한다(터미널에서 CLI 재시작 + resume 과 같은 결과).
   */
  recycleAll(): void
  /**
   * 모델 선택지. 정적(Claude)일 수도, 백엔드에 질의(Codex 의 model/list)할 수도 있다.
   *
   * 가용성 확인(CLI 설치·버전)은 여기 두지 않는다 — 백엔드를 **띄우지 않고** 답할 수 있어야
   * 하기 때문이다(registry.ts 의 backendAvailability 참고).
   */
  listModels(): Promise<ModelOption[]>

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
  /** fast mode(`/fast`) 오버라이드(capabilities.fastMode). null 이면 전역 설정을 따른다. */
  setFastMode(workspaceId: string, fastMode: boolean | null): void
  /** 입력창 자동완성용 슬래시 명령 목록(capabilities.slashCommands). */
  listCommands(cwd: string): Promise<SlashCommandInfo[]>
  /**
   * 계정 단위 레이트리밋 스냅샷을 갱신해 AppState 에 반영한다(capabilities.interactiveCommands).
   * /usage 조회의 파생물이라 별도 capability 를 두지 않는다 — 같은 제어 채널을 타므로 항상 함께 켜/꺼진다.
   *
   * allowShortLived=true 면 라이브 세션이 없을 때 단명 쿼리(프로세스 spawn)로 폴백한다.
   * 배경 갱신은 false, 사용자가 명시적으로 갱신을 누른 경우에만 true 를 넘긴다.
   */
  refreshRateLimits(allowShortLived: boolean): Promise<void>

  // ── 계정 (선택) ─────────────────────────────────────────────────────────
  // 백엔드가 자기 계정 상태를 직접 아는 경우에만 구현한다. Claude 는 `claude auth status` 를
  // 셸에서 읽는 별도 경로(auth.ts)를 쓰므로 구현하지 않는다 — 그래서 전부 optional 이다.

  /** 설치·로그인 상태. */
  accountStatus?(): Promise<AgentAuthStatus>
  /** 플랜 사용량. 개념이 없거나 조회 불가면 null. */
  rateLimits?(): Promise<AgentRateLimits | null>
  /** 로그인 시작(capabilities.inAppLogin). 방식은 백엔드가 정의한다. */
  loginStart?(method: CodexLoginMethod, apiKey?: string): Promise<void>
  /** 진행 중인 로그인 취소. */
  loginCancel?(): void
  logout?(): Promise<void>
}

/**
 * Claude Code 백엔드의 기본 모델. store 기본값과 백엔드 메타가 같은 출처를 보도록 여기서 정의한다.
 *
 * `[1m]` 접미사는 예전 CLI 와의 호환 때문에 남겨 둔다. 도입 당시에는 접미사가 **반드시** 필요했다 —
 * opus-5 가 모델 레지스트리에 없어 접미사가 빠지면 윈도가 200K 로 잡혔다(다른 Opus 라인은 1M):
 *
 *   claude-opus-5      → window 200,000   / 자동압축 167,000   (CLI 2.1.220 이전)
 *   claude-opus-5[1m]  → window 1,000,000 / 자동압축 967,000
 *
 * CLI 2.1.220 부터는 opus-5 가 `native_1m` 으로 등재돼 접미사 없이도 1M 이다(실측 확인). 접미사는
 * 계속 유효하므로(supports_1m_suffix) 굳이 값을 바꿔 저장된 설정을 다시 마이그레이션하지 않는다.
 */
export const CLAUDE_DEFAULT_MODEL = null

/**
 * 선택 가능한 Claude 모델 목록 (정확한 모델 ID). Claude Code CLI 가 그대로 수용하는 값들이다.
 *
 * 2026-07-29 기준 라인업. 라벨의 컨텍스트 크기는 추정이 아니라 Claude Code 가 각 ID 에 대해
 * 실제로 잡는 윈도다(모델 레지스트리 + 실측 modelUsage.contextWindow 로 확인).
 *
 * 라벨에는 **기본값과 다른 것만** 적는다 — 200K 는 모델의 기본 윈도라 굳이 표기하지 않고,
 * 1M 인 모델에만 `(1M context)` 를 붙인다.
 *
 * `[1m]` 접미사: 예전에는 opus-5 만 접미사가 없으면 200K 였지만(레지스트리에 미등재라 기본값을
 * 쓰던 시기), CLI 2.1.220 의 레지스트리부터 opus-5 도 `native_1m` 으로 등재돼 접미사 없이도 1M 이다.
 * 두 ID 의 동작이 같아졌으므로 Opus 5 는 한 항목으로 합쳤고, 이미 널리 퍼진 접미사 붙은 값
 * (기본 모델·v9→v10 마이그레이션 결과)을 그대로 쓴다 — 반대로 합치면 저장값을 다시 옮겨야 한다.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5 (1M context)' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)', fastMode: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (1M context)', fastMode: true },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (1M context)', fastMode: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (1M context)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

/**
 * Claude Code 의 권한 모드. CLI 가 Shift+Tab 으로 순환하는 순서·명칭·푸터 문구를 그대로 쓴다
 * (default → accept edits → plan → auto).
 */
export const CLAUDE_PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Ask before every tool use',
    footer: null
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-accept file edits, ask for the rest',
    footer: { symbol: '⏵⏵', text: 'accept edits on' }
  },
  {
    id: 'plan',
    label: 'Plan mode',
    description: 'Read-only — plan without executing',
    footer: { symbol: '⏸', text: 'plan mode on' }
  },
  {
    id: 'auto',
    label: 'Auto mode',
    description: 'A classifier approves/denies automatically',
    footer: { symbol: '⏵⏵', text: 'auto mode on' }
  }
]

/**
 * Claude Code CLI 의 effort 선택기와 동일한 값들. 낮을수록 빠르고 높을수록 깊게 추론한다.
 * xhigh·max·ultracode 는 일부 최신 모델만 지원하고, 미지원 모델에서는 CLI 가 조용히 낮춘다.
 *
 * 'ultracode' 는 effort 레벨이 아니라 별도 모드(xhigh + 상시 동적 워크플로우 조율)지만,
 * CLI 처럼 effort 선택기의 'max' 다음 항목으로 함께 노출한다.
 */
export const CLAUDE_EFFORTS: EffortOptionInfo[] = [
  { id: 'low', label: 'Low', hint: 'Fastest, minimal thinking' },
  { id: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { id: 'high', label: 'High', hint: 'Deep reasoning (model default)' },
  { id: 'xhigh', label: 'Extra high', hint: 'Deeper than high (newer models)' },
  { id: 'max', label: 'Max', hint: 'Maximum effort (select models)' },
  { id: 'ultracode', label: 'Ultracode', hint: 'xhigh + always-on workflow orchestration' }
]

/** Claude Code 백엔드 메타. Claude Agent SDK 의 전체 기능을 지원한다. */
export const CLAUDE_META: AgentBackendMeta = {
  id: 'claude',
  label: 'Claude Code',
  defaultModel: CLAUDE_DEFAULT_MODEL,
  permissionModes: CLAUDE_PERMISSION_MODES,
  defaultPermissionMode: 'default',
  efforts: CLAUDE_EFFORTS,
  capabilities: {
    sideQuestion: true,
    rewind: true,
    mcp: true,
    effort: true,
    fastMode: true,
    // Claude 는 SDK 제어 메서드로 전부 답할 수 있다.
    interactiveCommands: [
      'mcp',
      'context',
      'usage',
      'agents',
      'reloadPlugins',
      'reloadSkills',
      'rewind',
      'permissions'
    ],
    slashCommands: true,
    // Agent SDK 는 스트리밍 입력 큐를 쓰지만 턴이 도는 중의 입력은 다음 턴으로 넘어간다.
    steering: false,
    inAppLogin: true,
    rateLimits: true
  },
  // 실제 가용성은 CLI 설치 여부로 런타임에 덮어쓴다(checkAvailability).
  available: true
}

/**
 * Codex 의 권한 모드. Codex 는 Claude 처럼 도구 프롬프트로 막는 게 아니라 **OS 샌드박스**로
 * 강제하므로, 모드가 곧 (sandbox 정책 × 승인 정책) 조합이다 — CLI 의 `/approvals` 선택지와
 * 같은 이름을 쓴다. 실제 app-server 파라미터로의 변환은 codex/modes.ts 가 담당한다.
 *
 * `default`·`plan` 은 Claude 와 식별자를 공유한다(의미도 대응된다) — 백엔드를 오갈 때 전역
 * 기본값이 자연스럽게 이관되게 하려는 의도이며, 지원하지 않는 값은
 * `normalizePermissionMode` 가 이 백엔드의 기본 모드로 떨어뜨린다.
 */
export const CODEX_PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: 'readOnly',
    label: 'Read only',
    description: 'Read files freely — ask before writing or running anything',
    footer: { symbol: '⏸', text: 'read only' }
  },
  {
    id: 'default',
    label: 'Auto',
    description: 'Edit and run inside the workspace — ask to go beyond it',
    footer: null
  },
  {
    id: 'fullAccess',
    label: 'Full access',
    description: 'No sandbox, no approvals — including network access',
    footer: { symbol: '⏵⏵', text: 'full access on' }
  },
  {
    id: 'plan',
    label: 'Plan mode',
    description: 'Read-only — plan without executing',
    footer: { symbol: '⏸', text: 'plan mode on' }
  }
]

/**
 * Codex 의 reasoning effort 단계. 모델마다 지원 범위가 다르므로 이 목록은 폴백이고,
 * 실제 선택지는 app-server 의 `model/list` 가 모델별로 알려 주는
 * `supportedReasoningEfforts`(→ `ModelOption.efforts`)로 좁혀진다.
 */
export const CODEX_EFFORTS: EffortOptionInfo[] = [
  { id: 'minimal', label: 'Minimal', hint: 'Barely any reasoning, fastest' },
  { id: 'low', label: 'Low', hint: 'Fast, shallow reasoning' },
  { id: 'medium', label: 'Medium', hint: 'Balanced (model default)' },
  { id: 'high', label: 'High', hint: 'Thorough reasoning' },
  { id: 'xhigh', label: 'Extra high', hint: 'Deepest reasoning (select models)' }
]

/**
 * Codex 백엔드 메타.
 *
 * `defaultModel: null` 은 Codex 의 설정/카탈로그 기본 모델을 그대로 따른다는 뜻이다.
 * capability 는 Wooi UI 와 app-server 연결이 모두 준비된 기능만 노출한다.
 */
export const CODEX_META: AgentBackendMeta = {
  id: 'codex',
  label: 'Codex',
  defaultModel: null,
  permissionModes: CODEX_PERMISSION_MODES,
  defaultPermissionMode: 'default',
  efforts: CODEX_EFFORTS,
  capabilities: {
    sideQuestion: false,
    rewind: false,
    mcp: true,
    effort: true,
    fastMode: true,
    // app-server 로 답할 수 있는 것만. /rewind·/agents 는 대응 개념이 없다.
    interactiveCommands: ['mcp', 'context', 'usage', 'permissions'],
    slashCommands: true,
    // app-server 의 turn/steer — 턴이 도는 중에도 입력을 밀어 넣을 수 있다.
    steering: true,
    // account/login/start 가 OAuth 콜백까지 호스팅해 PTY 없이 앱 안에서 로그인이 끝난다.
    inAppLogin: true,
    rateLimits: true
  },
  // 실제 가용성은 codex CLI 설치·버전으로 런타임에 덮어쓴다(registry 의 backendAvailability).
  available: false
}
