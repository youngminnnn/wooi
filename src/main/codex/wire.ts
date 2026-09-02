/**
 * `codex app-server` 프로토콜 중 **Wooi 가 실제로 쓰는 부분만** 손으로 타이핑한 타입.
 *
 * 전체 스키마는 `codex app-server generate-ts` 로 뽑을 수 있지만 npm 공개 패키지가 없고, 무엇보다
 * 설치된 CLI 버전마다 내용이 다르다. 전체를 베껴 오면 사용자의 codex 가 우리와 다른 버전일 때
 * 타입은 맞는데 런타임이 어긋나는 최악의 상황이 된다.
 *
 * 그래서 **좁게, 전부 optional 로** 정의한다. 원칙:
 * - 우리가 읽는 필드만 선언한다. 모르는 필드는 그냥 흘려보낸다.
 * - 거의 모든 필드를 optional 로 둔다 — 버전에 따라 없을 수 있고, 없다고 터지면 안 된다.
 * - 유니온의 `type`/`status` 는 문자열로 열어 둔다. 새 variant 가 생겨도 파싱은 성공하고,
 *   매핑 단계에서 "모르는 종류"로 조용히 무시된다(mapping.ts).
 */

// ── 공통 ────────────────────────────────────────────────────────────────

/** 스레드(=Wooi 워크스페이스 1개의 대화) 식별자. */
export type ThreadId = string

/** 턴 종료 상태. */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

/** 아이템 진행 상태. */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

/** 오류 payload — 턴 실패와 error 알림이 같은 모양을 쓴다. */
export interface CodexError {
  message?: string
  /** `contextWindowExceeded` · `usageLimitExceeded` · `unauthorized` 등. 문자열로 열어 둔다. */
  codexErrorInfo?: string
  additionalDetails?: unknown
}

export type ThreadGoalStatus =
  'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export interface ThreadGoal {
  threadId?: string
  objective?: string
  status?: ThreadGoalStatus
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number
  updatedAt?: number
}

// ── ThreadItem (턴 안에서 벌어지는 일들) ────────────────────────────────

export interface FileUpdateChange {
  path?: string
  /** 'add' | 'delete' | 'update' — 버전에 따라 다른 값이 올 수 있어 열어 둔다. */
  kind?: string
  /** 이 파일의 통합 diff. 승인 프롬프트와 대화 카드가 그대로 보여 준다. */
  diff?: string
}

/**
 * 턴 안의 단위 작업 하나. `type` 으로 갈린다.
 *
 * 모든 variant 를 한 인터페이스에 optional 로 합쳐 뒀다 — 판별 유니온으로 두면 새 variant 가
 * 등장했을 때 타입 좁히기가 실패하는데, 우리는 어차피 `type` 을 문자열로 분기하고 모르는 값은
 * 무시하기 때문에 합집합이 실용적이다.
 */
export interface ThreadItem {
  id?: string
  /**
   * `agentMessage` · `reasoning` · `commandExecution` · `fileChange` · `mcpToolCall` ·
   * `webSearch` · `todoList` · `plan` · `contextCompaction` · `error` · `userMessage` 등.
   */
  type?: string
  status?: ItemStatus

  /** agentMessage · plan · error */
  text?: string
  /** userMessage — app-server v2 UserInput 목록. */
  content?: Array<{
    type?: string
    text?: string
    path?: string
    url?: string
    name?: string
  }>
  /** error */
  message?: string

  /** reasoning — 스트리밍되는 추론 요약(대부분의 OpenAI 모델) */
  summary?: string[] | string
  /** reasoning — 원시 추론 블록(일부 오픈소스 모델) */

  /** commandExecution */
  command?: string
  cwd?: string
  source?: 'agent' | 'userShell' | 'unifiedExecStartup' | 'unifiedExecInteraction'
  /** unified exec 가 오래 살아 있을 때 startup/interaction 을 같은 PTY 로 묶는 식별자. */
  processId?: string | null
  aggregatedOutput?: string
  exitCode?: number
  durationMs?: number

  /** fileChange */
  changes?: FileUpdateChange[]

  /** mcpToolCall */
  server?: string
  namespace?: string | null
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  contentItems?: unknown
  success?: boolean | null

  /** webSearch */
  query?: string

