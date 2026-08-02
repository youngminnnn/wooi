import type { ChatEvent, ChatItem, PermissionRequest } from '@shared/types'
import { clampText } from '../claude/clamp'
import { NOTIFY, type CodexDecision, type ThreadItem } from './wire'
import type {
  CommandApprovalParams,
  DeltaParams,
  ItemParams,
  PlanUpdatedParams,
  RequestUserInputParams,
  FileChangeApprovalParams,
  TokenUsageParams,
  TurnParams,
  WarningParams
} from './wire'

/**
 * app-server 알림 → Wooi 의 ChatEvent/ChatItem 변환.
 *
 * **순수 로직만** 둔다(I/O·프로세스 없음). 프로토콜이 바뀌면 여기 테스트가 먼저 깨지도록,
 * 그리고 실제 codex 없이도 전체 렌더링 경로를 검증할 수 있도록 분리한 계층이다.
 *
 * 설계 원칙 — **모르는 것은 조용히 무시한다.** codex 는 우리가 고정할 수 없는 사용자 설치본이라
 * 새 아이템 타입·새 알림이 언제든 들어온다. 그때 throw 하면 대화가 통째로 멈추므로, 매핑하지
 * 못한 입력은 null/빈 배열로 흘려보내고 로깅만 한다.
 */

/** 한 알림이 만들어 낸 결과. events 는 렌더러로 방송하고, persist 는 트랜스크립트에 남긴다. */
export interface Mapped {
  events: ChatEvent[]
  /** 영속해야 하는 확정 아이템(진행 중 스냅샷은 events 로만 흘린다). */
  persist: ChatItem[]
}

const NOTHING: Mapped = { events: [], persist: [] }

/**
 * 변환에 필요한 최소 상태.
 *
 * 대부분의 매핑은 무상태지만, 명령 실행만은 출력이 조각으로 오는데 Wooi 의 bash 카드는 매번
 * **전체 출력**을 담은 아이템으로 upsert 된다. 그래서 itemId 별 출력 버퍼가 필요하다.
 */
export interface MapperState {
  /** codex itemId → 지금까지 누적된 명령 출력. */
  output: Map<string, string>
  /** codex itemId → 그 명령 카드의 마지막 스냅샷(출력 외 필드 보존용). */
  command: Map<string, { command: string; cwd?: string }>
}

export function createMapperState(): MapperState {
  return { output: new Map(), command: new Map() }
}

/** Wooi 아이템 id. codex id 와 충돌하지 않도록 접두사를 붙인다. */
function itemId(id: string | undefined, fallback: string): string {
  return `codex:${id ?? fallback}`
}

/**
 * 알림 하나를 변환한다. 모르는 메서드·모양이면 빈 결과를 돌려준다(throw 하지 않는다).
 *
 * @param onUnknown 매핑하지 못한 입력을 한 번만 로깅하기 위한 훅(선택).
 */
