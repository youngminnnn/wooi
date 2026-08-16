import { DEFAULT_AGENT_BACKEND } from '@shared/types'
import type {
  AgentAuthStatus,
  AgentBackendId,
  AgentBackendMeta,
  AgentRateLimits,
  CodexLoginMethod,
  CommandPanelKind,
  CommandResult,
  EffortOptionInfo,
  EffortSetting,
  ImageAttachment,
  CodexMcpServer,
  McpAction,
  McpServerInfo,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionModeInfo,
  RewindActionResult,
  SendMessageOptions,
  SlashCommandInfo,
  Workspace
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
/**
 * 턴이 끝났다고 소유자(오케스트레이터)에게 알리는 훅. 백엔드마다 턴의 끝을 아는 자리가 다르므로
 * (Claude·Codex 가 각자 status 이벤트를 만든다) 그 자리에서 공통 훅 하나를 부르게 한다.
 *
 * **true 를 돌려주면 그 워크스페이스의 다음 턴을 소유자가 이미 이어 보냈다**는 뜻이다. 그러면
 * 백엔드는 이 턴을 끝난 것으로 처리하면 안 된다 — 상태를 idle 로 적지도, 방송하지도, 완료 알림을
 * 띄우지도 않는다. 대화는 끊긴 적이 없기 때문이다. 왜 끊긴 것으로 보이면 안 되는지는
 * [[agent/orchestrator]] 의 handleTurnEnd 에 적어 뒀다.
 *
 * 오류로 끝났을 때도 알린다 — 소유자가 들고 있던 예약을 접어야 하기 때문이다. 다만 그때는 언제나
 * false 다(실패한 자리에서 자동으로 한 턴을 더 태우지 않는다).
 */
export type TurnEndHook = (workspaceId: string, status: 'idle' | 'error') => boolean

export interface AgentBackend {
  /** 이 백엔드의 식별·표시·기능 메타데이터. */
  readonly meta: AgentBackendMeta
  /** 앱 시작 뒤 첫 사용자 턴의 프로세스 초기화 비용을 백그라운드로 옮긴다. */
  prewarm?(): void

  // ── 핵심 (모든 백엔드 필수) ──────────────────────────────────────────────
  /**
   * Wooi 가 사용자를 대신해 넣는 말은 두 종류이고, 화면에 남는 양이 다르다.
   *
   * - `opts.prefix` — `text` 앞에 붙어 모델에게만 간다. **사용자의 말이 따로 있고** 그 앞에 맥락만
   *   얹을 때 쓴다(에이전트 교체 시의 인수인계, [[shared/handoff]]). 기록에는 사용자의 말만 남는다.
   * - `opts.silent` — 이 전송 자체를 기록에서 지운다. 사용자의 말이 **아예 없을** 때 쓴다(팀으로
   *   바꾼 뒤의 자동 이어가기, [[agent/orchestrator]] resumeAfterTurn). 사용자가 치지도 않은 문장이
   *   자기 말풍선으로 대화에 쌓이면 안 되기 때문이다. 모델에게는 평소처럼 간다.
   */
  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void
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
  /** 설정 해제·계정 변경 시 이 백엔드의 예약된 자동 재개를 모두 취소한다. */
  cancelAllRateLimitResumes?(): void
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
  /**
   * 설정 화면용 — 이 백엔드가 **자기 설정 파일에** 들고 있는 MCP 서버 목록.
   *
   * 워크스페이스와 무관한 설치 단위 조회다. 그런 파일이 따로 없는 백엔드에는 이 메서드가 없다
   * (Claude 는 ~/.claude.json 을 Wooi 가 직접 읽어 주입하므로 main/claude/mcp.ts 가 답한다).
   */
  listConfiguredMcpServers?(): Promise<CodexMcpServer[]>
  /** 그 목록의 서버 하나를 켜고 끈다. 백엔드의 설정 파일에 기록된다. */
  setMcpServerEnabled?(serverName: string, enabled: boolean): Promise<CodexMcpServer[]>
  /** 설정 화면에서 백엔드 고유 MCP OAuth 를 시작한다. 지원 백엔드에만 존재한다. */
  loginMcpServer?(serverName: string): Promise<string>
  /** /rewind — 체크포인트로 파일 되돌리기(capabilities.rewind). */
  rewindAction(workspaceId: string, userMessageId: string): Promise<RewindActionResult>
  /** reasoning effort / ultracode 오버라이드(capabilities.effort). */
  setEffort(workspaceId: string, effort: EffortSetting | null): void
  /** fast mode(`/fast`) 오버라이드(capabilities.fastMode). null 이면 전역 설정을 따른다. */
  setFastMode(workspaceId: string, fastMode: boolean | null): void
  /**
   * 입력창 자동완성용 슬래시 명령 목록(capabilities.slashCommands).
   *
   * cwd 만으로 부족해 workspaceId 도 받는다 — team 모드 워크스페이스에는 위임 서브에이전트
   * 커맨드(`/wooi:claude` …)가 더 실리는데, 그 판단은 워크스페이스를 봐야 한다.
   */
  listCommands(workspaceId: string, cwd: string): Promise<SlashCommandInfo[]>
  /**
   * /add-dir — worktree 밖 디렉토리를 작업 루트로 더한다(capabilities.addDirectory).
   * 세션 시작 시점에 고정되는 값이라 구현은 기존 세션을 정리하고 다음 메시지에서 다시 연다.
   */
  addDirectory?(workspaceId: string, dir: string): { error?: string }
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
 * auto mode 를 지원하지 **않는** 모델. Anthropic 문서가 명시한 목록이다
 * (Haiku 계열 · Sonnet 4.5 · Opus 4.5 · claude-3 계열). CLAUDE_MODELS 중에서는
 * `claude-haiku-4-5` 하나만 걸리지만, 저장된 값이나 마이그레이션으로 옛 ID 가 흘러들 수 있다.
 */
const NO_AUTO_MODE = [/haiku/i, /sonnet-4-5/i, /opus-4-5/i, /^claude-3/i]

/**
 * 이 모델로 auto mode 를 쓸 수 있는가. 계획 승인 프롬프트의 1번 선택지를 가른다.
 *
 * 허용 목록이 아니라 **거부 목록**인 이유: 앞으로 나올 모델은 auto 를 지원할 것이므로, 모르는
 * 값을 "지원" 으로 두는 쪽이 실패 방향이 낫다. 잘못 짚어도 CLI 가 모드를 되돌리고
 * `syncPermissionMode` 가 UI 를 되맞춘다. null 은 CLI 기본 모델(Opus 계열)이라 지원으로 본다.
 */
export function supportsAutoMode(model: string | null | undefined): boolean {
  if (!model) return true
  return !NO_AUTO_MODE.some((p) => p.test(model))
}

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
  // 2026-08-14 부터 Claude Code CLI 도 Pro/Max/Team 신규 세션을 auto 로 연다. 사용자가 백엔드
  // 기본값(AgentSettings.permissionMode)을 직접 정해 뒀다면 그 값이 이긴다 — CLI 의 롤아웃도
  // "본인이 정한 기본값은 유지" 다. 이미 만들어진 워크스페이스는 자기 저장값을 그대로 쓴다.
  defaultPermissionMode: 'auto',
  // 위와 **같은 값이지만 뜻이 다르다** — 이쪽은 "기본으로 무엇을 고를까" 가 아니라 "어느 모드가
  // 자동인가" 다. 지금 겹치는 것은 기본값이 auto 로 옮겨 온 결과일 뿐이고, 기본값이 다시 바뀌어도
  // 자동인 모드는 여전히 'auto' 다. Claude 의 'default' 는 정반대로 "매번 묻는" 모드다.
  autonomousPermissionMode: 'auto',
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
    rateLimits: true,
    // SDK 의 additionalDirectories 로 worktree 밖 디렉토리를 작업 루트에 더할 수 있다.
    addDirectory: true,
    // createSdkMcpServer 로 위임 도구를 프로세스 추가 없이 세션에 꽂을 수 있다(claude/delegate.ts).
    delegate: true
  },
  // 실제 가용성은 CLI 설치 여부로 런타임에 덮어쓴다(checkAvailability).
  available: true
}