  /** collabToolCall — 서브에이전트 조율 시 모델이 넘긴 지시문. */
  prompt?: string
  /** hookPrompt */
  fragments?: Array<{ text?: string; hookRunId?: string }>
  /** subAgentActivity */
  kind?: string
  agentThreadId?: string
  agentPath?: string
  /** entered/exitedReviewMode */
  review?: string
  /** imageGeneration */
  revisedPrompt?: string | null
  savedPath?: string
  /** imageView */
  path?: string
}

// ── 알림 (서버 → 클라이언트, 응답 불필요) ───────────────────────────────

export interface ThreadStartedParams {
  threadId?: ThreadId
}

export interface TurnParams {
  threadId?: ThreadId
  turn?: {
    id?: string
    status?: TurnStatus
    error?: CodexError
    /** 성공한 턴의 최종 어시스턴트 메시지(요약 폴백). 정본은 item/* 스트림이다. */
    finalResponse?: string
  }
}

export interface ItemParams {
  threadId?: ThreadId
  turnId?: string
  item?: ThreadItem
}

/** item/agentMessage/delta · item/reasoning/summaryTextDelta · commandExecution/outputDelta 공용. */
export interface DeltaParams {
  threadId?: ThreadId
  itemId?: string
  delta?: string
  /** reasoning 요약 구간 구분(summaryTextDelta). */
  summaryIndex?: number
  /** commandExecution/outputDelta 는 chunk 로 올 수도 있다. */
  chunk?: string
}

