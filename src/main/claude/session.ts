import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  McpSdkServerConfigWithInstance,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'
import { clampText, clampInput } from './clamp'
import { buildFileChangeDiff, isFileChangeTool } from './editDiff'
import { matchesRule, ruleForRequest, saveAllowRule } from './permissionRules'
import { resolveClaudeExecutable } from './executable'
import { sessionTranscriptExists } from './sessionFiles'
import { CLAUDE_CODE_SYSTEM_PROMPT } from './systemPrompt'
import { log } from '../logger'
import { MCP_SETTING_SOURCES, resolveUserMcpServers } from './mcp'
import { isReadOnlyWooiTool, WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import { delegateShellAttempt, delegateShellGuidance } from '../agent/delegateShell'
import { resolveWooiPlugin } from '../agent/plugin'
import { fastModeReasonText, planApprovalMode, planOptions, unknownItemId } from '@shared/types'
import { supportsAutoMode } from '../agent/backend'
import { asClaudeMode, claudeEffort, claudeMode, type ClaudePermissionMode } from './protocol'
import type {
  AgentBackendId,
  ChatItem,
  ChatEvent,
  EffortSetting,
  FastModeDisabledReason,
  FastModeState,
  ImageAttachment,
  McpSettings,
  PermissionRequest,
  PermissionDecision,
  RewindPoint,
  RewindActionResult,
  RunningAgent
} from '@shared/types'

export interface SessionDeps {
  cwd: string
  /** worktree 의 원본 repo 절대 경로. ~/.claude.json 의 project 스코프 MCP 조회에 쓴다(없으면 user 스코프만). */
  repoPath: string | null
  /**
   * Wooi 스코프 MCP 설정. 메인이 store 에서 읽어 내려 준다 — 호스트에는 store 가 없다
   * ([[claude/protocol]] SessionConfig.mcpSettings).
   */
  mcpSettings: McpSettings
  model: string | null
  /** reasoning effort 선택값(ultracode 포함). null 이면 effort 를 지정하지 않아 모델 기본 동작을 따른다. */
  effort: EffortSetting | null
  /**
   * fast mode(Claude Code 의 `/fast`) 사용 여부. true 면 settings 레이어로 fastMode 를 켠다.
   * 실제 적용 여부는 CLI 가 모델·플랜·쿨다운을 보고 정하며, 그 결과는 result 의 fast_mode_state 로 온다.
   */
  fastMode: boolean
  permissionMode: ClaudePermissionMode
  /** true 면 컨텍스트 사용률이 임계치를 넘었을 때 턴 종료 후 /compact 를 자동 주입한다. */
  autoCompact: boolean
  /** 계정 사용량 제한을 오류로 끝내지 않고 메인의 자동 재개 scheduler에 넘길지. */
  autoResumeAfterRateLimit?: boolean
  /**
   * 네이티브 cross-session messaging(Claude Code 2.1.224+)에서의 이 세션의 정체와 수신 정책.
   * 메인이 워크스페이스에서 계산해 내려 준다([[claude/protocol]] SessionConfig).
   */
  peer: { name: string; inbound: 'accept' | 'refuse' }
  /** 이전 실행에서 이어갈 Claude 세션 ID. 없으면 새 세션. */
  resumeSessionId: string | null
  /** `/add-dir` 로 더해진 작업 루트(절대 경로). cwd 밖의 코드를 함께 읽고 고칠 수 있게 한다. */
  additionalDirs: string[]
  /**
   * 이 워크스페이스에 묶인 Wooi 도구 서버([[claude/wooiMcp]]). 호스트가 만들어 넘긴다.
   *
   * 세션마다 따로인 이유는 도구가 "어느 워크스페이스에서 불렸는가" 를 이 인스턴스로만 알기
   * 때문이다 — 모델은 그것을 인자로 지목할 수 없다.
   */
  wooiMcp: McpSdkServerConfigWithInstance
  /**
   * 이 세션이 위임할 수 있는 에이전트 종류. 없거나 비어 있으면 위임 도구를 아예 노출하지 않는다 —
   * 기존 단일 에이전트 세션은 이 경로를 전혀 타지 않으므로 **없는 것이 기본**이다.
   */
  delegateBackends?: AgentBackendId[]
  /**
   * Solo 인 이 워크스페이스를 팀으로 바꿀 수 있는가. 셸로 다른 에이전트 제품을 돌리려는 시도를
   * 가로챌 때 무엇을 권할지 가른다([[agent/delegateShell]]). 없으면 못 바꾸는 것으로 읽는다.
   */
  canSwitchToAgentTeam?: boolean
  /**
   * 위임받을 백엔드의 모델·effort 기본값. 메인이 설정에서 계산해 내려 준다.
   * delegateBackends 가 비어 있으면 쓰이지 않으므로 함께 생략할 수 있다.
   */
  agentDefaults?: (backend: AgentBackendId) => {
    model: string | null
    effort: EffortSetting | null
  }
  emit: (event: ChatEvent) => void
  persist: (item: ChatItem) => void
  requestPermission: (
    req: Omit<PermissionRequest, 'requestId' | 'workspaceId'>
  ) => Promise<PermissionDecision>
  onSessionId: (id: string) => void
  /**
   * 계정 사용량 제한으로 턴이 중단됐다. 메인이 reset 이후 자동 재개를 예약한다.
   * resetAt 은 제한 오류가 직접 알려 준 해제 시각(epoch ms)이다 — 모르면 넘기지 않는다.
   */
  onRateLimit?: (resetAt?: number) => void
  /**
   * 세션이 스스로 권한 모드를 바꿨음을 알린다(계획 승인 → acceptEdits/default).
   * 모드는 workspace 상태의 일부라 메인이 store 에 반영하고 UI 로 방송해야 한다.
   */
  onPermissionMode: (mode: ClaudePermissionMode) => void
  /**
   * 진행 중이던 턴이 정상 result 없이 끝났을 때(예: CLI 프로세스가 턴 도중 죽어 result 가
   * 영영 오지 않는 경우) workspace 상태를 idle 로 확정한다. emit('status', idle) 와 달리
   * "Response complete" 알림을 띄우지 않도록 manager.forceIdle 로 연결한다.
   */
  settleIdle: () => void
}

type Block = { type: string; [k: string]: unknown }

/** 진행 중 워크플로우 1건의 누적 상태(여러 task_* 메시지를 병합해 하나의 카드로 보여 주기 위함). */
interface WorkflowTaskState {
  taskId: string
  name: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'paused'
  summary?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  ts: number
}

// 패키징 빌드에서 SDK 가 app.asar 안 경로로 CLI 를 spawn 해 ENOTDIR 로 실패하지 않도록,
// app.asar.unpacked 의 실제 바이너리 경로를 1회 계산해 둔다(dev 에서는 null → SDK 기본값).
const claudeExecutable = resolveClaudeExecutable()

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>

/**
 * getContextUsage() 가 임계치를 알려주지 않을 때만 쓰는 폴백 사용률(퍼센트).
 * 구 SDK 이거나 Claude Code 쪽 자동 압축이 꺼져 있어 autoCompactThreshold 가 비는 경우다.
 */
const AUTO_COMPACT_FALLBACK_PERCENT = 92

/**
 * 지금 압축해야 하는지 — Claude Code **자신의** 자동 압축 시점과 같은 기준으로 판단한다.
 *
 * getContextUsage() 응답에는 Claude Code 가 실제로 쓰는 임계치가 토큰 수로 실려 온다
 * (autoCompactThreshold = 유효 윈도 − 출력 예약 − 안전 버퍼). 이 값은 모델마다 크게 다르므로
 * 고정 퍼센트로 근사하면 양방향으로 어긋난다 — 실측 기준:
 *
 *   window 200,000  → 167,000 (83.5%)   고정 92% 면 **너무 늦게** 압축
 *   window 1,000,000 → 967,000 (96.7%)  고정 92% 면 **너무 일찍** 압축(약 47K 손해)
 *
 * 그래서 근사하지 않고 SDK 가 준 값을 그대로 쓴다.
 */
function overAutoCompactThreshold(ctx: ContextUsage): boolean {
  const threshold = ctx.autoCompactThreshold
  if (typeof threshold === 'number' && threshold > 0) return ctx.totalTokens >= threshold
  return ctx.percentage >= AUTO_COMPACT_FALLBACK_PERCENT
}

/** getContextUsage 제어 요청 상한. 지연돼도 미터·자동압축 판단이 멈추지 않도록 둔다. */
const CONTEXT_USAGE_TIMEOUT_MS = 5000

/**
 * 계획 승인 뒤 라이브 query 에 새 권한 모드를 보내기까지의 지연.
 * CLI 가 ExitPlanMode 를 처리하며 스스로 모드를 되돌리는 창을 넘긴 뒤에 우리 값을 얹는다.
 */
const PLAN_MODE_APPLY_DELAY_MS = 250

/**
 * 계획 승인 직후 CLI 가 보고하는 모드를 무시할 창. PLAN_MODE_APPLY_DELAY_MS 동안 CLI 는 자기
 * 기본값으로 되돌아갔다가 우리 값을 받으므로, 그 사이 보고를 그대로 반영하면 사용자가 고른
 * "auto-accept edits" 가 잠깐 'default' 로 깜빡인다. 왕복이 끝날 여유를 조금 더 둔다.
 */
const PLAN_MODE_SETTLE_MS = PLAN_MODE_APPLY_DELAY_MS + 750

/**
 * `assistant.error` 만으로 실패한 턴을 프로세스 교체로 다시 돌릴 가치가 있는지 가리는 패턴.
 *
 * SDK 는 API 레벨 실패를 예외로 던지지 않고 두 가지 모양으로 실어 온다(관측 확인):
 * - **result 의 비-success subtype**(예: error_during_execution) — 대개 원인 문자열이 없다. 실제
 *   인증 실패가 이 모양으로 오므로, 별도 `assistant.error` 가 없는 산출 없는 실패는 1회 재시도한다.
 *   다만 최신 CLI 는 session limit 같은 원인을 result 직전 `assistant.error` 로 주기도 한다. 이때
 *   알려진 비인증 오류까지 재시도하면 같은 요청을 즉시 한 번 더 보내 동일 오류가 중복된다.
 * - **`assistant.error` + result:success**(예: model_not_found) — 원인 코드가 있다. 이쪽은
 *   프로세스를 갈아도 대개 그대로이므로(없는 모델은 재시도해도 없다) 자격증명류만 고른다.
 *
 * 오탐(예: rate limit 문구에 섞인 'token')을 피하려고 인증 맥락의 표현만 좁게 잡는다. 걸려도
 * 부작용은 없다 — 산출이 없었던 턴만 재시도하므로 중복 작업이 생기지 않는다.
 */
const RESTARTABLE_AUTH_ERROR =
  /\b(?:auth\w*|unauthorized|forbidden|401|403|oauth|credentials?|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bearer|revoked|not logged in|log ?in again|sign ?in again)\b/i

/** fast-mode cooldown이 아닌 계정 전체 사용량 제한 문구만 좁게 식별한다. */
export const RATE_LIMIT_ERROR =
  /(?:usage limit|rate[ _-]?limit|quota).*(?:reached|exceeded|reset|available)|(?:reached|exceeded).*(?:usage limit|rate[ _-]?limit|quota)|hit your limit|assistant error:\s*rate_limit/i

/**
 * CLI 는 사용량 제한을 알릴 때 해제 시각을 epoch 로 덧붙인다
 * (예: `Claude AI usage limit reached|1754880000`).
 */
const RATE_LIMIT_RESET_EPOCH = /\|\s*(\d{10,13})\b/

/** 제한 오류 문구가 알려 준 해제 시각(epoch ms). 없거나 말이 안 되는 값이면 null. */
export function rateLimitResetAt(text: string | null, now: number): number | null {
  if (!text) return null
  const match = RATE_LIMIT_RESET_EPOCH.exec(text)
  if (!match) return null
  const digits = match[1]
  const at = digits.length >= 13 ? Number(digits) : Number(digits) * 1000
  // 스냅샷보다 이 값을 우선하므로, 미래이면서 상식적인 범위(30일)일 때만 믿는다.
  if (!Number.isFinite(at) || at <= now || at > now + 30 * 24 * 60 * 60_000) return null
  return at
}

/**
 * 콜드 resume preflight 의 getContextUsage 상한. 따뜻한 세션의 미터 갱신(5초)보다 넉넉히 둔다 —
 * 이 시점의 CLI 는 방금 뜬 프로세스가 디스크 트랜스크립트를 복원하는 중이라 제어 응답이 늦다.
 * 너무 짧으면 매번 타임아웃으로 폴백해, 압축을 먼저 하려던 preflight 자체가 무의미해진다.
 */
const PREFLIGHT_CONTEXT_USAGE_TIMEOUT_MS = 25_000

/**
 * query 생성 후 SDK 메시지(system:init 등)가 하나도 안 오는 것을 스톨로 보고 abort 하는 상한.
 * "진짜 무한 스톨"만 걸러내는 최후 백스톱이지, 느린 startup 을 끊는 용도가 아니다.
 *
 * 관측/실측 결과: MCP 서버 기동은 비블로킹이라(응답 없는 서버를 붙여도 init 은 수백 ms 에 온다)
 * 첫 메시지를 막지 않는다. 실제로 오래 걸리는 건 **옛 세션의 콜드 resume 재생**으로, 오래된/큰
 * 트랜스크립트를 처음 복원할 때 수십 초가 걸리다가 **결국 성공**하는 경우가 있다. 그래서 상한을
 * 넉넉히(3분) 둬서 "느리지만 되는 resume" 을 죽이지 않는다 — 너무 짧으면 성공 직전의 resume 을
 * 잘라 정상 동작을 반복 실패로 바꿔버린다. 이 시간을 넘겨도 첫 메시지가 없으면 resume 은 그대로
 * 두고(맥락 보존) 명확한 에러 + idle 로 떨어뜨려 무한 로딩만 끊는다.
 */
const FIRST_MESSAGE_TIMEOUT_MS = 180_000

/** p 가 ms 안에 끝나지 않으면 reject 한다(타임아웃 시 호출부가 폴백 경로로 빠지도록). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ])
}

/**
 * 하나의 workspace 에 묶인 단일 Claude Code 세션.
 *
 * 사용자가 첫 메시지를 보낼 때 lazy 하게 query 를 시작한다(자동 프롬프트·자동 실행 없음).
 * Agent SDK 의 streaming input 으로 장수명 query 한 개를 유지하며, 사용자 메시지가
 * 올 때마다 입력 큐에 흘려보낸다 — 같은 세션 안에서 멀티턴 맥락이 유지된다.
 *
 * SDK 메시지(stream_event/assistant/user/result)를 renderer 가 그릴 수 있는
 * ChatEvent 로 변환하고, 권위 있는 항목은 트랜스크립트에 영속화한다.
 *
 * 에이전트 맥락 보존: 이전 실행의 세션 ID(resumeSessionId)가 있으면 query 시작 시 resume 로
 * 디스크의 대화 맥락을 이어받는다 — 앱 재시작·모델 변경 후에도 같은 대화를 계속할 수 있다
 * (과거 메시지는 재방출되지 않아 중복 렌더링이 없다). resume 대상 세션이 사라졌거나(예: ~/.claude
 * 정리, 다른 머신) 손상돼 첫 메시지 전에 실패하면, 맥락만 잃고 새 세션으로 1회 폴백해
 * 사용자가 막히지 않게 한다(retryWithoutResume).
 */
export class ClaudeSession {
  private input = new AsyncQueue<SDKUserMessage>()
  /**
   * SDK 가 입력 큐에서 꺼내 갔지만 아직 result 로 완료되지 않은 사용자 메시지.
   *
   * SDK 는 streaming input 을 곧바로 끌어가 CLI stdin 으로 흘려보내므로, 프로세스가 죽는 순간
   * 그 메시지는 이미 우리 큐에서 사라진 상태다. 그래서 죽은 query 를 재시도할 때 여기 기록해 둔
   * 메시지를 되살려 다시 흘려보낸다 — 이게 없으면 재시도한 query 가 빈 입력으로 하염없이 대기한다.
   * result 를 받은 만큼(1 메시지 = 1 result) 앞에서부터 비운다.
   */
  private inFlight: SDKUserMessage[] = []
  private q: Query | null = null
  private currentApiMsgId: string | null = null
  /** 사용자가 "always allow" 한 도구 이름. 이 세션 동안 다시 묻지 않는다. */
  private alwaysAllow = new Set<string>()
  /** 모르는 블록을 종류당 한 번만 알리기 위한 기록(Codex 쪽 CodexThread.warned 와 같은 역할). */
  private warned = new Set<string>()
  /**
   * 자동 압축 /compact 를 주입해 두고 그 결과(result)를 기다리는 중인지.
   * 압축 턴의 result·boundary 가 다시 임계치를 넘겨 무한 압축 루프를 도는 것을 막는다.
   */
  private autoCompactInFlight = false
  /**
   * 이번 query 에서 SDK 메시지를 하나라도 받았는지(= 세션이 정상 시작됐는지). 워치독과 resume
   * 폴백 판단에 쓴다. **query 단위 상태이므로 run() 시작마다 false 로 리셋한다** — 세션 단위로
   * 누적되면 재시도 query 가 스톨 보호·폴백을 모두 잃는다.
   */
  private sawAnyMessage = false
  /** resume 실패로 새 세션 폴백을 이미 1회 시도했는지(무한 재시도 방지). */
  private resumeRetried = false
  /**
   * **이번 턴**에서 모델이 실제 산출(스트리밍 델타·텍스트·사고·도구 호출)을 냈는지.
   *
   * 실패한 턴을 조용히 다시 돌려도 **안전한지**를 가르는 기준이다. 산출이 없었다면 도구 실행·
   * 파일 편집 같은 부작용도 없었다는 뜻이므로, 같은 사용자 메시지를 새 프로세스에서 다시 돌려도
   * 중복이 생기지 않는다. 산출이 이미 있었다면(부분 작업 발생) 재시도하지 않고 에러를 알린다.
   *
   * 주의: SDK 는 API 레벨 실패도 `assistant` 메시지로 실어 오는데(error + 설명 텍스트) 그건
   * 모델 산출이 아니라 실패 보고이므로 여기서 세지 않는다.
   */
  private turnSawOutput = false
  /** 이번 턴에서 SDK 가 보고한 API 레벨 오류(assistant.error). 재시도 판단에 쓴다. */
  private turnError: string | null = null
  /**
   * 표시를 보류한 실패 카드. API 레벨 실패는 프로세스를 갈아 재시도하면 사용자에게 보일 필요가
   * 없으므로, 재시도 여부가 정해지는 result 시점까지 붙들어 둔다(재시도하면 그대로 버린다).
   */
  private pendingFailureItems: ChatItem[] = []
  /** 실패한 턴을 새 프로세스에서 다시 돌리기 위해 의도적으로 query 를 끊었는지. */
  private restartRequested = false
  /**
   * 지금 살아 있는 CLI 세션의 ID(system:init 으로 확정).
   *
   * 프로세스를 갈아 끼울 때 이걸 resume 대상으로 삼아야 맥락이 끊기지 않는다 — deps.resumeSessionId
   * 는 세션 생성 시점의 값이라, 이 프로세스에서 처음 만들어진 세션(새 워크스페이스에서 여러 턴을
   * 주고받은 경우)은 그 안에 없어서 재시작 시 빈 세션으로 시작해 버린다.
   */
  private currentSessionId: string | null = null
  /** 직전에 CLI 가 보고한 fast mode 실제 상태. 바뀔 때만 이벤트·안내를 낸다. */
  private lastFastModeState: FastModeState | null = null
  /** "켜 뒀지만 실제로는 표준 속도" 안내를 이미 띄웠는지(세션당 1회만). */
  private notedFastModeOff = false
  /** 현재 query 의 abort 컨트롤러(프로세스를 갈아 끼울 때 끊는 데 쓴다). */
  private abort: AbortController | null = null
  /**
   * 이번 사용자 시도에서 죽은 query 를 자동 재시도했는지. send() 마다 리셋되고, 성공 result 로도
   * 풀린다 — "사용자 전송 1회당 자동 재시도 1회" 예산이라 무한 루프가 되지 않는다.
   */
  private autoRetried = false
  /**
   * 사용자가 이번 턴을 직접 중단했는지. 중단으로 query 가 끝난 것을 "죽었다" 고 보고 자동
   * 재시도하면 사용자 의도를 거스르므로, 그 경로에서는 재시도를 막는다.
   */
  private interrupted = false
  /** 계획 승인 뒤 CLI 가 보고하는 권한 모드를 무시할 시각(epoch ms). syncPermissionMode 참고. */
  private planSettleAt = 0
  /**
   * 턴이 진행 중인지(running 을 방출했고 아직 result/error 로 마무리되지 않았는지).
   * query 루프가 result 없이 끝났을 때 'running' 에 갇히지 않도록 finally 에서 idle 로 푸는 데 쓴다.
   */
  private active = false
  /**
   * active 가 false→true 로 바뀔 때마다 오르는 카운터. settleTurn 이 컨텍스트 확인을 기다리는
   * 동안 새 일감(사용자 메시지·압축)이 들어왔는지 가리는 데 쓴다 — 확인을 마치고 뒤늦게 idle 을
   * 방출하면 그 사이 시작된 턴이 idle 로 보이기 때문이다.
   */
  private activeSeq = 0
  /**
   * 마지막으로 방출한 상태가 'running'(true) 인지 'idle'(false) 인지. running/idle 전환을 이 한
   * 곳(syncStatus)으로 모아, 실제 상태 변화가 있을 때만 방출하고 중복/역행 방출을 막는다.
   */
  private busy = false
  /**
   * 진행 중인 동적 워크플로우 실행의 누적 상태(task_id 기준).
   * task_progress·task_updated·task_notification 은 부분 정보만 실어 오므로, task_started 에서
   * 워크플로우로 등록한 실행만 여기 모아 두고 갱신을 병합한다(서브에이전트 등 비워크플로우 task 는 무시).
   */
  private workflowTasks = new Map<string, WorkflowTaskState>()
  /**
   * 지금 살아 있는 서브에이전트(Task 도구)의 상태(task_id 기준). 워크플로우와 같은 task_* 스트림을
   * 쓰지만 표시 경로가 다르다 — 워크플로우는 트랜스크립트 카드, 서브에이전트는 사이드바 패널.
   * 서브에이전트는 부모 턴의 tool_use/tool_result 로 이미 트랜스크립트에 남으므로 영속하지 않는다.
   */
  private agentTasks = new Map<string, RunningAgent>()
  /**
   * resume 콜드스타트의 "이중 패스"를 피하기 위한 상태.
   *
   * 다른 계정 로그인 등으로 세션을 콜드 resume 하면, 첫 턴이 디스크 트랜스크립트 전체를 다시
   * 입력으로 보낸다(계정이 바뀌면 프롬프트 캐시가 무효라 정가로). 이때 맥락이 이미 자동압축
   * 임계치를 넘겨 있으면 기존 코드는 "사용자 턴(전체 로드) → 직후 /compact(전체 재로드)" 로 큰
   * 맥락을 두 번 흘려보낸다. 그래서 resume + autoCompact 인 세션은 사용자 첫 메시지를 잠시
   * 버퍼링하고, 첫 턴 처리 전에 컨텍스트를 한 번만 확인한다(preflight): 임계치를 넘었으면 /compact
   * 를 먼저 보내(compact-first) 사용자 턴이 압축된(작은) 맥락 위에서 돌게 한다. 확인이 실패하면
   * (라이브 쿼리 없음/타임아웃) 버퍼를 그대로 흘려보내 기존 동작으로 안전하게 폴백한다.
   */
  private preflightPending = false
  /** preflight 가 끝날 때까지 잡아 두는 사용자 메시지(끝나면 입력 큐로 흘려보낸다). */
  private bufferedMessages: SDKUserMessage[] = []
  /**
   * /rewind 용 체크포인트(되돌릴 수 있는 사용자 메시지 지점). 보낸 메시지의 첫 줄을
   * pendingUserTexts 에 모았다가, SDK 가 그 메시지를 echo 하며 부여한 uuid 와 짝지어 쌓는다.
   * 파일 체크포인팅(enableFileCheckpointing)이 켜진 살아 있는 세션에서만 의미가 있다.
   *
   * `null` 은 화면에 남지 않는 전송(silent)의 자리표다 — 체크포인트는 만들지 않되 echo 와의 짝은
   * 한 칸도 밀리지 않게 한다(handleUser 참고).
   */
  private pendingUserTexts: (string | null)[] = []
  private checkpoints: RewindPoint[] = []

  constructor(private deps: SessionDeps) {
    // resume + autoCompact 일 때만 preflight 한다(콜드스타트 이중 패스가 생길 수 있는 유일한 조건).
    this.preflightPending = Boolean(deps.resumeSessionId) && deps.autoCompact
  }

  /** /rewind 패널용: 최근이 위로 오도록 뒤집은 체크포인트 목록. */
  getCheckpoints(): RewindPoint[] {
    return [...this.checkpoints].reverse()
  }

  /**
   * 고른 체크포인트(사용자 메시지 uuid)로 추적된 파일을 되돌린다.
   * 체크포인트 백업 blob 은 살아 있는 query 안에 있으므로, 같은 세션이 떠 있을 때만 동작한다 —
   * 세션이 없으면(앱 재시작·dispose 후) canRewind=false 로 안내한다(warm up 으로 새 query 를
   * 열어도 과거 편집의 백업이 없어 되돌릴 수 없다).
   */
  async rewind(userMessageId: string): Promise<RewindActionResult> {
    const q = this.q
    if (!q) {
      return {
        canRewind: false,
        error:
          'No live session to rewind. Send a message first, then rewind within the same session.'
      }
    }
    try {
      const r = await q.rewindFiles(userMessageId)
      return {
        canRewind: r.canRewind,
        error: r.error,
        filesChanged: r.filesChanged,
        insertions: r.insertions,
        deletions: r.deletions
      }
    } catch (err) {
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 현재 살아 있는 streaming query(없으면 null). 인터랙티브 명령(/mcp·/context 등)을 "지금 돌고
   * 있는" 세션 위에서 실행하려는 manager 가 참조한다 — 라이브 쿼리가 없으면 단명 쿼리로 폴백한다.
   */
  get liveQuery(): Query | null {
    return this.q
  }

  /**
   * /mcp 서버 동작(재연결·활성/비활성)처럼 살아 있는 제어 채널이 필요한 명령을 위해,
   * 아직 query 가 없으면 사용자 메시지 없이 query 를 시작(warm up)하고 그 핸들을 돌려준다.
   *
   * run() 은 첫 await 이전에 this.q 를 동기적으로 설정하므로, 호출 직후 항상 살아 있는 query 가 있다.
   * 메시지를 보내지 않으므로 에이전트 턴은 돌지 않고(상태도 running 으로 바뀌지 않음) MCP 연결만
   * 맺으며, 여기서 적용한 토글/재연결은 이후 사용자가 같은 세션에서 대화를 이어가도 유지된다.
   */
  ensureLiveQuery(): Query {
    if (!this.q) this.run()
    if (!this.q) throw new Error('Failed to start session query.')
    return this.q
  }

  /**
   * 사용자 메시지를 보낸다. 첫 메시지면 query 를 시작한다.
   *
   * `prefix` 는 사용자가 쓴 말이 아니라 Wooi 가 앞에 붙여 주는 맥락이다([[claude/protocol]]).
   * 모델에게는 함께 가지만 기록에는 사용자의 말만 남는다 — 인수인계 프롬프트는 지난 대화를
   * 통째로 다시 적은 것이라, 남기면 같은 대화가 화면에 두 번 쌓인다.
   *
   * `silent` 는 한 걸음 더 간다: 남길 사용자의 말이 **아예 없는** 전송이라 기록도 화면도 건드리지
   * 않는다([[agent/backend]] sendMessage). /rewind 체크포인트도 만들지 않는다 — 되돌릴 지점으로
   * 고를 사용자 메시지가 화면에 없기 때문이다(자동 /compact 주입이 걸러지는 것과 같은 길).
   */
  send(
    text: string,
    images?: ImageAttachment[],
    opts?: { prefix?: string; silent?: boolean }
  ): void {
    const imgs = images ?? []
    const prompt = opts?.prefix ? `${opts.prefix}\n\n${text}` : text
    if (!opts?.silent) {
      const item: ChatItem = {
        // 큐에 쌓인 N개를 한 번에 보내면 같은 ms 안에서 여러 번 호출된다 — 시간 기반 id 는
        // 충돌해서 upsert(last-wins) 로 합쳐지고 마지막 메시지만 화면에 남는다. uuid 로 보장한다.
        id: `user:${randomUUID()}`,
        type: 'user',
        text,
        ts: Date.now(),
        // base64 본문은 트랜스크립트에 남기지 않고(무겁다) 이름/형식만 칩으로 표시.
        ...(imgs.length
          ? { attachments: imgs.map((i) => ({ name: i.name, mediaType: i.mediaType })) }
          : {})
      }
      this.deps.persist(item)
      this.deps.emit({ type: 'item', item })
    }
    // 새 사용자 시도다 — 턴 상태와 자동 재시도 예산, 중단 표시를 리셋한다.
    this.beginTurn()
    this.autoRetried = false
    this.interrupted = false
    this.markActive()

    // /rewind 체크포인트 라벨용으로 이 메시지의 첫 줄을 큐에 둔다 — SDK 가 이 사용자 메시지를
    // echo 하며 부여하는 uuid 와 handleUser 에서 짝지어 체크포인트로 확정한다. silent 전송은
    // 체크포인트를 만들지 않지만 echo 는 오므로, 빈 자리(null)를 넣어 짝을 맞춘다.
    this.pendingUserTexts.push(
      opts?.silent ? null : firstLine(text || (imgs.length ? `${imgs.length} image(s)` : ''))
    )

    // 이미지가 있으면 멀티모달 content 배열로(텍스트 블록 + base64 이미지 블록), 없으면 문자열.
    const content = imgs.length
      ? [
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
          ...imgs.map((i) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: i.mediaType, data: i.dataBase64 }
          }))
        ]
      : prompt

    this.enqueue({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null
    })

    if (!this.q) this.run()
  }

  /**
   * 사용자 메시지를 입력 큐로 보낸다. preflight 대기 중이면(콜드 resume 첫 턴 전) 큐에 직접 넣지
   * 않고 버퍼링한다 — preflight 가 끝나면(필요 시 /compact 를 먼저 보낸 뒤) flushBuffered 로 방출한다.
   */
  private enqueue(msg: SDKUserMessage): void {
    if (this.preflightPending) this.bufferedMessages.push(msg)
    else this.input.push(msg)
  }

  /** 버퍼링해 둔 사용자 메시지를 입력 큐로 흘려보내고 preflight 를 종료한다. */
  private flushBuffered(): void {
    this.preflightPending = false
    const msgs = this.bufferedMessages
    this.bufferedMessages = []
    for (const m of msgs) this.input.push(m)
  }

  /**
   * 콜드 resume 첫 턴 전에 컨텍스트를 한 번 확인해, 이미 임계치를 넘었으면 사용자 턴보다 /compact 를
   * 먼저 흘려보낸다(compact-first). 버퍼링된 사용자 메시지는 압축 result(handleResult)에서 방출된다.
   * 임계치 미만이거나 확인이 실패하면 즉시 버퍼를 비워 기존 동작으로 폴백한다.
   */
  private async runResumePreflight(): Promise<void> {
    if (!this.preflightPending) return
    // 보낼 사용자 메시지가 없으면(예: /mcp warm-up) 압축할 이유가 없다 — preflight 만 종료한다.
    if (this.bufferedMessages.length === 0) {
      this.preflightPending = false
      return
    }

    const q = this.q
    if (!q) {
      this.flushBuffered()
      return
    }

    let ctx: ContextUsage
    try {
      ctx = await withTimeout(q.getContextUsage(), PREFLIGHT_CONTEXT_USAGE_TIMEOUT_MS)
    } catch (err) {
      // 확인 실패 시 압축 없이 그대로 진행한다(기존 동작과 동일 — 큰 패스 1회는 불가피).
      log.warn('session: resume preflight getContextUsage failed/timed out; flushing buffered', err)
      this.flushBuffered()
      return
    }

    if (this.deps.autoCompact && !this.autoCompactInFlight && overAutoCompactThreshold(ctx)) {
      // compact-first: 사용자 턴 전에 압축한다. 버퍼는 압축 result 후 flushBuffered 로 방출(preflightPending 유지).
      this.autoCompactInFlight = true
      this.emitItem({
        id: `compacting:${Date.now()}`,
        type: 'system',
        text: 'Auto-compacting conversation to free up space…',
        ts: Date.now()
      })
      this.deps.emit({ type: 'compacting', active: true, trigger: 'auto' })
      this.input.push({
        type: 'user',
        message: { role: 'user', content: '/compact' },
        parent_tool_use_id: null
      })
      return
    }

    this.flushBuffered()
  }

  async interrupt(): Promise<void> {
    // 사용자 의도로 끝난 턴은 자동 재시도 대상이 아니다(handleQueryDeath 가 이 플래그를 본다).
    this.interrupted = true
    // 위임 실행은 별도 프로세스/query 라 부모 query 의 interrupt 로는 끊기지 않는다. 여기서
    // 끊지 않으면 사용자가 멈춘 뒤에도 `codex exec` 가 계속 파일을 고친다.
    await this.q?.interrupt().catch(() => {})
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.deps.permissionMode = mode
    await this.q?.setPermissionMode(mode).catch(() => {})
  }

  /**
   * 계획 승인 결과를 반영한다(plan → acceptEdits/default).
   *
   * 우리 값이 다음 query 에도 남도록 deps 는 즉시 갱신하되, 라이브 query 로 보내는 제어 요청은
   * 조금 미룬다 — 승인 직후에는 CLI 도 ExitPlanMode 를 처리하며 자체적으로 모드를 되돌리는데,
   * 그 전에 우리가 먼저 보내면 사용자가 고른 "auto-accept edits" 가 CLI 의 기본값에 덮인다.
   * canUseTool 응답을 붙잡아 두지 않는 효과도 있다(제어 채널 왕복을 승인 경로 밖으로 뺀다).
   */
  private applyPlanApproval(mode: ClaudePermissionMode): void {
    this.deps.permissionMode = mode
    this.deps.onPermissionMode(mode)
    this.planSettleAt = Date.now() + PLAN_MODE_SETTLE_MS
    setTimeout(() => void this.setPermissionMode(mode), PLAN_MODE_APPLY_DELAY_MS)
  }

  /**
   * CLI 가 스스로 바꾼 권한 모드를 UI 에 되비친다.
   *
   * 모드는 우리만 바꾸는 게 아니다 — 모델이 EnterPlanMode 로 계획 모드에 들어가거나, CLI 가
   * ExitPlanMode 를 처리하며 모드를 되돌린다. 이 신호를 흘리면 하단 표시가 실제와 어긋난 채
   * 남는다(계획을 세우는 중인데 표시는 "default"). CLI 는 모드가 바뀔 때마다
   * `status` 메시지에 permissionMode 를 실어 보내므로, 그때마다 맞춰 준다.
   */
  private syncPermissionMode(reported: string | undefined): void {
    const mode = asClaudeMode(reported)
    if (!mode || mode === this.deps.permissionMode) return
    // 계획 승인 직후의 되돌림은 사용자 선택이 아니라 CLI 의 중간 상태다(상수 주석 참고).
    if (Date.now() < this.planSettleAt) return
    this.deps.permissionMode = mode
    this.deps.onPermissionMode(mode)
  }

  /**
   * "다시 묻지 않기" 규칙을 기억한다. 세션 범위는 메모리에만, project 범위는 **원본 리포**의
   * `.claude/settings.local.json` 에도 적어 다음 세션·다음 워크스페이스까지 남긴다
   * (worktree 는 작업이 끝나면 사라지므로 거기 적으면 곧 없어진다).
   */
  private rememberRule(rule: string, scope: 'session' | 'project' | undefined): void {
    this.alwaysAllow.add(rule)
    if (scope !== 'project') return
    const root = this.deps.repoPath ?? this.deps.cwd
    const saved = saveAllowRule(root, rule)
    this.emitItem({
      id: `system:allow-rule:${Date.now()}`,
      type: 'system',
      text: saved
        ? `Always allowing ${rule} — saved to .claude/settings.local.json`
        : `Always allowing ${rule} for this session — couldn't write .claude/settings.local.json`,
      ts: Date.now()
    })
  }

  /** 입력 큐를 닫아 query 루프를 정상 종료시킨다. */
  dispose(): void {
    this.input.close()
    // 위임 실행은 부모 query 와 수명이 따로다 — 여기서 끊지 않으면 워크스페이스를 닫아도
    // 자식 프로세스가 남아 worktree 를 계속 건드린다.
    this.q?.interrupt().catch(() => {})
  }

  // ── query 루프 ─────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    // 죽은 query 를 새 프로세스로 이어받아 재시도할지. finally 이후에 재시도해 this.q 클로버를 피한다.
    let retrying = false
    // 새 프로세스에서 턴을 다시 시작한다 — 산출/오류 기록을 초기화한다.
    this.beginTurn()
    // sawAnyMessage 는 **이 query 한 개**의 상태다(run() 한 번 = query 한 개). 여기서 리셋하지
    // 않으면 첫 query 가 메시지를 받은 뒤로 영원히 true 로 남아, 이어지는 재시도 query 는
    // (1) 워치독이 즉시 return 해 스톨 보호를 못 받고(무한 로딩),
    // (2) handleQueryDeath 의 새 세션 폴백(!sawAnyMessage)이 영영 성립하지 않는다.
    // 재시도 횟수는 autoRetried·resumeRetried 가 따로 막으므로 리셋해도 루프가 생기지 않는다.
    this.sawAnyMessage = false
    // 첫 메시지가 안 오는 스톨을 감지해 abort 하기 위한 워치독. abort 하면 for-await 가
    // (throw 또는 정상 종료로) 풀리고, 아래 first-message 실패 처리로 폴백/에러가 확정된다.
    const abort = new AbortController()
    this.abort = abort
    let stalled = false
    const watchdog = setTimeout(() => {
      if (this.sawAnyMessage) return
      stalled = true
      log.error(
        `session: no SDK message within ${FIRST_MESSAGE_TIMEOUT_MS}ms — aborting stuck query ` +
          `(session restore/resume likely stalled; MCP startup is non-blocking and ruled out)`
      )
      abort.abort()
    }, FIRST_MESSAGE_TIMEOUT_MS)
    try {
      // 사용자가 claude CLI 용으로 등록한 MCP 서버(user/project/local 스코프)를 명시 주입한다.
      // cwd 가 worktree 라 SDK 자동 탐색만으로는 원본 repo 의 project 스코프 서버가 누락되기 때문.
      const userServers = resolveUserMcpServers(this.deps.repoPath, this.deps.mcpSettings)
      // Wooi 자체를 조작하는 도구는 우리가 이긴다 — 같은 이름을 쓰는 사용자 서버가 있으면 앱
      // 조작 통로가 통째로 남의 것으로 바뀌므로, 덮어쓰되 조용히 넘어가지 않는다.
      if (userServers[WOOI_MCP_SERVER_NAME]) {
        log.warn(
          `mcp: your config defines a server named "${WOOI_MCP_SERVER_NAME}" — ` +
            `Wooi's built-in tools take that name, so yours is not loaded in this workspace`
        )
      }
      const mcpServers = { ...userServers, [WOOI_MCP_SERVER_NAME]: this.deps.wooiMcp }
      // 'ultracode' 는 effort 레벨이 아니라 별도 모드(xhigh + 상시 워크플로우 조율)다 — SDK 로는
      // effort 옵션이 아니라 settings 레이어의 ultracode: true 로 전달한다. 그 외 effort 레벨은
      // effort 옵션으로 그대로 넘기고, null 이면 아무것도 넘기지 않아 모델 기본 동작을 따른다.
      const ultracode = this.deps.effort === 'ultracode'
      const sdkEffort = claudeEffort(this.deps.effort)
      // team 모드 세션에만 위임 커맨드가 든 변형을 물린다 — 쓸 수 없는 명령은 보이지 않아야 한다.
      const wooiPlugin = resolveWooiPlugin(!!this.deps.delegateBackends?.length)
      this.q = query({
        prompt: this.promptStream(this.input),
        options: {
          cwd: this.deps.cwd,
          includePartialMessages: true,
          // Claude Code 의 기본 시스템 프롬프트를 그대로 쓴다 — 생략하면 SDK 가 빈 프롬프트로
          // 덮어써 행동 지침이 통째로 빠진다(자세한 이유는 systemPrompt.ts 주석).
          systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
          // /rewind 가 동작하도록 편집 전 파일 스냅샷을 남긴다(세션 단위). resume 옵션과는
          // 호환되며(sessionStore 와 달리), 켜두기만 하면 추적 비용은 무시할 만하다.
          enableFileCheckpointing: true,
          permissionMode: this.deps.permissionMode,
          // CLI 와 동일하게 파일시스템 설정(settings.json·CLAUDE.md·.mcp.json)을 로드.
          settingSources: MCP_SETTING_SOURCES,
          // 훅 생애주기 이벤트를 받는다. 성공한 훅은 조용히 넘기고 **실패한 훅만** 표시하기 위해서다 —
          // 터미널은 훅이 죽으면 경고를 찍는데, 이걸 받지 않으면 Wooi 에서는 아무 흔적 없이 사라진다.
          includeHookEvents: true,
          // 인라인 settings 레이어 — query Options 가 아니라 settings.json 스키마(Settings) 소속인
          // 플래그를 여기로 전달한다. settingSources 가 읽는 파일 설정 "위에" 합쳐지므로 CLAUDE.md·
          // MCP 로딩에는 영향이 없지만, 같은 이유로 **사용자가 직접 적어 둔 값을 조용히 덮어쓴다**.
          // 그래서 무조건 주입하지 않고, 키마다 "지금 이 값이어야 하는 이유" 가 있을 때만 넣는다.
          //
          // enableWorkflows — ultracode 일 때만 켠다. 예전에는 무조건 true 였는데 두 가지가 문제였다:
          // (1) 플랜 기본값이 off 인 Pro 사용자에게도 Workflow 도구 정의가 매 요청 시스템 프롬프트에
          // 실리고, (2) 사용자가 settings.json 에서 명시적으로 꺼 둔 설정까지 되살아난다. CLI 의 기본값은
          // `defaultOn = 플랜 !== 'pro'` 이므로, 주입을 빼면 Max 는 그대로 켜지고 Pro 는 플랜 정책을 따른다.
          // ultracode 는 정의상 "xhigh + 상시 워크플로우 조율" 이라 이때만 함께 켠다.
          //
          // fastMode — SDK 세션에서는 이 인라인 플래그가 있을 때만 켜진다. 사용자의 settings.json 값만
          // 으로는 활성화되지 않는다(CLI 가 SDK 모드에서 flagSettings.fastMode 를 요구한다). 지원 모델·
          // 플랜이 아니거나 fast rate limit 쿨다운이면 CLI 가 조용히 표준 속도로 돌리고 result 로 알려 준다.
          //
          // autoCompactWindow — 주입하지 않는다. 한때 200K 를 넣어 턴당 입력 비용을 눌렀지만, 1M
          // 윈도 모델을 고른 세션까지 967K → 167K 로 끌어내려 "1M 인데 왜 이렇게 빨리 압축되냐" 가
          // 됐다. 압축 시점은 모델 윈도를 따르는 게 맞으므로 Claude Code 의 모델별 공식 임계치를
          // 그대로 쓴다(overAutoCompactThreshold). 낮추고 싶은 사용자는 자기 settings.json 에
          // autoCompactWindow 를 적으면 되고, settingSources 로 그대로 로드된다.
          //
          // crossSessionInbound — 앱 **바깥** 세션(사용자 터미널의 claude, 다른 머신)이 이 세션에
          // 말을 걸 수 있는가. 기본이 refuse 인 이유는 Wooi 가 그것을 붙잡아 둘 수 없기 때문이다 —
          // 앱 안의 peer 메시지는 승인 배너를 거치지만, 바깥에서 오는 것은 CLI 가 곧바로 모델에게
          // 넘겨 승인 없는 턴 비용을 만든다. 사용자가 그 워크스페이스의 자동 수신을 켜 둔 경우에만
          // 연다([[types]] nativePeerInbound 가 hold→refuse 로 접는 이유도 같다).
          //
          // isolatePeerMachines — 이 머신 밖으로 나가는 SendMessage 에 승인을 요구한다. 머신 간
          // 전달은 Anthropic 서버를 거치므로(같은 머신은 소켓으로 직접 간다) 데스크톱 앱이 조용히
          // 열어 둘 경로가 아니다. 승인은 Wooi 의 권한 카드로 뜬다(canUseTool).
          settings: {
            ...(ultracode ? { enableWorkflows: true, ultracode: true } : {}),
            ...(this.deps.fastMode ? { fastMode: true } : {}),
            crossSessionInbound: this.deps.peer.inbound,
            isolatePeerMachines: true
          },
          // 사용자의 다른 터미널 세션이 `/list-agents` 에서 보는 이름. 지정하지 않으면 CLI 가
          // 작업 디렉터리 이름으로 짓는데, Wooi 워크트리는 전부 랜덤 이름이라 목록이 읽히지 않는다.
          extraArgs: { name: this.deps.peer.name },
          // /add-dir 로 더한 작업 루트. query 시작 시점에 고정되므로 목록이 바뀌면 매니저가
          // 세션을 새로 연다(resume 으로 대화 맥락은 이어진다).
          ...(this.deps.additionalDirs.length
            ? { additionalDirectories: this.deps.additionalDirs }
            : {}),
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
          // `/wooi:*` 슬래시 명령을 싣는 로컬 플러그인([[agent/plugin]]). 명령만 가져오고 MCP
          // 탐색은 건너뛴다 — `wooi` 서버는 바로 위에서 인프로세스로 직접 넘기고 있으므로,
          // CLI 가 플러그인 쪽에서 같은 서버를 또 찾게 두면 안 된다.
          ...(wooiPlugin
            ? { plugins: [{ type: 'local' as const, path: wooiPlugin, skipMcpDiscovery: true }] }
            : {}),
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
          ...(this.deps.model ? { model: this.deps.model } : {}),
          // reasoning effort 가 지정돼 있으면 그대로 전달한다(ultracode 는 settings 로 처리하므로 제외).
          ...(sdkEffort ? { effort: sdkEffort } : {}),
          // 이전 세션 ID 가 있으면 디스크에서 대화 맥락을 복원한다(과거 메시지는 재방출되지 않음).
          ...(this.deps.resumeSessionId ? { resume: this.deps.resumeSessionId } : {}),
          abortController: abort,
          canUseTool: this.canUseTool
        }
      })

      log.info(
        `session: query created (resume=${this.deps.resumeSessionId ? 'yes' : 'no'}, ` +
          `mcp=${Object.keys(mcpServers).length}, preflight=${this.preflightPending}) — awaiting first message…`
      )

      // preflight 는 **query 생성 직후** 돌린다 — system:init 을 기다리면 데드락이다.
      // CLI 는 입력 스트림에서 사용자 메시지를 하나라도 받아야 init 을 내보내는데, preflight 중에는
      // enqueue 가 그 메시지를 버퍼에 잡아 둔다. 즉 "init 을 기다리는 preflight" 와 "입력을 기다리는
      // init" 이 서로를 기다려, 워치독이 끊을 때까지 무응답이 된다(실측: 45초간 메시지 0건).
      // getContextUsage 는 입력 스트림과 무관한 제어 채널을 쓰므로 입력 없이도 응답한다(실측 ~2초).
      if (this.preflightPending) void this.runResumePreflight()

      for await (const msg of this.q) {
        if (!this.sawAnyMessage) {
          clearTimeout(watchdog)
          log.info(`session: first SDK message received (type=${msg.type})`)
        }
        this.sawAnyMessage = true
        this.handleMessage(msg)
      }
      log.info('session: query stream ended')
      // 예외 없이 스트림이 닫혔는데 아직 처리할 일이 남아 있으면(워치독 abort, CLI 의 조용한 종료)
      // catch 를 타지 않으므로 여기서 실패 처리한다.
      if (this.diedWithWorkPending()) {
        retrying = this.handleQueryDeath(
          new Error(stalled ? 'stalled before first message' : 'stream ended without a result'),
          stalled
        )
      }
    } catch (err) {
      retrying = this.handleQueryDeath(err, stalled)
    } finally {
      clearTimeout(watchdog)
      this.q = null
      this.abort = null
      // 재시도하지 않는다면 보류해 둔 실패 보고를 여기서 표시한다(result 까지 못 간 경우).
      if (!retrying) this.flushPendingFailure()
      // preflight 버퍼가 어떤 경로로도 방출되지 못했다면 여기서 입력 큐로 옮겨 유실을 막는다.
      // (콜드 resume 의 compact-first 턴이 result 없이 죽으면 사용자 메시지가 버퍼에 갇힌다 —
      //  과거에는 그 메시지가 조용히 사라져, 사용자가 다시 보내야 했다.)
      if (this.preflightPending && this.bufferedMessages.length > 0) this.flushBuffered()
      // 루프가 (예외도, 정상 result 도 없이) 끝났는데 턴이나 백그라운드 워크플로우가 진행 중으로
      // 남아 있으면 — 예: CLI 프로세스가 턴 도중 죽어 스트림이 result 없이 닫힌 경우 — 'running' 에
      // 갇히므로 idle 로 확정한다. 앱은 살아 있어 부팅 시 store 정규화가 닿지 못하는 케이스다.
      // query 가 사라지면 딸린 워크플로우도 더 진행될 수 없으므로 추적 상태를 비운다.
      // 단, resume 폴백으로 재시도하는 경우는 턴이 새 세션에서 계속되므로 idle 로 풀지 않는다.
      if (!retrying && (this.active || this.workflowTasks.size > 0 || this.agentTasks.size > 0)) {
        this.active = false
        this.busy = false
        this.workflowTasks.clear()
        this.clearAgents()
        this.deps.settleIdle()
      }
      // 압축 도중 query 가 죽었다면 진행 배지를 반드시 내린다 — 배지가 켜진 채 남으면 렌더러가
      // 입력창을 잠근 상태로 굳는다(압축 중에는 입력을 막기 때문). 재시도 중이면 압축 턴이 새
      // 프로세스에서 이어지므로 그대로 둔다.
      if (!retrying && this.autoCompactInFlight) {
        this.autoCompactInFlight = false
        this.deps.emit({ type: 'compacting', active: false, trigger: 'auto' })
      }
    }

    // 재시도는 finally 가 this.q 를 비운 뒤에 시작해, 새 query 핸들이 덮어써지지 않게 한다.
    // 입력 큐를 갈아 끼워 아직 처리되지 못한 메시지를 새 query 가 이어받게 한다.
    if (retrying) {
      this.recycleInput()
      this.run()
    }
  }

  /**
   * query 에 넘길 입력 스트림. 큐에서 꺼낸 메시지를 inFlight 에 기록해 두고 흘려보낸다 —
   * 프로세스가 죽었을 때 "SDK 가 이미 꺼내 갔지만 처리되지 못한" 메시지를 되살리기 위함이다.
   */
  private async *promptStream(queue: AsyncQueue<SDKUserMessage>): AsyncGenerator<SDKUserMessage> {
    for await (const msg of queue) {
      this.inFlight.push(msg)
      yield msg
    }
  }

  /**
   * 죽은 query 의 입력 큐를 새 것으로 갈아 끼우고, 처리되지 못한 메시지(inFlight + 미소비분)를
   * 순서대로 되살린다.
   *
   * 큐를 재사용하지 않는 이유: 중단된 소비자(이전 promptStream)가 큐 안에 대기 resolver 를 남겨,
   * 이후 push 한 값이 그 죽은 소비자에게 배달돼 조용히 사라질 수 있다. 큐를 교체하고 옛 큐를
   * 닫으면 그 경로가 원천적으로 없어진다.
   */
  private recycleInput(): void {
    const old = this.input
    const pending = [...this.inFlight, ...old.drain()]
    this.inFlight = []
    old.close()
    this.input = new AsyncQueue<SDKUserMessage>()
    for (const msg of pending) this.input.push(msg)
    if (pending.length) log.info(`session: requeued ${pending.length} unprocessed message(s)`)
  }

  /** 새 턴의 시작 — 산출 여부·API 오류·보류된 실패 카드를 초기화한다. */
  private beginTurn(): void {
    this.turnSawOutput = false
    this.turnError = null
    this.pendingFailureItems = []
  }

  /** 보류해 둔 실패 카드를 이제 사용자에게 표시한다(재시도하지 않기로 확정된 경우). */
  private flushPendingFailure(): void {
    const items = this.pendingFailureItems
    this.pendingFailureItems = []
    for (const item of items) this.emitItem(item)
  }

  /**
   * 실패로 끝난 턴을 프로세스를 갈아 끼워 다시 돌려야 하는지.
   *
   * 원칙: **아무것도 하지 못하고 실패한 턴은 새 프로세스에서 한 번 더 돌려도 안전하다.** 산출이
   * 없었다는 건 도구 실행·파일 편집 같은 부작용도 없었다는 뜻이라 중복이 생기지 않는다. 계정을
   * 바꾼 직후 옛 토큰을 든 프로세스에서 죽은 첫 턴이 정확히 이 경우다.
   */
  private shouldRestartAfterFailedTurn(subtype: string): boolean {
    if (this.turnSawOutput) return false
    if (this.autoRetried || this.interrupted || this.input.isClosed) return false
    // 되살릴 입력이 없으면 재시도해도 의미가 없다. 자동 압축 턴은 기존 로직에 맡긴다.
    if (this.inFlight.length === 0 || this.autoCompactInFlight) return false
    // 원인을 주지 않은 result 실패는 옛 자격증명 프로세스일 수 있어 1회 재시도한다. 반대로
    // assistant.error 로 원인이 주어졌다면 result subtype 과 무관하게 자격증명류만 재시도한다.
    // 특히 session/rate limit 은 프로세스를 바꿔도 풀리지 않으므로 즉시 사용자에게 표시한다.
    if (subtype !== 'success' && this.turnError === null) return true
    return this.turnError !== null && RESTARTABLE_AUTH_ERROR.test(this.turnError)
  }

  /**
   * 지금 도는 query(옛 자격증명을 든 CLI 프로세스)를 끊고, 같은 메시지를 새 프로세스에서 다시
   * 돌리도록 요청한다. 상태는 running 으로 유지해 사용자에게는 하나의 연속된 턴으로 보인다.
   */
  private requestRestart(subtype: string): void {
    this.autoRetried = true
    this.restartRequested = true
    // 지금까지의 대화를 새 프로세스가 그대로 이어받게 한다 — 이 프로세스에서 처음 만들어진
    // 세션이라도 resume 대상으로 승격해, 재시작이 맥락을 잃지 않게 한다.
    if (this.currentSessionId) this.deps.resumeSessionId = this.currentSessionId
    // 보류한 실패 카드는 버린다 — 재시도가 성공하면 사용자가 볼 필요가 없다.
    this.pendingFailureItems = []
    log.warn(
      `session: turn failed before any output (result=${subtype}, error=${this.turnError ?? 'none'}) ` +
        '— restarting the agent process and retrying the message once (session context kept)'
    )
    this.abort?.abort()
    void this.q?.interrupt().catch(() => {})
  }

  /**
   * query 가 끝났는데 아직 처리하지 못한 일이 남아 있는지 — 즉 "죽었다" 고 봐야 하는지.
   *
   * dispose 로 입력 큐를 닫아 정상 종료한 경우와, 애초에 할 일이 없어 끝난 경우(예: /mcp warm-up)는
   * 제외한다. 남은 일이란 진행 중이던 턴(active), 아직 방출되지 않은 preflight 버퍼,
   * 또는 우리가 의도적으로 요청한 프로세스 교체다.
   */
  private diedWithWorkPending(): boolean {
    if (this.input.isClosed) return false
    return this.active || this.bufferedMessages.length > 0 || this.restartRequested
  }

  /**
   * query 가 할 일을 남긴 채 끝난 경우를 처리하고, 새 프로세스로 재시도할지 여부를 돌려준다.
   *
   * 기준은 터미널의 `claude --resume` 과 같은 감각이다 — **CLI 프로세스는 일회용이고, 대화
   * 맥락(sessionId)은 함부로 버리지 않는다.** 처리 순서:
   *
   * 1. **맥락이 실제로 사라진 경우**: resume 대상 트랜스크립트가 디스크에 없음을 확인했을 때만
   *    맥락을 포기하고 새 세션으로 폴백한다(CLI 의 cleanupPeriodDays 정리, 다른 머신 등).
   * 2. **조용한 자동 재시도**: 모델 산출이 하나도 없었다면 부작용도 없으므로, 같은 사용자 메시지를
   *    새 프로세스에서 1회 다시 돌린다. 입력 큐에 메시지가 그대로 남아 있어 새 query 가 이어받는다.
   *    계정 전환 직후 옛 자격증명을 든 프로세스에서 죽은 첫 턴, 콜드 resume 실패가 여기서 흡수돼
   *    사용자가 재전송할 일이 없어진다.
   * 3. **최후의 새 세션 폴백**: 자동 재시도까지 했는데도 첫 메시지 전에 죽는다면 트랜스크립트가
   *    손상됐을 수 있으니, 맥락을 포기하고 새 세션으로 1회 폴백해 사용자가 막히지 않게 한다.
   * 4. **에러 표면화**: 그 외(부분 작업이 이미 진행됨, 워치독 스톨, 재시도 예산 소진)는 명확한
   *    에러 + idle 로 떨어뜨린다. 이때도 sessionId 는 유지해 다음 전송에서 다시 resume 한다.
   */
  private handleQueryDeath(err: unknown, stalled: boolean): boolean {
    // 버퍼링해 둔 사용자 메시지가 있으면 큐로 옮긴다 — 재시도하는 query 나 다음 send 가 이어받도록.
    if (this.preflightPending) this.flushBuffered()

    // 우리가 실패한 턴을 다시 돌리려고 끊은 경우 — 다른 판단 없이 새 프로세스로 이어간다.
    if (this.restartRequested) {
      this.restartRequested = false
      return true
    }

    const resumeId = this.deps.resumeSessionId
    // 사용자가 중단했거나 세션이 dispose 됐으면 어떤 형태로도 다시 띄우지 않는다.
    const canRestart = !this.interrupted && !this.input.isClosed
    // 새 세션 폴백은 "시작 자체가 실패" 한 경우에만 의미가 있다(스톨은 원인이 불확실해 제외).
    const canFallbackFresh =
      canRestart && !stalled && Boolean(resumeId) && !this.sawAnyMessage && !this.resumeRetried

    // ① resume 대상 맥락이 디스크에서 사라진 것을 확인했을 때만 맥락을 포기한다.
    if (canFallbackFresh && !sessionTranscriptExists(this.deps.cwd, resumeId as string)) {
      return this.fallbackToFreshSession('transcript is gone from disk', err)
    }

    // ② 산출이 없었다면(부작용 없음) 같은 메시지로 조용히 1회 자동 재시도한다.
    if (canRestart && !stalled && !this.turnSawOutput && !this.autoRetried) {
      this.autoRetried = true
      log.warn(
        'session: query died before producing any output — restarting once with a fresh process ' +
          '(session context kept; e.g. stale credentials after an account switch)',
        err
      )
      return true
    }

    // ③ 그래도 첫 메시지 전에 죽는다면 트랜스크립트가 손상된 경우일 수 있다 — 최후의 폴백.
    if (canFallbackFresh) {
      return this.fallbackToFreshSession('resume kept failing before the first message', err)
    }

    if (stalled) {
      // resume 은 유지한다 — 원인이 resume 이라고 확정되지 않았고, 정상 동작이기 때문.
      log.error('session: aborted a stuck query before first message (session context kept)')
    } else {
      log.error('session: query errored', err)
    }
    // 보류해 둔 실패 보고가 있으면 함께 표시한다(재시도하지 않기로 확정됐다).
    this.flushPendingFailure()
    this.emitItem({
      id: `error:${Date.now()}`,
      type: 'error',
      text: stalled
        ? 'Restoring the previous session took too long, so the request was cancelled. Please try again — if it keeps happening, use /clear to start this worktree in a fresh session.'
        : clampText(err instanceof Error ? err.message : String(err)),
      ts: Date.now()
    })
    // 턴이 죽었다 — 딸린 백그라운드 워크플로우도 이 query 와 함께 사라지므로 정리하고,
    // busy 플래그도 내려 다음 턴에서 running 이 정상적으로 다시 방출되게 한다.
    this.active = false
    this.busy = false
    this.workflowTasks.clear()
    this.clearAgents()
    this.deps.emit({ type: 'status', status: 'error' })
    return false
  }

  /**
   * 이어받을 대화 맥락을 포기하고 빈 세션으로 1회 재시도한다(맥락 손실을 사용자에게 알린다).
   * 여기까지 오는 경로는 두 가지뿐이다 — 트랜스크립트가 디스크에서 사라진 것을 확인했거나,
   * 자동 재시도까지 했는데도 첫 메시지 전에 계속 죽는 경우(손상 추정)다.
   */
  private fallbackToFreshSession(reason: string, err: unknown): boolean {
    log.warn(`session: giving up resume (${reason}) — falling back to a fresh session`, err)
    this.resumeRetried = true
    this.deps.resumeSessionId = null
    this.emitItem({
      id: `system:resume-fallback:${Date.now()}`,
      type: 'system',
      text: "Couldn't restore the previous session context — continuing in a fresh session.",
      ts: Date.now()
    })
    return true
  }

  /**
   * running/idle 상태를 실제 활동에 맞춰 재계산해 방출한다(변화가 있을 때만).
   *
   * "진행 중" = 사용자/압축 턴이 도는 중(this.active)이거나, **백그라운드 동적 워크플로우가 살아
   * 있는 중**(this.workflowTasks 에 종료되지 않은 실행이 남아 있음)이다. Workflow 도구는 즉시
   * 반환하고 백그라운드로 도므로, 메인 턴이 result 로 끝나 idle 로 가더라도 워크플로우가 계속
   * 돌 수 있다 — 이때 사이드바가 idle 로 보이지 않도록 워크플로우 활동을 상태에 반영한다.
   *
   * 백그라운드로 돌려진 서브에이전트(Ctrl+B)도 같은 이유로 포함한다. 포그라운드 서브에이전트는
   * 애초에 부모 턴을 붙잡고 있어 this.active 가 true 이므로 이 항이 상태를 바꾸지 않는다.
   * 이 불변식 덕분에 "idle 이면 살아 있는 서브에이전트가 없다"가 성립해, 렌더러는 idle 을 보면
   * 목록을 안심하고 비울 수 있다(호스트가 죽어 종료 알림이 아예 오지 않는 경우의 안전망).
   */
  private syncStatus(): void {
    const shouldRun = this.active || this.workflowTasks.size > 0 || this.agentTasks.size > 0
    if (shouldRun === this.busy) return
    this.busy = shouldRun
    this.deps.emit({ type: 'status', status: shouldRun ? 'running' : 'idle' })
  }

  /** 새 일감이 시작됐음을 표시하고 running 을 방출한다(settleTurn 의 뒤늦은 idle 을 무효화한다). */
  private markActive(): void {
    this.active = true
    this.activeSeq++
    this.syncStatus()
  }

  // ── 권한 콜백 ──────────────────────────────────────────────────────────

  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: { title?: string; displayName?: string; decisionReason?: string }
  ): Promise<PermissionResult> => {
    // AskUserQuestion 은 "행위 승인" 대상이 아니라 모델이 사용자에게 답을 요청하는 도구다.
    // permission mode(auto 포함)·세션 always-allow 와 무관하게 항상 질문을 띄우고, 사용자가
    // 고른 답(updatedInput.answers)을 도구 입력에 합쳐 돌려줘야 한다. 자동 승인하면 answers 가
    // 비어 모델이 "사용자가 답하지 않았다" 고 보고 그대로 진행한다.
    if (toolName === 'AskUserQuestion') {
      const decision = await this.deps.requestPermission({
        toolName,
        title: options.title,
        displayName: options.displayName,
        decisionReason: options.decisionReason,
        // 표시용 사본만 클램프한다 — 원본 input 은 아래 allow 분기의 updatedInput 으로 그대로 돌려준다.
        // 클램프하지 않으면 거대한 input(예: 큰 Write 본문)이 IPC 직렬화 경계에서 네이티브 CHECK 를
        // 터뜨려 메인 프로세스를 통째로 abort 시킨다(clamp.ts 참고).
        input: clampInput(input) as Record<string, unknown>
      })

      if (decision.behavior === 'allow') {
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
      }
      return { behavior: 'deny', message: 'User dismissed the question' }
    }

    // ExitPlanMode 는 "이 계획대로 진행할까?" 라는 갈림길이다. 단순 allow/deny 가 아니라
    // 승인 뒤 어떤 권한 모드로 코딩을 시작할지까지 사용자가 고르므로(터미널 Claude Code 와 동일),
    // always-allow·auto 와 무관하게 항상 물어보고 선택에 따라 모드를 전환한다. 이 분기가 없으면
    // plan 모드는 계획만 세우고 빠져나올 길이 없는 막다른 길이 된다.
    if (toolName === 'ExitPlanMode') {
      const decision = await this.deps.requestPermission({
        toolName,
        title: options.title ?? 'Ready to code?',
        displayName: options.displayName,
        decisionReason: options.decisionReason,
        kind: 'plan',
        input: clampInput(input) as Record<string, unknown>,
        options: planOptions(supportsAutoMode(this.deps.model))
      })

      if (decision.behavior === 'allow') {
        this.applyPlanApproval(claudeMode(planApprovalMode(decision.optionId)))
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'deny',
        message:
          'The user wants to keep planning. Do not make any edits yet — refine the plan and ask again.'
      }
    }

    // 셸로 다른 에이전트 제품을 돌리려는 시도는 승인 이전에 되돌린다.
    //
    // 승인 카드로 넘기지 않는 이유: 카드는 "이 명령을 실행할까?" 만 묻는다. 사용자가 원한 것은
    // 대개 "codex 에게 시켜라" 이지 "셸에서 codex 를 돌려라" 가 아니고, 그 차이는 카드에 보이지
    // 않는다. 게다가 fullAccess·auto 에서는 카드 자체가 없어 조용히 지나간다 — 실측에서 모델은
    // 정확히 그 경로로 샜다([[agent/delegateShell]]).
    //
    // 이것은 능력을 뺏는 것이 아니라 **같은 일을 Wooi 안에서 하게** 돌려세우는 것이다. 안내
    // 문장이 부를 도구를 지목하므로 모델은 같은 턴에 이어서 진행할 수 있고, 대안이 없는
    // 워크스페이스에서는 사용자에게 넘기라고 말한다.
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const attempt = delegateShellAttempt(input.command)
      if (attempt) {
        const backends = this.deps.delegateBackends ?? []
        return {
          behavior: 'deny',
          message: delegateShellGuidance(
            attempt,
            backends.includes(attempt),
            this.deps.canSwitchToAgentTeam === true
          )
        }
      }
    }

    // 읽기 전용으로 표시된 Wooi 도구는 묻지 않는다 — 상태를 바꾸지 않으니 승인이 결정할 것이
    // 없고, 매번 카드가 뜨면 정작 물어야 할 도구(워크스페이스 생성처럼 브랜치를 만들고 리포의
    // 셋업 스크립트를 돌리는 것)의 카드가 그 사이에 묻힌다. 나머지 Wooi 도구는 아래의 일반
    // 승인 경로를 그대로 탄다 — 앱을 조작하는 통로에 별도의 우회로를 두지 않는다.
    if (isReadOnlyWooiTool(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // auto 모드: 분류기가 대부분 자동 처리하지만, 위험으로 분류돼 ask 경로로 넘어온 호출도
    // 사용자에게 묻지 않고 자동 승인한다(auto = "묻지 마" 라는 사용자 기대에 맞춤).
    if (this.deps.permissionMode === 'auto') {
      return { behavior: 'allow', updatedInput: input }
    }

    // 사용자가 항상 허용하기로 한 규칙에 걸리면 다시 묻지 않는다. 규칙은 도구 이름이 아니라
    // `Bash(npm run:*)` 처럼 좁은 범위다 — `npm test` 한 번 허용했다고 `rm -rf` 까지 열리지 않는다.
    const rule = ruleForRequest(toolName, input, this.deps.cwd)
    if ([...this.alwaysAllow].some((r) => matchesRule(r, toolName, input, this.deps.cwd))) {
      return { behavior: 'allow', updatedInput: input }
    }

    // 파일을 바꾸는 도구는 무엇이 바뀌는지 diff 로 보여 준다 — 터미널 claude 와 같은 판단 근거다.
    // 도구는 아직 실행 전이므로 디스크 내용이 곧 "before" 다.
    const diff = isFileChangeTool(toolName)
      ? buildFileChangeDiff(toolName, input, this.deps.cwd)
      : null

    const decision = await this.deps.requestPermission({
      toolName,
      title: options.title,
      displayName: options.displayName,
      decisionReason: options.decisionReason,
      ...(diff ? { kind: 'fileChange' as const, diff } : {}),
      rule,
      // 표시용 사본만 클램프한다 — 원본 input 은 allow 분기의 updatedInput 으로 그대로 돌려준다.
      // (거대한 input 이 IPC 직렬화에서 메인을 abort 시키는 것을 막는다. clamp.ts 참고.)
      input: clampInput(input) as Record<string, unknown>
    })

    // allow 분기는 런타임 스키마상 updatedInput(record) 이 필수다(.d.ts 에는 optional 로
    // 표기돼 있으나 CLI 브리지의 Zod 검증은 필수). 원래 입력을 그대로 돌려준다.
    if (decision.behavior === 'allow') {
      if (decision.rememberForSession) this.rememberRule(rule, decision.rememberScope)
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: 'User denied permission' }
  }

  // ── 메시지 → ChatEvent 변환 ────────────────────────────────────────────

  private handleMessage(msg: SDKMessage): void {
    // SDK 가 우리의 send() 없이 새 턴을 시작하는 경우가 있다 — 예: 백그라운드 워크플로우의
    // task_notification 이 모델을 깨워 후속 작업을 돌릴 때. 이때 assistant/stream 출력이 흐르는데도
    // this.active 가 false 라 사이드바가 idle 로 보인다. 모델이 산출(assistant/stream)을 시작했는데
    // 진행 중인 턴으로 표시돼 있지 않으면, 턴이 시작된 것으로 보고 running 을 켠다(뒤이을 result 가
    // this.active 를 내려 idle 로 되돌린다).
    if (msg.type === 'assistant' || msg.type === 'stream_event') {
      // 모델이 산출을 시작했다 — 이 지점 이후로는 도구 실행 등 부작용이 있을 수 있어 실패한 턴을
      // 조용히 다시 돌리지 않는다. 단, error 를 실은 assistant 는 모델 산출이 아니라 API 레벨
      // 실패 보고이므로(관측 확인) 산출로 세지 않는다 — 그래야 자격증명 실패를 재시도로 흡수한다.
      if (msg.type === 'stream_event' || !msg.error) this.turnSawOutput = true
      if (!this.active) {
        this.active = true
        this.syncStatus()
      }
    }

    switch (msg.type) {
      case 'system':
        this.handleSystem(msg)
        break
      case 'stream_event':
        this.handleStreamEvent(msg)
        break
      case 'assistant':
        this.handleAssistant(msg)
        break
      case 'user':
        this.handleUser(msg)
        break
      case 'result':
        this.handleResult(msg)
        break
      default:
        // status / session_state_changed / 기타는 무시.
        break
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>): void {
    if (msg.subtype === 'init') {
      log.info(`session: init received (session_id=${msg.session_id})`)
      this.currentSessionId = msg.session_id
      this.deps.onSessionId(msg.session_id)
      this.deps.emit({ type: 'session', sessionId: msg.session_id, model: msg.model })
      // resume 으로 이어받은 세션은 우리가 보낸 값이 아니라 CLI 가 복원한 모드로 시작할 수 있다.
      this.syncPermissionMode(msg.permissionMode)
      // preflight 는 여기서 돌리지 않는다 — init 은 입력 메시지를 받아야 오는데 preflight 는 그
      // 입력을 붙들고 있어 서로를 기다리게 된다. query 생성 직후(run)로 옮겼다.
    } else if (msg.subtype === 'permission_denied') {
      this.emitItem({
        id: `denied:${msg.tool_use_id}`,
        type: 'system',
        text: `Permission denied: ${msg.tool_name}`,
        ts: Date.now()
      })
    } else if (msg.subtype === 'status') {
      // CLI 가 압축을 시작하면 status='compacting' 을 보낸다(수동 /compact 포함). UI 배지용.
      if (msg.status === 'compacting') this.deps.emit({ type: 'compacting', active: true })
      // 권한 모드가 CLI 쪽에서 바뀌면 status(=null)에 실려 온다 — 모델의 EnterPlanMode 가 대표적.
      this.syncPermissionMode(msg.permissionMode)
    } else if (msg.subtype === 'compact_boundary') {
      // 압축 완료 — 토큰 변화를 기록으로 남기고 진행 배지를 내린다. 자동/수동 모두 여기로 온다.
      const meta = msg.compact_metadata
      const pre = meta?.pre_tokens
      const post = meta?.post_tokens
      const delta =
        typeof pre === 'number' && typeof post === 'number'
          ? ` (${formatTokens(pre)} → ${formatTokens(post)} tokens)`
          : ''
      this.emitItem({
        id: `compacted:${msg.uuid}`,
        type: 'system',
        text: `Compacted conversation${delta}.`,
        ts: Date.now()
      })
      this.deps.emit({ type: 'compacting', active: false, trigger: meta?.trigger })
    } else if (msg.subtype === 'task_started') {
      this.handleTaskStarted(msg)
    } else if (msg.subtype === 'task_progress') {
      this.handleTaskProgress(msg)
    } else if (msg.subtype === 'task_updated') {
      this.handleTaskUpdated(msg)
    } else if (msg.subtype === 'task_notification') {
      this.handleTaskNotification(msg)
    } else if (msg.subtype === 'informational') {
      // 루프가 사람에게 직접 띄우는 한 줄. 훅이 프롬프트를 막은 이유(UserPromptSubmit)나 슬래시
      // 명령 출력이 여기로 온다 — 흘려보내면 "훅이 조용히 아무 일도 안 한" 것처럼 보인다.
      // 'info' 는 CLI 에서도 트랜스크립트에서만 보이는 잡음이라 뺀다.
      if (msg.level !== 'info' && msg.content.trim()) {
        this.emitItem({
          id: `info:${msg.uuid}`,
          type: 'system',
          text: msg.content.trim(),
          ts: Date.now()
        })
      }
    } else if (msg.subtype === 'hook_response') {
      this.handleHookResponse(msg)
    }
  }

  /**
   * 훅 실행 결과. 성공한 훅은 조용히 넘긴다 — 훅은 매 도구 호출마다 돌 수 있어 전부 찍으면 대화가
   * 훅 로그로 뒤덮인다. 죽었거나 0 이 아닌 코드로 끝난 훅만, 터미널처럼 이유(stderr)와 함께 알린다.
   */
  private handleHookResponse(
    msg: Extract<SDKMessage, { type: 'system'; subtype: 'hook_response' }>
  ): void {
    if (msg.outcome !== 'error' && !(msg.exit_code && msg.exit_code !== 0)) return
    const detail = (msg.stderr || msg.output || '').trim().split('\n').slice(0, 3).join(' ')
    const code = typeof msg.exit_code === 'number' ? ` (exit ${msg.exit_code})` : ''
    this.emitItem({
      id: `hook:${msg.hook_id}`,
      type: 'system',
      text: `${msg.hook_event} hook failed${code}${detail ? `: ${detail}` : ''}`,
      ts: Date.now()
    })
  }

  // ── 동적 워크플로우 진행 추적 ─────────────────────────────────────────────
  // 백그라운드 워크플로우 실행을 SDK 의 task_* 시스템 메시지로 추적해, 하나의 진행 카드로
  // 라이브 갱신한다. 워크플로우(task_type==='local_workflow' 또는 workflow_name 존재)만 다루고,
  // 일반 서브에이전트 task 는 기존처럼 도구 카드로 충분하므로 건너뛴다.

  private handleTaskStarted(
    msg: Extract<SDKMessage, { type: 'system'; subtype: 'task_started' }>
  ): void {
    const isWorkflow = msg.task_type === 'local_workflow' || typeof msg.workflow_name === 'string'
    if (!isWorkflow) {
      // 서브에이전트는 트랜스크립트 카드를 만들지 않는다(부모 턴의 tool_use/tool_result 가 이미
      // 남는다) — 사이드바 패널용 휘발성 상태로만 등록한다. skip_transcript 여도 등록한다:
      // 그 플래그는 "인라인 트랜스크립트에서 숨겨라"는 뜻이고, task 패널은 그 대상이 아니다.
      if (typeof msg.subagent_type === 'string') {
        this.agentTasks.set(msg.task_id, {
          taskId: msg.task_id,
          agentType: msg.subagent_type,
          description: msg.description || msg.subagent_type,
          startedAt: Date.now()
        })
        this.emitAgents()
        // 백그라운드로 돌려진 서브에이전트는 메인 턴이 끝난 뒤에도 계속 도므로 running 을 유지한다.
        this.syncStatus()
      }
      return
    }
    // ambient/housekeeping 워크플로우(skip_transcript)는 트랜스크립트에 노출하지 않는다.
    if (msg.skip_transcript) return

    const state: WorkflowTaskState = {
      taskId: msg.task_id,
      name: msg.workflow_name || 'workflow',
      description: msg.description || 'Starting workflow…',
      status: 'running',
      ts: Date.now()
    }
    this.workflowTasks.set(msg.task_id, state)
    this.upsertTask(state, true)
    // 백그라운드 워크플로우가 시작됐다 — 메인 턴이 이미 끝나(idle) 있더라도 사이드바에 진행 중으로
    // 보이도록 running 을 방출한다.
    this.syncStatus()
  }

  private handleTaskProgress(
    msg: Extract<SDKMessage, { type: 'system'; subtype: 'task_progress' }>
  ): void {
    const agent = this.agentTasks.get(msg.task_id)
    if (agent) {
      if (msg.description) agent.description = msg.description
      agent.totalTokens = msg.usage.total_tokens
      agent.toolUses = msg.usage.tool_uses
      if (msg.last_tool_name) agent.lastToolName = msg.last_tool_name
      this.emitAgents()
      return
    }
    const state = this.workflowTasks.get(msg.task_id)
    if (!state) return // 우리가 추적 중인 워크플로우가 아니면 무시.
    if (msg.description) state.description = msg.description
    if (msg.summary) state.summary = msg.summary
    state.totalTokens = msg.usage.total_tokens
    state.toolUses = msg.usage.tool_uses
    // 진행 갱신은 영속화하지 않고 화면만 갱신한다(JSONL 누적 방지). 시작/종료만 디스크에 남긴다.
    this.upsertTask(state, false)
  }

  private handleTaskUpdated(
    msg: Extract<SDKMessage, { type: 'system'; subtype: 'task_updated' }>
  ): void {
    const agent = this.agentTasks.get(msg.task_id)
    if (agent) {
      const p = msg.patch
      if (p.description) agent.description = p.description
      // 'pending'(시작 전)·'paused' 는 아직 살아 있다. 그 외 종료 상태면 목록에서 뺀다.
      const st = p.status
      const terminal = !!st && st !== 'running' && st !== 'pending' && st !== 'paused'
      if (terminal) this.agentTasks.delete(msg.task_id)
      this.emitAgents()
      if (terminal) this.syncStatus()
      return
    }
    const state = this.workflowTasks.get(msg.task_id)
    if (!state) return
    const p = msg.patch
    if (p.description) state.description = p.description
    if (p.error) state.summary = p.error
    if (p.status) {
      // SDK 의 'killed'(사용자 중지)는 'stopped', 'pending'(시작 전)은 'running' 으로 맞춘다.
      state.status =
        p.status === 'killed' ? 'stopped' : p.status === 'pending' ? 'running' : p.status
    }
    const terminal = state.status !== 'running' && state.status !== 'paused'
    this.upsertTask(state, terminal)
    if (terminal) {
      this.workflowTasks.delete(msg.task_id)
      // 마지막 백그라운드 워크플로우가 끝났고 메인 턴도 진행 중이 아니면 idle 로 확정한다.
      this.syncStatus()
    }
  }

  private handleTaskNotification(
    msg: Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>
  ): void {
    if (this.agentTasks.delete(msg.task_id)) {
      this.emitAgents()
      this.syncStatus()
      return
    }
    const state = this.workflowTasks.get(msg.task_id)
    if (!state) return // 추적 중이 아닌 task 의 알림은 무시.
    state.status = msg.status // 'completed' | 'failed' | 'stopped'
    if (msg.summary) state.summary = msg.summary
    if (msg.usage) {
      state.totalTokens = msg.usage.total_tokens
      state.toolUses = msg.usage.tool_uses
      state.durationMs = msg.usage.duration_ms
    }
    this.upsertTask(state, true)
    this.workflowTasks.delete(msg.task_id)
    // 워크플로우 종료 알림 — 남은 백그라운드 작업이 없고 메인 턴도 끝났으면 idle 로 확정한다.
    this.syncStatus()
  }

  /**
   * 현재 서브에이전트 목록 전량을 방출한다(REPLACE 시맨틱).
   *
   * 델타가 아니라 매번 전량을 보내는 게 핵심이다 — 종료 알림 하나가 유실돼도 다음 갱신이나
   * 세션 정리에서 저절로 바로잡히고, 렌더러에 스피너가 영구히 남지 않는다.
   */
  private emitAgents(): void {
    this.deps.emit({ type: 'agents', agents: [...this.agentTasks.values()] })
  }

  /**
   * 추적 중인 서브에이전트를 모두 비우고 빈 목록을 방출한다(query 가 사라진 경로에서 호출).
   *
   * 네이티브 서브에이전트는 CLI 프로세스와 함께 죽으므로 목록만 비우면 되지만, **위임 실행은
   * 별도 프로세스라 그냥 살아남는다.** query 가 사라지면 그 도구 호출의 결과를 돌려줄 곳이
   * 없으므로(고아가 된다) 여기서 함께 끊는다 — 안 그러면 화면에서만 사라진 채 worktree 를
   * 계속 고치는 프로세스가 남는다.
   */
  private clearAgents(): void {
    if (this.agentTasks.size === 0) return
    this.agentTasks.clear()
    this.emitAgents()
  }

  /** 워크플로우 진행 상태를 ChatItem 으로 만들어 (선택적으로) 영속화하고 renderer 로 보낸다. */
  private upsertTask(state: WorkflowTaskState, persist: boolean): void {
    const item: ChatItem = {
      id: `task:${state.taskId}`,
      type: 'task',
      taskId: state.taskId,
      name: state.name,
      description: state.description,
      status: state.status,
      ...(state.summary ? { summary: state.summary } : {}),
      ...(typeof state.totalTokens === 'number' ? { totalTokens: state.totalTokens } : {}),
      ...(typeof state.toolUses === 'number' ? { toolUses: state.toolUses } : {}),
      ...(typeof state.durationMs === 'number' ? { durationMs: state.durationMs } : {}),
      ts: state.ts
    }
    if (persist) this.deps.persist(item)
    this.deps.emit({ type: 'item', item })
  }

  /** stream_event 는 텍스트/사고 과정의 실시간 타이핑에만 사용한다. */
  private handleStreamEvent(msg: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const event = msg.event as {
      type: string
      message?: { id?: string }
      delta?: { type: string; text?: string; thinking?: string }
    }

    if (event.type === 'message_start') {
      this.currentApiMsgId = event.message?.id ?? `msg:${Date.now()}`
      return
    }

    if (event.type === 'content_block_delta' && event.delta) {
      const apiId = this.currentApiMsgId ?? `msg:${Date.now()}`
      if (event.delta.type === 'text_delta' && event.delta.text) {
        this.deps.emit({
          type: 'delta',
          id: `${apiId}:text`,
          itemType: 'assistant',
          text: clampText(event.delta.text)
        })
      } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        this.deps.emit({
          type: 'delta',
          id: `${apiId}:thinking`,
          itemType: 'thinking',
          text: clampText(event.delta.thinking)
        })
      }
    }
  }

  /** 권위 있는 assistant 메시지로 각 블록을 확정·영속화한다. */
  private handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
    const m = msg.message as unknown as { id?: string; content?: Block[] }
    const apiId = m.id ?? msg.uuid
    const blocks = m.content ?? []

    // error 가 실린 assistant 는 모델 산출이 아니라 API 레벨 실패 보고다(설명 텍스트가 함께 온다).
    // 프로세스를 갈아 재시도하면 사용자에게 보일 필요가 없으므로, 표시를 result 시점까지 보류한다.
    if (msg.error) {
      const detail = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n')
      // msg.error 는 SDK 가 아는 코드만 담고 나머지는 'unknown' 이다(관측 확인) — 실제 원인은
      // 함께 오는 설명 텍스트("API Error: 401 …")에 있으므로, 재시도 판단은 둘을 합쳐서 한다.
      this.turnError = `${msg.error} ${detail}`.slice(0, 500)
      this.pendingFailureItems = [
        ...(detail
          ? [
              {
                id: `${apiId}:text`,
                type: 'assistant' as const,
                text: clampText(detail),
                ts: Date.now(),
                streaming: false
              }
            ]
          : []),
        {
          id: `error:${apiId}`,
          type: 'error',
          text: clampText(`Assistant error: ${msg.error}`),
          ts: Date.now()
        }
      ]
      return
    }

    for (const block of blocks) {
      if (block.type === 'text') {
        this.emitItem({
          id: `${apiId}:text`,
          type: 'assistant',
          text: clampText(String(block.text ?? '')),
          ts: Date.now(),
          streaming: false
        })
      } else if (block.type === 'thinking') {
        this.emitItem({
          id: `${apiId}:thinking`,
          type: 'thinking',
          text: clampText(String(block.thinking ?? '')),
          ts: Date.now(),
          streaming: false
        })
      } else if (block.type === 'tool_use') {
        const name = String(block.name)
        // assistant 메시지는 도구 실행 **전**에 도착하므로, 이 시점의 디스크 내용이 곧 변경 전 상태다.
        // 여기서 diff 를 떠 두지 않으면 나중엔 이미 적용된 뒤라 되살릴 수 없다.
        const diff = isFileChangeTool(name)
          ? buildFileChangeDiff(name, block.input ?? {}, this.deps.cwd)
          : null
        this.emitItem({
          id: `${apiId}:tool:${String(block.id)}`,
          type: 'tool_use',
          toolId: String(block.id),
          name,
          input: clampInput(block.input ?? {}),
          ...(diff ? { diff: clampText(diff) } : {}),
          ts: Date.now()
        })
      } else {
        this.noticeUnknown(`content block "${String(block.type)}"`)
      }
    }
  }

  /**
   * 해석하지 못한 입력을 사용자에게 한 번만 알린다(Codex 쪽 CodexThread.notice 와 같은 규약).
   * 버리는 동작은 유지한다 — 여기서 throw 하면 대화가 멈춘다. 버리되 흔적을 남기는 게 목적이다.
   */
  private noticeUnknown(what: string, hint?: string): void {
    if (this.warned.has(what)) return
    this.warned.add(what)
    log.warn(`claude: unmapped ${what} — ignoring (Claude Code may be newer than this Wooi build)`)
    this.emitItem({
      id: unknownItemId('claude', what),
      type: 'unknown',
      backend: 'claude',
      what,
      ...(hint ? { hint } : {}),
      ts: Date.now()
    })
  }

  /** user 메시지(프롬프트 echo 또는 tool_result 블록)를 처리한다. */
  private handleUser(msg: Extract<SDKMessage, { type: 'user' }>): void {
    const content = (msg.message as { content?: unknown }).content

    // 프롬프트 echo(문자열이거나 tool_result 가 아닌 블록들)면 /rewind 체크포인트로 기록한다.
    // tool_result 가 섞인 user 메시지(도구 응답)는 제외하고, 우리가 보낸 실제 사용자 메시지
    // (pendingUserTexts 에 라벨을 미리 넣어 둔 것)만 uuid 와 짝지어 확정한다 — 자동 /compact
    // 주입은 pendingUserTexts 에 라벨이 없으므로 자연히 걸러진다.
    const uuid = (msg as { uuid?: string }).uuid
    const isToolResult =
      Array.isArray(content) && content.some((b) => (b as Block).type === 'tool_result')
    if (uuid && !isToolResult && this.pendingUserTexts.length > 0) {
      const text = this.pendingUserTexts.shift()
      // null 은 silent 전송의 자리표다 — 화면에 없는 메시지로 되돌아갈 수는 없으니 체크포인트를
      // 만들지 않는다. 그래도 **자리는 차지해야** 한다: 빼 버리면 그 echo 가 뒤따라오는 진짜
      // 사용자 메시지의 라벨을 가져가, 라벨과 되돌아갈 지점이 한 칸씩 어긋난다.
      if (text != null) {
        this.checkpoints.push({ userMessageId: uuid, text, ts: Date.now() })
        // 메모리 상한 — 아주 긴 세션에서도 목록이 무한정 커지지 않게 한다(최근 100개 유지).
        if (this.checkpoints.length > 100) this.checkpoints.shift()
      }
    }

    // 다른 Claude Code 세션이 보낸 메시지(네이티브 cross-session messaging). CLI 는 이것을
    // 사용자 메시지로 모델에게 넘기는데, Wooi 는 보낸 적이 없으므로 **아무도 트랜스크립트에
    // 남기지 않는다** — 그대로 두면 사용자에게는 에이전트가 난데없이 다른 일을 시작한 것으로
    // 보인다. 여기서 출처를 밝혀 기록한다.
    //
    // 앱 안의 peer 메시지는 이 경로로 오지 않는다 — 그쪽은 Wooi 가 직접 넣으므로 origin 이
    // 'human' 이고, 보내는 순간 이미 사용자 항목으로 기록된다([[agent/tools/peer]]).
    const origin = msg.origin
    if (origin?.kind === 'peer') {
      const from = origin.name?.trim() || origin.from
      const body = origin.body ?? textOf(content)
      this.emitItem({
        id: `peer:${uuid ?? Date.now()}`,
        type: 'system',
        text: `Message from ${from} (another Claude Code session)\n\n${clampText(body)}`,
        ts: Date.now()
      })
    }

    if (!Array.isArray(content)) return

    for (const block of content as Block[]) {
      if (block.type === 'tool_result') {
        this.emitItem({
          id: `toolresult:${String(block.tool_use_id)}`,
          type: 'tool_result',
          toolId: String(block.tool_use_id),
          text: clampText(normalizeToolResult(block.content)),
          isError: Boolean(block.is_error),
          ts: Date.now()
        })
      }
    }
  }

  private handleResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
    log.info(`session: result received (subtype=${msg.subtype}, turns=${msg.num_turns})`)

    // CLI 가 이 턴에 fast mode 를 실제로 썼는지 알려 준다(설정과 다를 수 있다 — 미지원 모델·플랜
    // 제한이면 'off', fast 전용 rate limit 을 넘겼으면 'cooldown').
    this.reportFastModeState(msg.fast_mode_state, msg.fast_mode_disabled_reason)

    // 자격증명 문제로 아무것도 못 하고 끝난 턴이면, 사용자에게 오류를 보이는 대신 프로세스를
    // 갈아 끼워 같은 메시지를 다시 돌린다(터미널에서 CLI 를 재시작하는 것과 같은 처방).
    // inFlight 를 비우지 않고 running 도 유지해, 사용자 눈에는 하나의 연속된 턴으로 보인다.
    if (this.shouldRestartAfterFailedTurn(msg.subtype)) {
      this.requestRestart(msg.subtype)
      return
    }

    // 사용량 제한으로 끝난 턴은 **설정과 무관하게** 메인에 알린다 — 자동 이어가기가 꺼져 있어도
    // 사이드바가 "제한 때문에 멈췄다" 를 보여 줘야 하기 때문이다. beginTurn 이 turnError 를
    // 비우므로, 문구가 알려 준 해제 시각은 그 전에 뽑아 둔다.
    const rateLimited = Boolean(this.turnError && RATE_LIMIT_ERROR.test(this.turnError))
    const resetAt = rateLimited ? rateLimitResetAt(this.turnError, Date.now()) : null
    if (rateLimited && this.deps.autoResumeAfterRateLimit) {
      // 이어가기를 예약할 때는 실패 카드를 띄우지 않는다 — 사용자에게는 "잠시 멈췄다가 이어감"
      // 한 흐름으로 보여야 한다.
      this.pendingFailureItems = []
      this.beginTurn()
      this.inFlight.shift()
      this.deps.onSessionId(msg.session_id)
      this.active = false
      this.busy = false
      this.deps.onRateLimit?.(resetAt ?? undefined)
      this.deps.settleIdle()
      return
    }
    if (rateLimited) this.deps.onRateLimit?.(resetAt ?? undefined)

    // 보류해 둔 실패 보고가 있으면(재시도하지 않기로 확정) 이제 표시하고, 턴 상태를 닫는다.
    this.flushPendingFailure()
    this.beginTurn()
    // 이 result 가 대응하는 입력 메시지는 처리를 마쳤다 — 재시도 시 되살릴 목록에서 뺀다.
    this.inFlight.shift()
    // 턴이 result 까지 도달했다 — 자동 재시도 예산을 되돌려 다음 턴이 다시 1회를 쓸 수 있게 한다.
    if (msg.subtype === 'success') this.autoRetried = false
    this.deps.onSessionId(msg.session_id)
    this.emitItem({
      id: `result:${msg.uuid}`,
      type: 'result',
      subtype: msg.subtype,
      isError: msg.subtype !== 'success',
      durationMs: msg.duration_ms,
      numTurns: msg.num_turns,
      costUsd: msg.total_cost_usd,
      ts: Date.now()
    })

    // 방금 끝난 게 우리가 주입한 자동 압축 턴이라면, 재평가하지 않고 플래그만 풀어 준다
    // (압축 직후 result 의 토큰은 요약 생성분이라 다시 임계치를 넘길 수 있어 루프가 된다).
    const wasAutoCompact = this.autoCompactInFlight
    if (wasAutoCompact) {
      this.autoCompactInFlight = false
      this.deps.emit({ type: 'compacting', active: false, trigger: 'auto' })
    }

    // 방금 끝난 게 preflight 의 compact-first 턴이라면, idle 로 가지 않고 버퍼링해 둔 사용자 첫
    // 메시지를 이제 방출한다 — 사용자 턴이 압축된(작은) 맥락 위에서 돌아 큰 패스를 1회로 줄인다.
    // 상태는 running 으로 유지하고(active 그대로), 곧 이어질 사용자 턴의 result 가 idle 로 푼다.
    if (wasAutoCompact && this.preflightPending && this.bufferedMessages.length > 0) {
      this.flushBuffered()
      return
    }

    // 턴을 닫는다 — 자동 압축이 필요한지 먼저 확인하고, 압축을 시작하지 않을 때만 idle 로 간다.
    // 미터는 성공 턴마다 갱신하되(압축 직후의 줄어든 수치도 반영해야 한다), 압축 트리거는 압축
    // 턴 직후엔 건너뛴다 — 그 result 의 토큰은 요약 생성분이라 다시 임계치를 넘겨 루프가 된다.
    void this.settleTurn({
      refreshUsage: msg.subtype === 'success',
      allowAutoCompact: !wasAutoCompact
    })
  }

  /**
   * 턴 종료를 확정한다 — **자동 압축 여부를 정한 뒤에** idle 을 방출한다.
   *
   * idle 을 먼저 방출하면 안 되는 이유: 렌더러는 idle 을 보는 즉시 대기 큐(사용자가 턴 도중 보낸
   * 후속 메시지)를 흘려보낸다. 예전처럼 idle → (비동기) 컨텍스트 확인 → /compact 순서면 그 사이에
   * 후속 메시지가 **압축 전(거의 가득 찬) 맥락 위에서** 새 턴을 열어 버린다. 자동 압축이 막으려던
   * 바로 그 상황이고, 게다가 autoCompactInFlight 가 사용자 턴과 겹쳐 배지·플래그가 어긋난다.
   *
   * 그래서 압축이 필요하면 active 를 유지한 채(=running) /compact 만 흘려보낸다. 대기 큐는 압축
   * 턴의 result 로 진짜 idle 이 될 때까지 그대로 남아 있다가, 압축된 맥락 위에서 이어서 실행된다
   * (Claude Code CLI 와 같은 순서). 확인이 실패/타임아웃이면 압축 없이 idle 로 폴백한다.
   *
   * 압축이 일어날 수 없는 턴(실패 턴·압축 턴 직후·autoCompact off)은 미터 갱신을 기다리지 않고
   * 곧바로 idle 로 가므로 지연이 없다.
   */
  private async settleTurn(opts: {
    refreshUsage: boolean
    allowAutoCompact: boolean
  }): Promise<void> {
    const mayCompact = opts.refreshUsage && opts.allowAutoCompact && this.deps.autoCompact
    if (mayCompact) {
      const seq = this.activeSeq
      if (await this.refreshContextUsage({ allowAutoCompact: true })) return
      // 확인을 기다리는 동안 새 턴이 시작됐다면(사용자 메시지·재시작) 그 턴이 상태를 소유한다.
      if (this.activeSeq !== seq) return
    } else if (opts.refreshUsage) {
      // 압축으로 이어질 수 없는 갱신이라 idle 을 붙잡아 둘 이유가 없다 — 미터는 뒤늦게 따라온다.
      void this.refreshContextUsage({ allowAutoCompact: false })
    }

    // 메인 턴은 끝났지만, Workflow 도구로 띄운 백그라운드 워크플로우가 아직 돌고 있으면 idle 로
    // 가지 않고 running 을 유지한다(syncStatus 가 판단). 마지막 워크플로우가 끝나는 시점에 idle 로
    // 확정된다. 백그라운드 작업이 없으면 평소처럼 곧바로 idle.
    this.active = false
    this.syncStatus()
  }

  /**
   * 상태줄 컨텍스트 미터를 SDK 의 getContextUsage 로 갱신한다.
   *
   * /context 카드와 **같은 출처**(getContextUsage)를 써서 미터 수치가 /context 와 항상
   * 일치하게 한다. 과거에는 result 의 modelUsage 를 `used / contextWindow`(전체 윈도 대비
   * 평평한 %)로 직접 계산했는데, Claude Code 는 `(윈도 − 출력 버퍼)` 기준 + 보정 로직으로
   * 퍼센트를 내므로 둘이 크게 어긋났다(미터가 /context 보다 한참 낮게 표시).
   *
   * 라이브 쿼리가 없거나 제어 응답이 실패하면 미터는 이전 값을 유지한다.
   *
   * @returns 자동 압축을 시작했으면 true(호출부는 턴을 idle 로 내리지 말고 running 을 유지해야 한다).
   */
  private async refreshContextUsage(opts: { allowAutoCompact: boolean }): Promise<boolean> {
    const q = this.q
    if (!q) return false

    let ctx: ContextUsage
    try {
      ctx = await withTimeout(q.getContextUsage(), CONTEXT_USAGE_TIMEOUT_MS)
    } catch {
      return false
    }

    const max = ctx.maxTokens || 0
    if (max <= 0) return false

    // getContextUsage 의 percentage 는 0~100 스케일. 미터/스토어는 0~1 fraction 을 기대한다.
    const fraction = Math.min(1, Math.max(0, ctx.percentage / 100))
    this.deps.emit({
      type: 'context',
      usedTokens: ctx.totalTokens,
      maxTokens: max,
      percentage: fraction
    })

    // 임계치를 넘었으면 다음 턴 전에 자동으로 압축한다(Claude Code CLI 의 auto-compact).
    // 임계치는 고정 퍼센트가 아니라 Claude Code 가 알려준 값을 그대로 쓴다(overAutoCompactThreshold).
    if (opts.allowAutoCompact && this.deps.autoCompact && overAutoCompactThreshold(ctx)) {
      return this.triggerAutoCompact()
    }
    return false
  }

  /**
   * 입력 큐에 /compact 를 흘려보내 대화를 압축한다. 턴 종료 직후(아직 idle 을 방출하기 전)에만
   * 호출한다 — 상태는 running 을 유지해, 렌더러의 대기 큐가 압축 전 맥락으로 새 턴을 열지 못하게 한다.
   *
   * @returns 압축을 시작했으면 true.
   */
  private triggerAutoCompact(): boolean {
    if (this.autoCompactInFlight || !this.q) return false
    this.autoCompactInFlight = true

    // 임계치 수치를 드러내지 않도록 퍼센트 없이 일반 문구로 안내한다.
    this.emitItem({
      id: `compacting:${Date.now()}`,
      type: 'system',
      text: 'Auto-compacting conversation to free up space…',
      ts: Date.now()
    })
    this.deps.emit({ type: 'compacting', active: true, trigger: 'auto' })
    this.markActive()

    this.input.push({
      type: 'user',
      message: { role: 'user', content: '/compact' },
      parent_tool_use_id: null
    })
    return true
  }

  /** 항목을 영속화하고 renderer 로 보낸다. */
  private emitItem(item: ChatItem): void {
    this.deps.persist(item)
    this.deps.emit({ type: 'item', item })
  }

  /**
   * CLI 가 보고한 fast mode 실제 상태를 렌더러로 흘려보내고, 사용자가 알아야 할 전환만 안내한다.
   *
   * 설정(deps.fastMode)과 실제 상태는 다를 수 있다 — fast mode 는 지원 모델·유료 플랜이 필요하고,
   * fast 전용 rate limit 을 넘기면 쿨다운 동안 표준 속도로 내려간다. 조용히 느려지면 원인을 알 수
   * 없으므로 전환 시점에만(중복 없이) 트랜스크립트에 한 줄 남긴다.
   */
  private reportFastModeState(
    state: FastModeState | undefined,
    reason: FastModeDisabledReason | undefined
  ): void {
    if (!state || state === this.lastFastModeState) return
    const prev = this.lastFastModeState
    this.lastFastModeState = state
    this.deps.emit({ type: 'fastMode', state, ...(reason ? { reason } : {}) })

    if (state === 'cooldown') {
      this.emitItem({
        id: `fastmode:cooldown:${Date.now()}`,
        type: 'system',
        text: 'Fast mode hit its rate limit — running at standard speed until it resets.',
        ts: Date.now()
      })
    } else if (state === 'on' && prev === 'cooldown') {
      this.emitItem({
        id: `fastmode:on:${Date.now()}`,
        type: 'system',
        text: 'Fast mode is available again.',
        ts: Date.now()
      })
    } else if (state === 'off' && this.deps.fastMode && !this.notedFastModeOff) {
      // 켜 두었는데 한 번도 켜지지 않는 경우(미지원 모델·플랜/크레딧 없음·서드파티 경유)는 세션당 1회만.
      this.notedFastModeOff = true
      this.emitItem({
        id: `fastmode:off:${Date.now()}`,
        type: 'system',
        text: `Fast mode is enabled in Wooi but is not active. ${fastModeReasonText(reason)}`,
        ts: Date.now()
      })
    }
  }
}

/** 체크포인트 라벨용으로 메시지의 첫 줄만 추려 길이를 제한한다. */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > 80 ? line.slice(0, 79) + '…' : line || '(message)'
}

/** 토큰 수를 1.2k / 45k / 1.0M 처럼 짧게 표기한다(압축 전후 안내 문구용). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** tool_result 의 content(string | 블록 배열)를 표시용 텍스트로 정규화한다. */
/**
 * user 메시지 content 에서 사람이 읽을 본문만 뽑는다.
 *
 * 네이티브 peer 메시지의 폴백 경로에만 쓴다 — SDK 가 봉투를 벗긴 `origin.body` 를 주면 그쪽이
 * 언제나 정확하고(도착한 것과 바이트 단위로 같다), 이건 옛 발신자라 그 필드가 없을 때만 쓴다.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('\n')
}

function normalizeToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && 'text' in b) return String((b as { text: unknown }).text)
        return JSON.stringify(b)
      })
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content, null, 2)
}