/**
 * Codex 데스크톱의 `/permissions` 메뉴와 같은 세 모드를 노출한다. Ask for approval과
 * Approve for me는 같은 workspace 샌드박스를 쓰고, 경계를 넘는 요청을 사용자와
 * Auto-review 중 누가 검토하는지만 다르다. 실제 app-server 정책 변환은 codex/modes.ts가 담당한다.
 */
export const CODEX_PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: 'askForApproval',
    label: 'Ask for approval',
    description: 'Edit and run inside the workspace — ask before going beyond it',
    footer: null
  },
  {
    id: 'default',
    label: 'Approve for me',
    description: 'Edit and run inside the workspace — auto-review requests to go beyond it',
    footer: { symbol: '⏵⏵', text: 'auto-review on' }
  },
  {
    id: 'fullAccess',
    label: 'Full access',
    description: 'No sandbox, no approvals — including network access',
    footer: { symbol: '⏵⏵', text: 'full access on' }
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
  // Codex 의 'default'는 Approve for me(Auto-review)다.
  autonomousPermissionMode: 'default',
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
    rateLimits: true,
    // Codex 는 샌드박스 쓰기 루트를 프로필로 잡아 세션 중 추가하는 경로가 없다.
    addDirectory: false,
    // `thread/start` 의 config 로 mcp_servers 를 **스레드 단위로** 주입해 위임 도구를 붙인다
    // (codex/probe.e2e.test.ts 로 실측 확인). 프로세스 인자(-c)는 app-server 를 공유하는 다른
    // 워크스페이스까지 오염시키므로 쓰지 않는다.
    delegate: true
  },
  // 실제 가용성은 codex CLI 설치·버전으로 런타임에 덮어쓴다(registry 의 backendAvailability).
  available: false
}