/** 한 번의 요청/누적에 대한 토큰 내역. */
export interface TokenUsageBreakdown {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

/**
 * 토큰 사용량 알림(`thread/tokenUsage/updated`).
 *
 * 컨텍스트 미터는 **마지막 요청(last)** 의 입력 토큰을 본다 — 그게 지금 윈도를 차지하고 있는 양이다.
 * total 은 세션 누적이라 윈도 점유와 무관하다(누적을 쓰면 미터가 금방 100% 로 보인다).
 */
export interface TokenUsageParams {
  threadId?: ThreadId
  turnId?: string
  tokenUsage?: {
    total?: TokenUsageBreakdown
    last?: TokenUsageBreakdown
    modelContextWindow?: number | null
  }
}

/** turn/plan/updated — 에이전트의 할 일 목록(전체 스냅샷). */
export interface PlanUpdatedParams {
  threadId?: ThreadId
  turnId?: string
  explanation?: string
  plan?: { step?: string; status?: string }[]
}

/** 비치명적 경고. */
export interface WarningParams {
  threadId?: ThreadId
  message?: string
  summary?: string
}

/**
 * turn/diff/updated — 턴이 도는 동안 누적된 **전체 통합 diff**.
 *
 * 턴마다 여러 번 온다(실측: 파일을 건드릴 때마다 3~4회). 우리는 diff 본문을 화면의 정본으로
 * 쓰지 않는다 — 이유는 [[mapping]] 의 해당 case 주석 참고.
 */
export interface TurnDiffParams {
  threadId?: ThreadId
  turnId?: string
  diff?: string
}

/**
 * mcpServer/startupStatus/updated — MCP 서버 기동 상태.
 *
 * `threadId` 가 스키마상 optional 이다. 실측으로는 항상 실려 왔지만(스레드를 열 때 서버가 뜨므로),
 * 없으면 호스트의 라우팅이 버린다([[host]] routeNotification).
 */
export interface McpServerStatusParams {
  name?: string
  /** 'starting' | 'ready' | 'failed' | 'cancelled'. 새 값이 생겨도 파싱은 성공해야 한다. */
  status?: string
  error?: string | null
  /** 지금은 'reauthenticationRequired' 하나뿐이다. */
  failureReason?: string | null
  threadId?: ThreadId | null
}

/** item/mcpToolCall/progress — 긴 MCP 호출이 살아 있음을 알리는 진행 메시지. */
export interface McpToolProgressParams {
  threadId?: ThreadId
  turnId?: string
  itemId?: string
  message?: string
}

/** item/fileChange/patchUpdated — 승인 대기 중 패치 내용이 갱신됐다. */
export interface FileChangePatchParams {
  threadId?: ThreadId
  turnId?: string
  itemId?: string
  changes?: FileUpdateChange[]
}

/**
 * 훅 실행 1회의 요약. hook/started 와 hook/completed 가 같은 모양을 쓴다.
 *
 * `id` 로 시작과 완료가 짝지어지므로 카드 하나를 upsert 할 수 있다.
 */
export interface HookRunSummary {
  id?: string
  /** 'preToolUse' · 'userPromptSubmit' · 'stop' 등. */
  eventName?: string
  /** 'running' | 'completed' | 'failed' | 'blocked' | 'stopped' */
  status?: string
  /** 'sync' 인 훅만 턴을 붙들고 있다. */
  executionMode?: string
  /** 'command' | 'prompt' | 'agent' */
  handlerType?: string
  statusMessage?: string | null
  durationMs?: number | null
  entries?: { kind?: string; text?: string }[]
}

/** hook/started · hook/completed */
export interface HookParams {
  threadId?: ThreadId
  turnId?: string | null
  run?: HookRunSummary
}

/** guardianWarning — 사용자에게 그대로 보여 주면 되는 짧은 경고. */
export interface GuardianWarningParams {
  threadId?: ThreadId
  message?: string
}

/**
 * 승인 auto-review 생명주기. upstream 이 상세 모양을 곧 바꿀 예정이라고 명시했으므로 식별자와
 * 시각만 고정해 읽고, 나머지는 unknown 으로 둔 뒤 매핑 단계에서 그때 쓸 수 있는 값만 고른다.
 */
export interface GuardianApprovalReviewParams {
  threadId?: ThreadId
  turnId?: string
  reviewId?: string
  targetItemId?: string | null
  startedAtMs?: number
  completedAtMs?: number
  review?: unknown
  action?: unknown
  decisionSource?: unknown
}

export interface McpServerOauthLoginCompletedParams {
  name?: string
  success?: boolean
  error?: string | null
  threadId?: ThreadId | null
}

export type McpAuthStatus = 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'

/** 새 상태나 빠진 값은 인증 필요로 오판하지 않고 protocol 의 unknown 으로 낮춘다. */
export function normalizeMcpAuthStatus(status: string | undefined): McpAuthStatus {
  switch (status) {
    case 'unsupported':
    case 'notLoggedIn':
    case 'bearerToken':
    case 'oAuth':
      return status
    default:
      return 'unknown'
  }
}

// ── 서버 → 클라이언트 **요청** (반드시 응답해야 진행된다) ───────────────

/** 명령 실행 승인 요청. */
export interface CommandApprovalParams {
  threadId?: ThreadId
  turnId?: string
  itemId?: string
  command?: string
  cwd?: string
  reason?: string
  /** 서버가 제시하는 결정 목록. 있으면 이걸 그대로 버튼으로 노출한다. */
  /**
   * 서버가 제시하는 결정 목록.
   *
   * **문자열과 객체가 섞여 온다**(실측): ["accept", {"acceptWithExecpolicyAmendment": {…}}, "cancel"].
   * 객체 결정은 응답할 때 그 객체를 통째로 되돌려 줘야 하므로 원본 타입을 열어 둔다.
   */
  availableDecisions?: unknown[]
}

/**
 * 파일 변경(패치) 승인 요청.
 *
 * **diff 가 들어 있지 않다.** 같은 itemId 의 `fileChange` 아이템이 `item/started` 로 먼저 오므로,
 * 호출부가 그걸 붙잡아 두었다가 승인 프롬프트에 실어 줘야 한다(그러지 않으면 사용자가 내용을
 * 못 보고 승인하게 된다).
 */
export interface FileChangeApprovalParams {
  threadId?: ThreadId
  turnId?: string
  itemId?: string
  reason?: string
  /** 세션 동안 이 루트 아래 쓰기를 허용해 달라는 요청(있을 때만). */
  grantRoot?: string | null
}

/** 사용자에게 1~3개의 짧은 질문을 던지는 도구 요청. */
export interface RequestUserInputParams {
  threadId?: ThreadId
  turnId?: string
  itemId?: string
  questions?: {
    /** 답변 맵의 키. 질문문이 아니라 **이 id** 로 답을 되돌려 줘야 한다. */
    id?: string
    /** 짧은 라벨(칩 표시용). */
    header?: string
    question?: string
    /** 자유 입력을 허용하는 질문인지. */
    isOther?: boolean
    isSecret?: boolean
    options?: { label?: string; description?: string }[] | null
  }[]
  autoResolutionMs?: number | null
}

/** 승인 응답에 실어 보내는 결정값. */
export type CodexDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

// ── 요청/응답 (클라이언트 → 서버) ───────────────────────────────────────

export interface InitializeResult {
  userAgent?: string
  codexHome?: string
  platformFamily?: string
  platformOs?: string
}

export interface ThreadResult {
  thread?: {
    id?: ThreadId
    /** 버전에 따라 문자열 또는 `{ type, activeFlags }` 판별 객체로 온다. */
    status?: string | { type?: string }
    path?: string | null
  }
}

export interface ModelListResult {
  data?: {
    id?: string
    displayName?: string
    defaultReasoningEffort?: string
    supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]
    serviceTiers?: { id?: string; name?: string; description?: string }[]
    isDefault?: boolean
    hidden?: boolean
  }[]
}

