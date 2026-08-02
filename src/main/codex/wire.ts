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
  /** `ContextWindowExceeded` · `UsageLimitExceeded` · `Unauthorized` 등. 문자열로 열어 둔다. */
  codexErrorInfo?: string
  additionalDetails?: unknown
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
  /** error */
  message?: string

  /** reasoning — 스트리밍되는 추론 요약(대부분의 OpenAI 모델) */
  summary?: string[] | string
  /** reasoning — 원시 추론 블록(일부 오픈소스 모델) */
  content?: unknown

  /** commandExecution */
  command?: string
  cwd?: string
  aggregatedOutput?: string
  exitCode?: number
  durationMs?: number

  /** fileChange */
  changes?: FileUpdateChange[]

  /** mcpToolCall */
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown

  /** webSearch */
  query?: string

  /** collabToolCall — 서브에이전트 조율 시 모델이 넘긴 지시문. */
  prompt?: string
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
  availableDecisions?: string[]
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
  thread?: { id?: ThreadId; status?: string; path?: string | null }
}

export interface ModelListResult {
  data?: {
    id?: string
    displayName?: string
    defaultReasoningEffort?: string
    supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]
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

// ── 메서드 이름 상수 ────────────────────────────────────────────────────
// 오타는 런타임에야 드러나므로(그것도 조용히) 한 곳에 모아 둔다.

export const RPC = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadCompact: 'thread/compact/start',
  threadShellCommand: 'thread/shellCommand',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list',
  accountRead: 'account/read',
  accountLoginStart: 'account/login/start',
  accountLoginCancel: 'account/login/cancel',
  accountLogout: 'account/logout',
  rateLimitsRead: 'account/rateLimits/read'
} as const

/** 서버가 보내오는 알림 메서드. */
export const NOTIFY = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  // 실패한 턴도 turn/completed 로 온다(status:'failed'). `turn/failed` 알림은 존재하지 않는다.
  turnCompleted: 'turn/completed',
  turnPlanUpdated: 'turn/plan/updated',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
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
  rateLimitsUpdated: 'account/rateLimits/updated'
} as const

/** 서버가 우리에게 보내는 **요청** 메서드(응답 필수). */
export const SERVER_REQUEST = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  requestUserInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request'
} as const