/**
 * 식별자별 백엔드 메타데이터 카탈로그. 새 백엔드는 여기에 메타를 추가한다.
 *
 * 구현(SessionManager 등)을 아는 registry.ts 가 아니라 **메타만 아는 이 파일**에 둔다 —
 * registry 는 각 백엔드의 매니저를 import 하므로, 메타 하나 읽으려는 모듈까지 그 무거운 그래프에
 * 끌려 들어가고 순환 import 가 생긴다(manager → multiAgent → registry → manager).
 */
export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendMeta> = {
  claude: CLAUDE_META,
  codex: CODEX_META
}

/** 알 수 없는/누락 식별자의 폴백 백엔드. */
export const DEFAULT_BACKEND_ID: AgentBackendId = 'claude'

/** 식별자에 해당하는 백엔드 메타를 돌려준다(없으면 기본 백엔드). */
export function backendMeta(id: AgentBackendId): AgentBackendMeta {
  return AGENT_BACKENDS[id] ?? AGENT_BACKENDS[DEFAULT_BACKEND_ID]
}

/**
 * 생성 요청에 agent 가 명시되지 않았을 때의 기본값.
 *
 * 스택 자식은 부모 작업의 연속이므로 부모 agent 를 물려받고, 스택 뿌리만 전역 기본값을 쓴다.
 * 이 규칙을 renderer 호출부에 맡기면 수동 생성·agent tool 같은 다른 생성 경로가 서로 달라진다.
 *
 * 워크스페이스를 만드는 [[workspaces]] 가 아니라 **메타만 아는 이 파일**에 둔다 — 만들기
 * 전에 같은 답을 알아야 하는 곳이 또 있기 때문이다(에이전트 도구는 넘겨받은 모델·effort 를
 * 어느 백엔드의 목록으로 검증할지 정해야 한다, [[agent/tools/agentOptions]]). 저쪽에서
 * import 하면 git·github·scripts 까지 딸려 온다.
 */
export function resolveWorkspaceAgentBackend(
  explicit: AgentBackendId | undefined,
  parent: Pick<Workspace, 'agentBackend'> | null | undefined,
  configuredDefault: AgentBackendId | undefined
): AgentBackendId {
  return explicit ?? parent?.agentBackend ?? configuredDefault ?? DEFAULT_AGENT_BACKEND
}