export interface AccountReadResult {
  account?: {
    /** 'chatgpt' | 'apiKey' | 'amazonBedrock' | 'personalAccessToken' */
    type?: string
    email?: string | null
    planType?: string | null
  } | null
  requiresOpenaiAuth?: boolean
}

export interface RateLimitsResult {
  rateLimits?: {
    primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
    secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
    rateLimitReachedType?: string | null
  } | null
}

export interface SkillMetadata {
  name?: string
  description?: string
  enabled?: boolean
  path?: string
  scope?: 'user' | 'repo' | 'system' | 'admin'
  shortDescription?: string | null
  interface?: { shortDescription?: string | null } | null
}

/**
 * ── Agent Plugins ──────────────────────────────────────────────────────
 *
 * codex 0.146+ 의 `plugin/*`. 스키마상 45개쯤 되는 표면 중 **읽기에 필요한 것만** 옮긴다.
 *
 * 이름이 뜻을 다 말해 주지 않는 곳이 둘 있어 실물로 확인해 뒀다(codex-cli 0.146.0):
 * - `plugin/installed` 는 설치된 것만, `plugin/list` 는 카탈로그 전체다. 후자는 원격 카탈로그까지
 *   합쳐 2,500개가 넘게 오므로 "설치된 것 보기" 에 쓰면 안 된다.
 * - `plugin/read` 는 `marketplacePath` 와 `remoteMarketplaceName` 중 **정확히 하나**를 요구한다.
 *   둘 다 보내면 -32600 으로 거절한다.
 */

/** 플러그인이 자기를 어떻게 소개하는지. 표시용 메타데이터라 전부 optional 이다. */
export interface PluginInterface {
  displayName?: string | null
  shortDescription?: string | null
  longDescription?: string | null
  developerName?: string | null
  category?: string | null
  websiteUrl?: string | null
}

/**
 * 플러그인이 어디서 왔는가. `type` 으로 갈리지만 판별 유니온으로 두지 않는다 —
 * 이 파일의 다른 유니온과 같은 이유다(모르는 variant 가 와도 파싱은 성공해야 한다).
 */
export interface PluginSource {
  /** 'local' | 'git' | 'npm' | 'remote' */
  type?: string
  /** local: 풀어 둔 경로. git: 리포 안 경로. */
  path?: string | null
  /** git */
  url?: string
  refName?: string | null
  /** npm */
  package?: string
  version?: string | null
}

export interface PluginSummary {
  /** `<name>@<marketplace>`. uninstall 이 받는 것도 이 값이다. */
  id?: string
  name?: string
  enabled?: boolean
  installed?: boolean
  source?: PluginSource
  interface?: PluginInterface | null
  /** 로컬에 풀린 패키지 버전. 원격 전용 플러그인에는 없고 `version` 만 있다. */
  localVersion?: string | null
  version?: string | null
  /** 'AVAILABLE' | 'DISABLED_BY_ADMIN' (+ 상류가 'ENABLED' 를 보내는 경우가 있다). */
  availability?: string | null
  /** 'disabled_by_admin' | 'plan_not_eligible' | 'required_app_unavailable' | 'unknown' */
  disabledReason?: string | null
  /** 원격 카탈로그의 플러그인 식별자. 로컬 마켓플레이스 항목에는 없다. */
  remotePluginId?: string | null
  keywords?: string[]
}

export interface PluginMarketplaceEntry {
  name?: string
  /** 로컬 파일 경로. **원격 전용 카탈로그에는 없다** — 그때는 이름으로만 지칭한다. */
  path?: string | null
  interface?: { displayName?: string | null } | null
  plugins?: PluginSummary[]
}

/** `plugin/installed` · `plugin/list` 공용 응답. */
export interface PluginsResponse {
  marketplaces?: PluginMarketplaceEntry[]
  /** 읽지 못한 마켓플레이스. 조용히 빠지면 "왜 안 보이지" 를 화면에서 알 방법이 없다. */
  marketplaceLoadErrors?: { marketplacePath?: string; message?: string }[]
}