export function mapNotification(
  method: string,
  params: unknown,
  state: MapperState,
  onUnknown?: (what: string) => void
): Mapped {
  const ts = Date.now()

  switch (method) {
    case NOTIFY.threadStarted: {
      const p = params as { threadId?: string }
      if (!p?.threadId) return NOTHING
      // Wooi 는 resume 토큰을 workspace.sessionId 에 담는다 — codex 는 그게 threadId 다.
      return { events: [{ type: 'session', sessionId: p.threadId }], persist: [] }
    }

    case NOTIFY.turnStarted:
      return { events: [{ type: 'status', status: 'running' }], persist: [] }

    case NOTIFY.turnCompleted:
    case NOTIFY.turnFailed:
      return mapTurnEnd(params as TurnParams, ts)

    case NOTIFY.itemStarted:
    case NOTIFY.itemCompleted:
      return mapItem(method, params as ItemParams, state, ts, onUnknown)

    case NOTIFY.agentMessageDelta: {
      const p = params as DeltaParams
      if (!p?.delta) return NOTHING
      return {
        events: [
          { type: 'delta', id: itemId(p.itemId, 'assistant'), itemType: 'assistant', text: p.delta }
        ],
        persist: []
      }
    }

    case NOTIFY.reasoningSummaryDelta:
    case NOTIFY.reasoningTextDelta: {
      const p = params as DeltaParams
      const text = p?.delta ?? p?.chunk
      if (!text) return NOTHING
      return {
        events: [{ type: 'delta', id: itemId(p.itemId, 'reasoning'), itemType: 'thinking', text }],
        persist: []
      }
    }

    case NOTIFY.commandOutputDelta:
      return mapCommandOutput(params as DeltaParams, state, ts)

    case NOTIFY.tokenUsage:
      return mapTokenUsage(params as TokenUsageParams)

    case NOTIFY.turnPlanUpdated:
      return mapPlan(params as PlanUpdatedParams, ts)

    case NOTIFY.error: {
      const p = params as { error?: { message?: string; codexErrorInfo?: string } }
      const text = errorText(p?.error)
      if (!text) return NOTHING
      const item: ChatItem = { id: `codex:error:${ts}`, type: 'error', text, ts }
      return { events: [{ type: 'item', item }], persist: [item] }
    }

    case NOTIFY.warning:
    case NOTIFY.configWarning: {
      const p = params as WarningParams
      const text = p?.message ?? p?.summary
      if (!text) return NOTHING
      const item: ChatItem = { id: `codex:warn:${ts}`, type: 'system', text, ts }
      return { events: [{ type: 'item', item }], persist: [item] }
    }

    default:
      // 구독하지 않는 알림(계정·rate limit·MCP 상태 등)은 상위 계층이 따로 처리한다.
      return NOTHING
  }
}

// ── 턴 종료 ─────────────────────────────────────────────────────────────

function mapTurnEnd(params: TurnParams, ts: number): Mapped {
  const turn = params?.turn
  const status = turn?.status
  const failed = status === 'failed'

  const events: ChatEvent[] = []
  const persist: ChatItem[] = []

  if (failed) {
    const text = errorText(turn?.error) ?? 'The turn failed.'
    const item: ChatItem = { id: `codex:error:${ts}`, type: 'error', text, ts }
    events.push({ type: 'item', item })
    persist.push(item)
  }

  // 턴 요약 카드. Codex 는 USD 원가를 주지 않으므로 costUsd 를 생략한다(UI 가 비용을 감춘다).
  const result: ChatItem = {
    id: `codex:result:${turn?.id ?? ts}`,
    type: 'result',
    subtype: status ?? 'completed',
    isError: failed,
    durationMs: 0,
    numTurns: 1,
    ts
  }
  events.push({ type: 'item', item: result })
  persist.push(result)
  events.push({ type: 'status', status: failed ? 'error' : 'idle' })

  return { events, persist }
}

/** 오류 payload 를 사람이 읽을 문장으로. 분류 코드가 있으면 실행 가능한 안내를 덧붙인다. */
function errorText(error?: { message?: string; codexErrorInfo?: string }): string | null {
  if (!error) return null
  const base = error.message?.trim()
  const hint = ERROR_HINTS[error.codexErrorInfo ?? '']
  if (!base) return hint ?? null
  return hint ? `${base}\n\n${hint}` : base
}

/**
 * codex 의 오류 분류에 붙이는 안내. 원문만으로는 사용자가 뭘 해야 할지 모르는 경우만 추린다.
 * 모르는 분류는 안내 없이 원문만 보여 준다.
 */
const ERROR_HINTS: Record<string, string> = {
  UsageLimitExceeded: 'Your ChatGPT usage limit is reached. Check /usage for when it resets.',
  SessionBudgetExceeded: 'This session hit its token budget. Start a new session to continue.',
  ContextWindowExceeded: 'The conversation outgrew the context window. Try /compact.',
  Unauthorized: 'Codex is not signed in. Connect your account in Settings → Integrations.'
}

// ── 아이템 ──────────────────────────────────────────────────────────────