/** `plugin/read` — 플러그인 하나가 실제로 무엇을 싣고 있는지. */
export interface PluginDetail {
  summary?: PluginSummary
  marketplaceName?: string
  marketplacePath?: string | null
  description?: string | null
  skills?: { name?: string; description?: string; enabled?: boolean }[]
  /** 이 플러그인이 딸려 오게 하는 MCP 서버 이름들. */
  mcpServers?: string[]
  hooks?: { key?: string; eventName?: string }[]
  apps?: { id?: string; name?: string; description?: string | null }[]
  scheduledTasks?: { key?: string; name?: string }[] | null
  shareUrl?: string | null
}

export interface PluginReadResponse {
  plugin?: PluginDetail
}

export interface SkillsListResponse {
  data: Array<{
    cwd?: string
    skills: SkillMetadata[]
    errors: Array<{ message?: string; path?: string }>
  }>
}

// ── 메서드 이름 상수 ────────────────────────────────────────────────────
// 오타는 런타임에야 드러나므로(그것도 조용히) 한 곳에 모아 둔다.

export const RPC = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadCompact: 'thread/compact/start',
  threadShellCommand: 'thread/shellCommand',
  threadGoalSet: 'thread/goal/set',
  threadGoalGet: 'thread/goal/get',
  threadGoalClear: 'thread/goal/clear',
  reviewStart: 'review/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  skillsList: 'skills/list',
  /** 설치된 Agent Plugins(마켓플레이스별로 묶여 온다). 카탈로그 전체는 `plugin/list` 다. */
  pluginInstalled: 'plugin/installed',
  pluginRead: 'plugin/read',
  modelList: 'model/list',
  accountRead: 'account/read',
  accountLoginStart: 'account/login/start',
  accountLoginCancel: 'account/login/cancel',
  accountLogout: 'account/logout',
  rateLimitsRead: 'account/rateLimits/read',
  mcpStatusList: 'mcpServerStatus/list',
  mcpOauthLogin: 'mcpServer/oauth/login',
  mcpReload: 'config/mcpServer/reload',
  configValueWrite: 'config/value/write',
  configRead: 'config/read'
} as const

/** 서버가 보내오는 알림 메서드. */
export const NOTIFY = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadGoalUpdated: 'thread/goal/updated',
  threadGoalCleared: 'thread/goal/cleared',
  turnStarted: 'turn/started',
  skillsChanged: 'skills/changed',
  // 실패한 턴도 turn/completed 로 온다(status:'failed'). `turn/failed` 알림은 존재하지 않는다.
  turnCompleted: 'turn/completed',
  turnPlanUpdated: 'turn/plan/updated',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  tokenUsage: 'thread/tokenUsage/updated',
  error: 'error',
  warning: 'warning',
  configWarning: 'configWarning',
  serverRequestResolved: 'serverRequest/resolved',
  accountUpdated: 'account/updated',
  accountLoginCompleted: 'account/login/completed',
  rateLimitsUpdated: 'account/rateLimits/updated',
  threadCompacted: 'thread/compacted',
  modelRerouted: 'model/rerouted',
  deprecationNotice: 'deprecationNotice',
  /** 턴 누적 diff. Changes 패널을 턴 중에도 살아 있게 하는 신호로 쓴다. */
  turnDiffUpdated: 'turn/diff/updated',
  /** MCP 서버 기동 상태. 실패만 사용자에게 보여 준다. */
  mcpStartupStatus: 'mcpServer/startupStatus/updated',
  /** 긴 MCP 호출의 진행 메시지. */
  mcpToolProgress: 'item/mcpToolCall/progress',
  /** 승인 대기 중 패치 갱신. */
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  hookStarted: 'hook/started',
  hookCompleted: 'hook/completed',
  guardianWarning: 'guardianWarning',
  guardianApprovalReviewStarted: 'item/autoApprovalReview/started',
  guardianApprovalReviewCompleted: 'item/autoApprovalReview/completed',
  mcpOauthLoginCompleted: 'mcpServer/oauthLogin/completed'
} as const

/** 서버가 우리에게 보내는 **요청** 메서드(응답 필수). */
export const SERVER_REQUEST = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  requestUserInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
  dynamicToolCall: 'item/tool/call'
} as const