function mapItem(
  method: string,
  params: ItemParams,
  state: MapperState,
  ts: number,
  onUnknown?: (what: string) => void
): Mapped {
  const item = params?.item
  if (!item?.type) return NOTHING
  const done = method === NOTIFY.itemCompleted
  const id = itemId(item.id, `${item.type}:${ts}`)

  switch (item.type) {
    // 사용자 메시지는 Wooi 가 이미 로컬에서 에코했다 — 다시 넣으면 중복으로 보인다.
    case 'userMessage':
      return NOTHING

    case 'agentMessage': {
      const chat: ChatItem = {
        id,
        type: 'assistant',
        text: item.text ?? '',
        ts,
        ...(done ? {} : { streaming: true })
      }
      // 진행 중 스냅샷은 화면에만, 확정된 것만 트랜스크립트에 남긴다.
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    case 'reasoning': {
      const text = reasoningText(item)
      const chat: ChatItem = {
        id,
        type: 'thinking',
        text,
        ts,
        ...(done ? {} : { streaming: true })
      }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    case 'commandExecution':
      return mapCommandItem(item, id, done, state, ts)

    case 'fileChange':
      return mapFileChange(item, id, done, ts)

    case 'mcpToolCall':
      return mapTool(
        id,
        `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`,
        item.arguments,
        item,
        done,
        ts
      )

    /**
     * Codex 의 서브에이전트 조율(spawn_agent·send_input·wait·close_agent 등).
     *
     * 사이드바의 "실행 중 에이전트" 패널까지 채우려면 수명주기 의미(agentStatus 값 등)를 알아야
     * 하는데 확인하지 못했다 — 추측해 넣기보다 대화에 도구 호출로만 보여 준다. 그것만으로도
     * "지금 서브에이전트를 돌리고 있다"는 사실은 드러나고, 조용히 사라지지는 않는다.
     */
    case 'collabToolCall':
      return mapTool(id, item.tool ?? 'agent', { prompt: item.prompt }, item, done, ts)

    case 'webSearch':
      return mapTool(id, 'WebSearch', { query: item.query }, item, done, ts)

    case 'imageView':
      return mapTool(id, 'ViewImage', { path: (item as { path?: string }).path }, item, done, ts)

    case 'plan': {
      // 플랜 모드의 산출물 — 본문 그대로 어시스턴트 메시지로 보여 준다.
      const chat: ChatItem = { id, type: 'assistant', text: item.text ?? '', ts }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    case 'contextCompaction':
      // 압축은 codex 가 자동으로도 한다. 배지만 띄우고 대화에는 아무것도 남기지 않는다.
      return { events: [{ type: 'compacting', active: !done, trigger: 'auto' }], persist: [] }

    case 'error': {
      const text = item.message ?? item.text
      if (!text) return NOTHING
      const chat: ChatItem = { id, type: 'error', text, ts }
      return { events: [{ type: 'item', item: chat }], persist: [chat] }
    }

    case 'enteredReviewMode':
    case 'exitedReviewMode': {
      const text =
        item.text ?? (item.type === 'enteredReviewMode' ? 'Review started' : 'Review finished')
      const chat: ChatItem = { id, type: 'system', text, ts }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    default:
      // 새 아이템 타입이 생겨도 대화는 계속돼야 한다.
      onUnknown?.(`item type "${item.type}"`)
      return NOTHING
  }
}

/** reasoning 아이템의 텍스트. summary 는 배열로 오기도 하고 문자열로 오기도 한다. */
function reasoningText(item: ThreadItem): string {
  if (Array.isArray(item.summary)) return item.summary.join('\n\n')
  if (typeof item.summary === 'string') return item.summary
  if (typeof item.content === 'string') return item.content
  return item.text ?? ''
}

// ── 명령 실행 ───────────────────────────────────────────────────────────

/**
 * codex 의 commandExecution 을 Wooi 의 `bash` 카드로 옮긴다.
 *
 * `bash` 를 재사용하는 이유: 이 카드가 이미 "실행 중 출력이 자라고, 끝나면 종료 코드로 확정"되는
 * upsert 렌더링을 지원한다. tool_use/tool_result 로 옮기면 라이브 출력을 새로 만들어야 한다.
 * 사용자의 `!명령` 과 구분은 `agent: true` 플래그가 한다.
 */
function mapCommandItem(
  item: ThreadItem,
  id: string,
  done: boolean,
  state: MapperState,
  ts: number
): Mapped {
  const key = item.id ?? id
  if (item.command) state.command.set(key, { command: item.command, cwd: item.cwd })
  const meta = state.command.get(key)

  // 확정 시엔 서버가 준 전체 출력이 정본이다. 진행 중엔 델타로 쌓아 온 버퍼를 쓴다.
  const output = done
    ? (item.aggregatedOutput ?? state.output.get(key) ?? '')
    : (state.output.get(key) ?? '')

  const chat: ChatItem = {
    id,
    type: 'bash',
    agent: true,
    command: meta?.command ?? item.command ?? '',
    cwd: meta?.cwd,
    // 대용량 출력이 IPC 직렬화를 터뜨리지 않도록 Claude 경로와 같은 상한을 적용한다.
    output: clampText(output),
    exitCode: done ? (item.exitCode ?? (item.status === 'declined' ? -1 : null)) : null,
    running: !done,
    ts
  }

  if (done) state.output.delete(key)
  if (done) state.command.delete(key)

  return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
}

function mapCommandOutput(params: DeltaParams, state: MapperState, ts: number): Mapped {
  const key = params?.itemId
  const chunk = params?.delta ?? params?.chunk
  if (!key || !chunk) return NOTHING

  const next = (state.output.get(key) ?? '') + chunk
  state.output.set(key, next)

  const meta = state.command.get(key)
  const chat: ChatItem = {
    id: itemId(key, 'command'),
    type: 'bash',
    agent: true,
    command: meta?.command ?? '',
    cwd: meta?.cwd,
    output: clampText(next),
    exitCode: null,
    running: true,
    ts
  }
  // 진행 중 스냅샷은 화면에만 — 확정 아이템이 뒤이어 트랜스크립트에 남는다.
  return { events: [{ type: 'item', item: chat }], persist: [] }
}

// ── 파일 변경 · 도구 ────────────────────────────────────────────────────

function mapFileChange(item: ThreadItem, id: string, done: boolean, ts: number): Mapped {
  const changes = item.changes ?? []
  const paths = changes.map((c) => c.path).filter(Boolean)
  const use: ChatItem = {
    id,
    type: 'tool_use',
    toolId: id,
    name: 'Apply patch',
    input: { paths, changes },
    ts
  }
  if (!done) return { events: [{ type: 'item', item: use }], persist: [] }

  const failed = item.status === 'failed' || item.status === 'declined'
  const summary =
    item.status === 'declined'
      ? 'Change declined.'
      : failed
        ? 'Patch failed.'
        : `Updated ${paths.length} file${paths.length === 1 ? '' : 's'}:\n${paths.join('\n')}`
  const result: ChatItem = {
    id: `${id}:result`,
    type: 'tool_result',
    toolId: id,
    text: summary,
    isError: failed,
    ts
  }
  return {
    events: [
      { type: 'item', item: use },
      { type: 'item', item: result }
    ],
    persist: [use, result]
  }
}

/** MCP 호출·웹 검색처럼 "도구를 썼다"로 보여 주면 충분한 아이템들의 공통 변환. */
function mapTool(
  id: string,
  name: string,
  input: unknown,
  item: ThreadItem,
  done: boolean,
  ts: number
): Mapped {
  const use: ChatItem = {
    id,
    type: 'tool_use',
    toolId: id,
    name,
    input: (input ?? {}) as Record<string, unknown>,
    ts
  }
  if (!done) return { events: [{ type: 'item', item: use }], persist: [] }

  const failed = item.status === 'failed'
  const text = failed ? describeError(item.error) : describeResult(item.result)
  const result: ChatItem = {
    id: `${id}:result`,
    type: 'tool_result',
    toolId: id,
    text: clampText(text),
    isError: failed,
    ts
  }
  return {
    events: [
      { type: 'item', item: use },
      { type: 'item', item: result }
    ],
    persist: [use, result]
  }
}

function describeError(error: unknown): string {
  if (!error) return 'Failed.'
  if (typeof error === 'string') return error
  const message = (error as { message?: string }).message
  return message ?? JSON.stringify(error)
}

function describeResult(result: unknown): string {
  if (result === undefined || result === null) return 'Done.'
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

// ── 사용량 · 플랜 ───────────────────────────────────────────────────────

function mapTokenUsage(params: TokenUsageParams): Mapped {
  const usage = params?.usage
  const maxTokens = params?.contextWindow ?? params?.modelContextWindow
  if (!usage || !maxTokens) return NOTHING

  // 컨텍스트 점유는 "이번 요청이 실어 보낸 입력"이 기준이다(캐시된 입력도 창을 차지한다).
  const usedTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0)
  if (!usedTokens) return NOTHING

  return {
    events: [
      {
        type: 'context',
        usedTokens,
        maxTokens,
        percentage: Math.min(1, usedTokens / maxTokens)
      }
    ],
    persist: []
  }
}

/**
 * codex 의 플랜(할 일 목록)을 Wooi 의 체크리스트로 옮긴다.
 *
 * Claude 는 항목을 하나씩 쌓는 증분형(TaskCreate/TaskUpdate)이라 렌더러가 트랜스크립트를 되짚어
 * 목록을 복원하는데, codex 는 매번 **전체 스냅샷**을 준다. 그래서 스냅샷 전용 도구 이름으로 실어
 * 보내고, 렌더러(lib/tasks.ts)가 이 이름을 보면 목록을 통째로 교체한다.
 */
function mapPlan(params: PlanUpdatedParams, ts: number): Mapped {
  const plan = params?.plan
  if (!plan?.length) return NOTHING

  const tasks = plan.map((p) => ({
    subject: p.step ?? '',
    status: normalizePlanStatus(p.status)
  }))
  const id = `codex:plan:${params.turnId ?? 'turn'}`
  const use: ChatItem = {
    id,
    type: 'tool_use',
    toolId: id,
    name: PLAN_SNAPSHOT_TOOL,
    input: { tasks, explanation: params.explanation },
    ts
  }
  return { events: [{ type: 'item', item: use }], persist: [use] }
}

/** 스냅샷형 할 일 목록을 나르는 가상 도구 이름. 렌더러의 체크리스트 복원이 이 값을 본다. */
export const PLAN_SNAPSHOT_TOOL = 'TaskSnapshot'

function normalizePlanStatus(status: string | undefined): 'pending' | 'in_progress' | 'completed' {
  if (status === 'inProgress' || status === 'in_progress') return 'in_progress'
  if (status === 'completed') return 'completed'
  return 'pending'
}

// ── 승인 요청 ───────────────────────────────────────────────────────────

/** 서버가 제시하지 않을 때 쓰는 기본 결정지. */
const DEFAULT_DECISIONS: CodexDecision[] = ['accept', 'acceptForSession', 'decline']

const DECISION_LABELS: Record<string, string> = {
  accept: 'Approve',
  acceptForSession: 'Approve for session',
  decline: 'Reject',
  cancel: 'Cancel'
}

/** 결정 id 를 Wooi 의 allow/deny 성격으로 분류한다. */
function decisionBehavior(id: string): 'allow' | 'deny' {
  return id === 'decline' || id === 'cancel' ? 'deny' : 'allow'
}

function decisionOptions(available: string[] | undefined): PermissionRequest['options'] {
  const ids = available?.length ? available : DEFAULT_DECISIONS
  return ids.map((id) => ({
    id,
    label: DECISION_LABELS[id] ?? id,
    behavior: decisionBehavior(id),
    ...(id === 'acceptForSession' ? { rememberForSession: true } : {})
  }))
}

/** 명령 실행 승인 요청 → Wooi 권한 프롬프트. */
export function mapCommandApproval(
  params: CommandApprovalParams
): Omit<PermissionRequest, 'requestId' | 'workspaceId'> {
  const command = params?.command ?? ''
  return {
    kind: 'command',
    toolName: 'Shell',
    displayName: 'Run command',
    title: command ? `Codex wants to run \`${command}\`` : 'Codex wants to run a command',
    input: { command, cwd: params?.cwd },
    decisionReason: params?.reason,
    options: decisionOptions(params?.availableDecisions)
  }
}

/** 파일 변경 승인 요청 → Wooi 권한 프롬프트(diff 포함). */
export function mapFileChangeApproval(
  params: FileChangeApprovalParams
): Omit<PermissionRequest, 'requestId' | 'workspaceId'> {
  const changes = params?.changes ?? []
  const paths = changes.map((c) => c.path).filter(Boolean) as string[]
  const diff = changes
    .map((c) => c.diff)
    .filter(Boolean)
    .join('\n')
  return {
    kind: 'fileChange',
    toolName: 'Apply patch',
    displayName: 'Apply changes',
    title:
      paths.length === 1
        ? `Codex wants to edit ${paths[0]}`
        : `Codex wants to edit ${paths.length} files`,
    input: { paths },
    diff: diff ? clampText(diff) : undefined,
    decisionReason: params?.reason,
    options: decisionOptions(params?.availableDecisions)
  }
}

/**
 * 사용자 질문 요청 → Wooi 의 질문 프롬프트.
 *
 * Claude 의 AskUserQuestion 과 같은 UI 를 재사용하도록 입력 모양을 맞춘다 — 답은
 * PermissionDecision.updatedInput 으로 되돌아온다.
 */
export function mapUserInputRequest(
  params: RequestUserInputParams
): Omit<PermissionRequest, 'requestId' | 'workspaceId'> {
  // QuestionPrompt 가 기대하는 모양에 정확히 맞춘다:
  // { question, header, options: [{label, description}], multiSelect? }
  // codex 는 선택지를 평범한 문자열 배열로 주므로 label 로 승격하고 설명은 비운다.
  const questions = (params?.questions ?? []).map((q) => ({
    question: q.question ?? '',
    header: shortHeader(q.question ?? ''),
    options: (q.options ?? []).map((label) => ({ label, description: '' }))
  }))
  return {
    kind: 'question',
    toolName: 'AskUserQuestion',
    displayName: 'Answer',
    title: questions[0]?.question || 'Codex has a question',
    input: { questions }
  }
}

/** 접힌 질문 칩에 쓰는 짧은 라벨. 질문문이 길면 앞부분만 잘라 쓴다. */
function shortHeader(question: string): string {
  const trimmed = question.replace(/\?+$/, '').trim()
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 22)}…`
}

/**
 * 질문 프롬프트의 응답을 codex 가 받는 **순서대로의 문자열 배열**로 바꾼다.
 *
 * QuestionPrompt 는 답을 `answers[질문문] = 답` 형태의 객체로 돌려주는데(Claude 의
 * AskUserQuestion 규약), codex 의 `tool/requestUserInput` 은 질문 순서에 맞춘 배열을 기대한다.
 * 그 간극을 여기서 메운다 — 답이 없는 질문은 빈 문자열로 자리를 지켜 순서가 밀리지 않게 한다.
 */
export function answersFor(params: RequestUserInputParams, updatedInput: unknown): string[] {
  const answers = (updatedInput as { answers?: unknown } | undefined)?.answers
  const questions = params?.questions ?? []

  // 이미 배열이면 그대로 쓴다(다른 경로로 채워진 경우 대비).
  if (Array.isArray(answers)) return answers.map((a) => String(a ?? ''))
  if (!answers || typeof answers !== 'object') return []

  const byQuestion = answers as Record<string, unknown>
  return questions.map((q) => String(byQuestion[q.question ?? ''] ?? ''))
}

/** Wooi 의 권한 결정 → codex 가 받는 decision 문자열. */
export function toCodexDecision(decision: {
  behavior: 'allow' | 'deny'
  rememberForSession?: boolean
  optionId?: string
}): CodexDecision {
  // 사용자가 고른 선택지가 있으면 그대로 돌려준다(서버가 제시한 값이 정본).
  if (decision.optionId && isDecision(decision.optionId)) return decision.optionId
  if (decision.behavior === 'deny') return 'decline'
  return decision.rememberForSession ? 'acceptForSession' : 'accept'
}

function isDecision(value: string): value is CodexDecision {
  return (
    value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel'
  )
}
