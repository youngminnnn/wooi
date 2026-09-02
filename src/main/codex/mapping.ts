import type { ChatEvent, ChatItem, PermissionRequest, RunningAgent } from '@shared/types'
import { basename, extname } from 'node:path'
import { clampText } from '../claude/clamp'
import { NOTIFY, type CodexDecision, type FileUpdateChange, type ThreadItem } from './wire'
import type {
  CommandApprovalParams,
  DeltaParams,
  FileChangePatchParams,
  GuardianWarningParams,
  GuardianApprovalReviewParams,
  HookParams,
  ItemParams,
  McpServerStatusParams,
  McpToolProgressParams,
  PlanUpdatedParams,
  RequestUserInputParams,
  FileChangeApprovalParams,
  TokenUsageParams,
  TurnDiffParams,
  TurnParams,
  WarningParams
} from './wire'
import { codexToolResult } from './toolResult'

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
  command: Map<
    string,
    {
      command: string
      cwd?: string
      agent: boolean
      source?: ThreadItem['source']
      processId?: string | null
    }
  >
  /** 실행 중 Codex 서브에이전트·unified exec. sidebar 이벤트의 전량 스냅샷 정본이다. */
  agents: Map<string, RunningAgent>
  /** 로컬에 즉시 표시한 사용자 입력. app-server echo 를 중복 표시하지 않기 위한 서명. */
  pendingUserEchoes: string[]
  /**
   * codex itemId → 그 MCP 도구 카드의 이름과 인자.
   *
   * 진행 알림(item/mcpToolCall/progress)에는 도구 이름도 인자도 없다. 그것만으로 카드를 다시
   * 그리면 이미 보여 주던 내용이 지워지므로, 시작 시점의 스냅샷을 붙잡아 둔다(명령 실행의
   * `command` 맵과 같은 이유다).
   */
  tools: Map<string, { name: string; input: unknown }>
  /**
   * 이미 보여 준 MCP 기동 실패(`서버이름\n오류`).
   *
   * 같은 실패가 반복해서 온다 — 실측으로 서버 하나가 `starting`→`failed` 를 두 번 냈다.
   * 대화에 같은 카드를 두 장 쌓지 않기 위한 기록이다.
   */
  mcpFailures: Set<string>
}

export function createMapperState(): MapperState {
  return {
    output: new Map(),
    command: new Map(),
    agents: new Map(),
    pendingUserEchoes: [],
    tools: new Map(),
    mcpFailures: new Set()
  }
}

/** CodexThread 가 낙관적으로 표시한 입력을 서버 echo 와 짝짓는다. */
export function rememberOptimisticUser(
  state: MapperState,
  text: string,
  attachmentNames: string[]
): void {
  state.pendingUserEchoes.push(userSignature(text, attachmentNames))
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

    // 실패한 턴도 여기로 온다(turn.status === 'failed'). 별도 turn/failed 알림은 없다.
    case NOTIFY.turnCompleted:
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

    case NOTIFY.planDelta: {
      const p = params as DeltaParams
      if (!p?.delta) return NOTHING
      return {
        events: [
          { type: 'delta', id: itemId(p.itemId, 'plan'), itemType: 'assistant', text: p.delta }
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

    case NOTIFY.modelRerouted:
    case NOTIFY.deprecationNotice: {
      const p = (params ?? {}) as {
        message?: string
        reason?: string
        fromModel?: string
        toModel?: string
      }
      const text =
        p.message ??
        p.reason ??
        (p.fromModel && p.toModel ? `Model rerouted: ${p.fromModel} → ${p.toModel}` : undefined)
      if (!text) return NOTHING
      const item: ChatItem = { id: `codex:notice:${ts}`, type: 'system', text, ts }
      return { events: [{ type: 'item', item }], persist: [item] }
    }

    case NOTIFY.threadCompacted:
      return { events: [{ type: 'compacting', active: false, trigger: 'auto' }], persist: [] }

    /**
     * 턴 누적 diff. **본문은 쓰지 않고 "바뀌었다" 는 사실만** 흘려보낸다.
     *
     * 이 diff 는 에이전트가 만든 변경만 담는다 — 사용자가 직접 편집한 것도, Claude 백엔드의
     * 변경도 없다. Changes 패널의 정본으로 삼으면 백엔드마다 다른 것을 보여 주게 되므로,
     * 정본은 git 하나로 두고 갱신 시점만 알린다([[types]] workingTreeChanged).
     */
    case NOTIFY.turnDiffUpdated: {
      const p = params as TurnDiffParams
      if (!p?.diff) return NOTHING
      return { events: [{ type: 'workingTreeChanged' }], persist: [] }
    }

    case NOTIFY.mcpStartupStatus:
      return mapMcpStartup(params as McpServerStatusParams, state, ts)

    case NOTIFY.mcpToolProgress:
      return mapMcpProgress(params as McpToolProgressParams, state, ts)

    /**
     * 승인 대기 중 패치가 갱신됐다. 카드를 최신 내용으로 다시 그린다.
     *
     * 승인 프롬프트에 실리는 diff 는 호출부가 따로 붙잡아 둔다([[thread]] pendingPatches) —
     * 이 계층은 I/O 도 상태 밖의 부수효과도 갖지 않으므로 카드만 책임진다.
     */
    case NOTIFY.fileChangePatchUpdated: {
      const p = params as FileChangePatchParams
      if (!p?.itemId || !p.changes?.length) return NOTHING
      return mapFileChange({ changes: p.changes }, itemId(p.itemId, 'fileChange'), false, ts)
    }

    case NOTIFY.hookStarted:
    case NOTIFY.hookCompleted:
      return mapHook(method, params as HookParams, ts)

    case NOTIFY.guardianWarning: {
      const p = params as GuardianWarningParams
      if (!p?.message) return NOTHING
      const item: ChatItem = { id: `codex:guardian:${ts}`, type: 'system', text: p.message, ts }
      return { events: [{ type: 'item', item }], persist: [item] }
    }

    case NOTIFY.guardianApprovalReviewStarted:
    case NOTIFY.guardianApprovalReviewCompleted:
      return mapGuardianApprovalReview(
        method,
        params as GuardianApprovalReviewParams,
        ts,
        onUnknown
      )

    /**
     * `thread/status/changed` 는 **일부러 매핑하지 않는다.**
     *
     * 서버가 idle 을 직접 알려 주므로 Wooi 의 추론(settleIdle)을 대신할 것처럼 보이지만, 실측하면
     * `{type:'idle'}` 이 `turn/completed` 와 **같은 밀리초에** 온다. 둘 다 status:'idle' 로 옮기면
     * 이벤트가 두 번 나가고, 매니저는 idle 마다 완료 알림을 울리므로([[manager]] emit) 턴 하나에
     * 완료음이 두 번 난다. 서버 값이 더 정확한 것도 아니라 얻는 것 없이 회귀만 남는다.
     */
    default:
      // 구독하지 않는 알림(계정·rate limit·MCP 상태 등)은 상위 계층이 따로 처리한다.
      return NOTHING
  }
}

/**
 * upstream 이 상세 payload 를 임시라고 명시했다. 그래서 카드의 정체성은 lifecycle 필드에만 기대고,
 * review/action/decisionSource 는 현재 알아볼 수 있을 때만 장식한다. 모양이 바뀌어도 턴은 계속된다.
 */
function mapGuardianApprovalReview(
  method: string,
  params: GuardianApprovalReviewParams,
  ts: number,
  onUnknown?: (what: string) => void
): Mapped {
  if (!params || typeof params.reviewId !== 'string') {
    onUnknown?.(`${method} payload`)
    return NOTHING
  }
  const completed = method === NOTIFY.guardianApprovalReviewCompleted
  const review = record(params.review)
  const status = typeof review?.status === 'string' ? review.status : undefined
  const risk = typeof review?.riskLevel === 'string' ? review.riskLevel : undefined
  const rationale = typeof review?.rationale === 'string' ? review.rationale.trim() : ''
  const action = guardianAction(params.action)
  const source = typeof params.decisionSource === 'string' ? params.decisionSource : undefined
  const lines = [
    completed
      ? `Codex auto-review ${status ?? 'completed'}.`
      : 'Codex is auto-reviewing this action…'
  ]
  if (action) lines.push(`Action: ${action}`)
  if (completed && risk) lines.push(`Risk: ${risk}`)
  if (completed && rationale) lines.push(rationale)
  if (completed && source) lines.push(`Decision source: ${source}`)
  const item: ChatItem = {
    id: `codex:guardian-review:${params.reviewId}`,
    type: 'system',
    text: lines.join('\n'),
    ts:
      completed && typeof params.completedAtMs === 'number'
        ? params.completedAtMs
        : (params.startedAtMs ?? ts)
  }
  return { events: [{ type: 'item', item }], persist: completed ? [item] : [] }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function guardianAction(value: unknown): string | null {
  const action = record(value)
  if (!action || typeof action.type !== 'string') return null
  if (action.type === 'command' && typeof action.command === 'string') return action.command
  if (action.type === 'execve' && typeof action.program === 'string') return action.program
  if (action.type === 'networkAccess' && typeof action.target === 'string') return action.target
  if (action.type === 'mcpToolCall' && typeof action.toolName === 'string') return action.toolName
  if (action.type === 'applyPatch') return 'Apply patch'
  if (action.type === 'requestPermissions') return 'Request permissions'
  return null
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
function errorText(error?: { message?: string; codexErrorInfo?: unknown }): string | null {
  if (!error) return null
  const base = error.message?.trim()
  const hint = ERROR_HINTS[normalizeCodexErrorInfo(error.codexErrorInfo) ?? '']
  if (!base) return hint ?? null
  return hint ? `${base}\n\n${hint}` : base
}

/** 최신 app-server의 camelCase와 구버전의 PascalCase 오류 코드를 같은 값으로 맞춘다. */
export function normalizeCodexErrorInfo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value[0].toLowerCase() + value.slice(1)
}

/**
 * codex 의 오류 분류에 붙이는 안내. 원문만으로는 사용자가 뭘 해야 할지 모르는 경우만 추린다.
 * 모르는 분류는 안내 없이 원문만 보여 준다.
 */
const ERROR_HINTS: Record<string, string> = {
  usageLimitExceeded: 'Your ChatGPT usage limit is reached. Check /usage for when it resets.',
  sessionBudgetExceeded: 'This session hit its token budget. Start a new session to continue.',
  contextWindowExceeded: 'The conversation outgrew the context window. Try /compact.',
  unauthorized: 'Codex is not signed in. Connect your account in Settings → Integrations.'
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
    case 'userMessage': {
      if (!done) return NOTHING
      const content = item.content ?? []
      const text = content
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      const attachments = content.flatMap((part) => {
        if (part.type !== 'localImage' && part.type !== 'image') return []
        const source = part.path ?? part.url ?? part.name ?? 'image.png'
        const ext = extname(source).toLowerCase()
        const mediaType =
          ext === '.jpg' || ext === '.jpeg'
            ? ('image/jpeg' as const)
            : ext === '.gif'
              ? ('image/gif' as const)
              : ext === '.webp'
                ? ('image/webp' as const)
                : ('image/png' as const)
        return [{ name: basename(source) || 'image.png', mediaType }]
      })
      // Enter 직후 CodexThread 가 이미 표시한 입력이면 서버가 돌려준 echo 만 소비한다.
      const signature = userSignature(
        text,
        attachments.map((attachment) => attachment.name)
      )
      const optimisticIndex = state.pendingUserEchoes.indexOf(signature)
      if (optimisticIndex >= 0) {
        state.pendingUserEchoes.splice(optimisticIndex, 1)
        return NOTHING
      }
      const chat: ChatItem = {
        id,
        type: 'user',
        text,
        ts,
        ...(attachments.length ? { attachments } : {})
      }
      return { events: [{ type: 'item', item: chat }], persist: [chat] }
    }

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

    case 'mcpToolCall': {
      // Claude 경로와 같은 표준 이름을 쓰면 표시명과 렌더러의 MCP 묶음 정책을 그대로 공유한다.
      const name = `mcp__${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`
      // 진행 알림에는 이름도 인자도 없다 — 그때 카드를 다시 그릴 수 있도록 여기서 붙잡아 둔다.
      const key = item.id
      if (key) {
        if (done) state.tools.delete(key)
        else state.tools.set(key, { name, input: item.arguments })
      }
      return mapTool(id, name, item.arguments, item, done, ts)
    }

    case 'dynamicToolCall':
      return mapTool(
        id,
        `${item.namespace ? `${item.namespace}/` : ''}${item.tool ?? 'tool'}`,
        item.arguments,
        {
          ...item,
          result: item.contentItems,
          status: item.success === false ? 'failed' : item.status
        },
        done,
        ts
      )

    /**
     * Codex 의 서브에이전트 조율(spawn_agent·send_input·wait·close_agent 등).
     * 실제 아이템 타입 이름은 `collabAgentToolCall` 이다(스키마로 확인).
     *
     * 사이드바의 "실행 중 에이전트" 패널까지 채우려면 수명주기 의미(agentStatus 값 등)를 알아야
     * 하는데 확인하지 못했다 — 추측해 넣기보다 대화에 도구 호출로만 보여 준다. 그것만으로도
     * "지금 서브에이전트를 돌리고 있다"는 사실은 드러나고, 조용히 사라지지는 않는다.
     */
    case 'collabAgentToolCall':
      return mapTool(id, item.tool ?? 'agent', { prompt: item.prompt }, item, done, ts)

    case 'subAgentActivity': {
      const agentId = item.agentThreadId ?? item.id ?? id
      if (item.kind === 'interrupted') state.agents.delete(agentId)
      else {
        const previous = state.agents.get(agentId)
        state.agents.set(agentId, {
          taskId: agentId,
          agentType: item.agentPath ?? 'Codex agent',
          description: item.kind === 'interacted' ? 'Working with the parent agent' : 'Running',
          startedAt: previous?.startedAt ?? ts
        })
      }
      return { events: [{ type: 'agents', agents: [...state.agents.values()] }], persist: [] }
    }

    case 'hookPrompt': {
      const text = (item.fragments ?? []).map((fragment) => fragment.text ?? '').join('\n')
      if (!text) return NOTHING
      const chat: ChatItem = { id, type: 'system', text: `Hook feedback\n\n${text}`, ts }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    case 'webSearch':
      return mapTool(id, 'WebSearch', { query: item.query }, item, done, ts)

    case 'imageView':
      return mapTool(id, 'ViewImage', { path: (item as { path?: string }).path }, item, done, ts)

    case 'imageGeneration':
      return mapTool(
        id,
        'ImageGeneration',
        { prompt: item.revisedPrompt },
        { ...item, result: item.savedPath ?? item.result },
        done,
        ts
      )

    case 'sleep':
      return mapTool(id, 'Sleep', { durationMs: item.durationMs }, item, done, ts)

    case 'plan': {
      // 플랜 모드의 산출물 — 본문 그대로 어시스턴트 메시지로 보여 준다.
      const chat: ChatItem = { id, type: 'assistant', text: item.text ?? '', ts }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    case 'contextCompaction': {
      // app-server 는 수동/자동을 구분하지 않는다. 완료 경계를 남겨 어느 쪽이든 앞선 UI 기록을
      // 다시 마운트하지 않게 한다(모델 히스토리 압축과 화면 렌더링 압축을 같은 지점에 맞춘다).
      if (!done)
        return { events: [{ type: 'compacting', active: true, trigger: 'auto' }], persist: [] }
      const compacted: ChatItem = { id, type: 'compaction', trigger: 'auto', ts }
      return {
        events: [
          { type: 'item', item: compacted },
          { type: 'compacting', active: false, trigger: 'auto' }
        ],
        persist: [compacted]
      }
    }

    case 'error': {
      const text = item.message ?? item.text
      if (!text) return NOTHING
      const chat: ChatItem = { id, type: 'error', text, ts }
      return { events: [{ type: 'item', item: chat }], persist: [chat] }
    }

    case 'enteredReviewMode':
    case 'exitedReviewMode': {
      const text =
        item.review ??
        item.text ??
        (item.type === 'enteredReviewMode' ? 'Review started' : 'Review finished')
      const chat: ChatItem = { id, type: 'system', text, ts }
      return { events: [{ type: 'item', item: chat }], persist: done ? [chat] : [] }
    }

    default:
      // 새 아이템 타입이 생겨도 대화는 계속돼야 한다.
      onUnknown?.(`item type "${item.type}"`)
      return NOTHING
  }
}

function userSignature(text: string, attachmentNames: string[]): string {
  return JSON.stringify([text, attachmentNames])
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
  if (item.command) {
    const previous = state.command.get(key)
    state.command.set(key, {
      command: item.command,
      cwd: item.cwd ?? previous?.cwd,
      // 완료 스냅샷이 source를 생략해도 시작 때 확인한 출처를 덮지 않는다. 시작도 못 봤다면
      // 필드가 없던 app-server의 기존 의미(에이전트 명령)를 보존한다.
      agent: item.source ? item.source !== 'userShell' : (previous?.agent ?? true),
      source: item.source ?? previous?.source,
      processId: item.processId ?? previous?.processId
    })
  }
  const meta = state.command.get(key)

  // 확정 시엔 서버가 준 전체 출력이 정본이다. 진행 중엔 델타로 쌓아 온 버퍼를 쓴다.
  const output = done
    ? (item.aggregatedOutput ?? state.output.get(key) ?? '')
    : (state.output.get(key) ?? '')

  const chat: ChatItem = {
    id,
    type: 'bash',
    ...(meta?.agent === false ? {} : { agent: true as const }),
    command: meta?.command ?? item.command ?? '',
    cwd: meta?.cwd,
    // 대용량 출력이 IPC 직렬화를 터뜨리지 않도록 Claude 경로와 같은 상한을 적용한다.
    output: clampText(output),
    exitCode: done ? (item.exitCode ?? (item.status === 'declined' ? -1 : null)) : null,
    running: !done,
    ts
  }

  const taskKey = meta?.processId ?? key
  const isUnifiedExecStartup = meta?.source === 'unifiedExecStartup'
  let agentsChanged = false
  if (isUnifiedExecStartup && !done) {
    const previous = state.agents.get(taskKey)
    state.agents.set(taskKey, {
      taskId: taskKey,
      taskType: 'unified_exec',
      agentType: 'Bash',
      description: meta.command,
      startedAt: previous?.startedAt ?? ts
    })
    agentsChanged = true
  } else if (done && state.agents.delete(taskKey)) {
    agentsChanged = true
  }

  if (done) state.output.delete(key)
  if (done) state.command.delete(key)

  return {
    events: [
      { type: 'item', item: chat },
      ...(agentsChanged ? [{ type: 'agents' as const, agents: [...state.agents.values()] }] : [])
    ],
    persist: done ? [chat] : []
  }
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
    ...(meta?.agent === false ? {} : { agent: true as const }),
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
  const paths = changes.map((c) => c.path).filter((path): path is string => !!path)
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
    // codex 는 줄 단위 증감을 주지 않는다 — 없는 +0/−0 를 지어내느니 바꾼 파일만 밝히고,
    // 나머지는 접힌 본문을 펼쳐 보게 둔다(파일이 많아도 세 줄에서 잘리지 않게 하는 것이 목적).
    ...(!failed && paths.length > 0 ? { summary: { kind: 'files' as const, paths } } : {}),
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
  const output = failed ? { text: describeError(item.error) } : codexToolResult(item)
  const result: ChatItem = {
    id: `${id}:result`,
    type: 'tool_result',
    toolId: id,
    text: clampText(output.text),
    isError: failed,
    ...(!failed && output.summary ? { summary: output.summary } : {}),
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

// ── MCP 서버 · 훅 ───────────────────────────────────────────────────────

/**
 * MCP 서버 기동 상태 → **실패만** 대화에 남긴다.
 *
 * 성공 경로를 버리는 것이 이 함수의 요점이다. 실측으로 턴 하나에 이 알림이 12~23번 왔는데
 * 대부분 `starting`→`ready` 진동이었다 — 전부 카드로 만들면 대화가 그것만으로 덮인다.
 * 반대로 실패는 지금 Wooi 가 알 방법이 아예 없다. `error` 에 원인 문장이 그대로 실려 온다:
 * "MCP client for `x` failed to start: MCP startup failed: No such file or directory (os error 2)".
 *
 * `cancelled` 도 남기지 않는다 — 사용자가 껐거나 재기동 중이라 조치할 것이 없다.
 */
function mapMcpStartup(params: McpServerStatusParams, state: MapperState, ts: number): Mapped {
  if (params?.status !== 'failed') return NOTHING
  const name = params.name ?? 'MCP server'
  const reason = params.error?.trim() || 'The server did not start.'
  // 같은 실패가 반복해서 온다(실측: 서버 하나가 failed 를 두 번). 한 번만 보여 준다.
  const key = `${name}\n${reason}`
  if (state.mcpFailures.has(key)) return NOTHING
  state.mcpFailures.add(key)

  // 재인증은 사용자가 할 수 있는 일이 분명하므로 한 줄 덧붙인다.
  const hint =
    params.failureReason === 'reauthenticationRequired'
      ? '\n\nSign in to this server again in Settings → Integrations.'
      : ''
  const item: ChatItem = {
    id: `codex:mcp:${name}:${ts}`,
    type: 'error',
    text: `MCP server "${name}" failed to start.\n\n${reason}${hint}`,
    ts
  }
  return { events: [{ type: 'item', item }], persist: [item] }
}

/**
 * 긴 MCP 호출의 진행 메시지 → 이미 떠 있는 도구 카드를 갱신한다.
 *
 * 진행 알림에는 도구 이름도 인자도 없어서, 시작 시점에 붙잡아 둔 스냅샷과 합쳐야 카드가
 * 지워지지 않는다. 아직 시작을 못 본 itemId 면(알림 순서가 어긋난 경우) 조용히 버린다 —
 * 이름 없는 카드를 새로 만드는 것보다 낫다.
 */
function mapMcpProgress(params: McpToolProgressParams, state: MapperState, ts: number): Mapped {
  const key = params?.itemId
  const message = params?.message?.trim()
  if (!key || !message) return NOTHING
  const meta = state.tools.get(key)
  if (!meta) return NOTHING

  const use: ChatItem = {
    id: itemId(key, 'mcp'),
    type: 'tool_use',
    toolId: itemId(key, 'mcp'),
    name: meta.name,
    input: { ...((meta.input ?? {}) as Record<string, unknown>), progress: message },
    ts
  }
  // 진행 스냅샷은 화면에만 — 확정 아이템이 뒤이어 트랜스크립트에 남는다.
  return { events: [{ type: 'item', item: use }], persist: [] }
}

/**
 * 사용자 훅 실행 → 시스템 카드 하나(실행 id 기준 upsert).
 *
 * 훅이 턴을 붙들고 있을 때 지금은 화면이 완전히 조용하다. 시작 카드는 그 침묵을 메우는 것이
 * 목적이라 **트랜스크립트에는 남기지 않는다**(완료 카드가 같은 id 로 덮어쓴다).
 *
 * 남기는 것은 정상 종료가 아닌 경우뿐이다 — 훅이 매 턴 도는 것이 정상인데 성공까지 기록하면
 * 트랜스크립트가 훅 로그가 된다. 반대로 `failed`·`blocked`·`stopped` 는 턴의 결과를 바꾼
 * 사건이라 남아야 한다.
 */
function mapHook(method: string, params: HookParams, ts: number): Mapped {
  const run = params?.run
  if (!run) return NOTHING
  const label = run.eventName ?? 'hook'
  const id = `codex:hook:${run.id ?? label}`

  if (method === NOTIFY.hookStarted) {
    const detail = run.statusMessage?.trim()
    const text = `Hook ${label} is running…${detail ? `\n\n${detail}` : ''}`
    return { events: [{ type: 'item', item: { id, type: 'system', text, ts } }], persist: [] }
  }

  const status = run.status ?? 'completed'
  const failed = status === 'failed' || status === 'blocked' || status === 'stopped'
  // 훅이 남긴 출력. 사용자가 원인을 알 수 있는 유일한 단서라 실패 시엔 그대로 싣는다.
  const output = (run.entries ?? [])
    .map((entry) => entry.text?.trim())
    .filter(Boolean)
    .join('\n')
  const took = typeof run.durationMs === 'number' ? ` in ${Math.round(run.durationMs)}ms` : ''
  const headline = failed ? `Hook ${label} ${status}${took}.` : `Hook ${label} finished${took}.`
  const detail = run.statusMessage?.trim() || output
  const text = detail ? `${headline}\n\n${clampText(detail)}` : headline

  const item: ChatItem = { id, type: failed ? 'error' : 'system', text, ts }
  return { events: [{ type: 'item', item }], persist: failed ? [item] : [] }
}

// ── 사용량 · 플랜 ───────────────────────────────────────────────────────

function mapTokenUsage(params: TokenUsageParams): Mapped {
  const usage = params?.tokenUsage
  const maxTokens = usage?.modelContextWindow
  if (!usage || !maxTokens) return NOTHING

  // 컨텍스트 점유는 **마지막 요청**이 실어 보낸 입력 토큰이다.
  //
  // cachedInputTokens 를 더하지 않는 것이 중요하다 — 실측으로 확인한 바
  // totalTokens = inputTokens + outputTokens 이고, cachedInputTokens 는 그중 캐시로 처리된
  // **부분집합**이다(예: input 17100 중 cached 11008). 더하면 사용량이 크게 부풀려진다.
  // total 은 세션 누적이라 윈도 점유와 무관하므로 쓰지 않는다.
  const usedTokens = usage.last?.inputTokens ?? 0
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
  acceptWithExecpolicyAmendment: 'Always allow this command',
  applyNetworkPolicyAmendment: 'Allow this host',
  decline: 'Reject',
  cancel: 'Cancel'
}

/**
 * 결정 하나의 식별자.
 *
 * 서버가 주는 `availableDecisions` 에는 **문자열과 객체가 섞여 온다**(실측):
 *   ["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]
 * 객체 형태는 "이 명령을 앞으로 허용" 처럼 payload 를 함께 되돌려 줘야 하는 결정이다.
 * 우리는 바깥 키를 id 로 쓰고, 응답할 때 원본 값을 그대로 되돌린다.
 */
function decisionId(decision: unknown): string {
  if (typeof decision === 'string') return decision
  if (decision && typeof decision === 'object') return Object.keys(decision)[0] ?? ''
  return ''
}

/** 결정 id 를 Wooi 의 allow/deny 성격으로 분류한다. */
function decisionBehavior(id: string): 'allow' | 'deny' {
  return id === 'decline' || id === 'cancel' ? 'deny' : 'allow'
}

function decisionOptions(available: unknown[] | undefined): PermissionRequest['options'] {
  const list = available?.length ? available : DEFAULT_DECISIONS
  return list
    .map((raw) => decisionId(raw))
    .filter(Boolean)
    .map((id) => ({
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

/**
 * 파일 변경 승인 요청 → Wooi 권한 프롬프트.
 *
 * 승인 요청 자체에는 diff 가 없다(itemId 만 온다). 같은 itemId 의 `fileChange` 아이템이
 * `item/started` 로 먼저 도착하므로, 호출부가 그때 붙잡아 둔 changes 를 여기로 넘겨 준다 —
 * 그러지 않으면 사용자가 무엇을 승인하는지 못 보고 결정하게 된다.
 */
export function mapFileChangeApproval(
  params: FileChangeApprovalParams,
  changes: FileUpdateChange[] = []
): Omit<PermissionRequest, 'requestId' | 'workspaceId'> {
  const paths = changes.map((c) => c.path).filter((path): path is string => !!path) as string[]
  const diff = changes
    .map((c) => c.diff)
    .filter(Boolean)
    .join('\n')
  const title =
    paths.length === 1
      ? `Codex wants to edit ${paths[0]}`
      : paths.length > 1
        ? `Codex wants to edit ${paths.length} files`
        : 'Codex wants to apply a patch'
  return {
    kind: 'fileChange',
    toolName: 'Apply patch',
    displayName: 'Apply changes',
    title,
    input: { paths },
    diff: diff ? clampText(diff) : undefined,
    decisionReason: params?.reason ?? undefined,
    // 파일 변경은 명령과 달리 execpolicy/네트워크 수정 선택지가 없다(스키마로 확인).
    options: decisionOptions(['accept', 'acceptForSession', 'decline'])
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
  // codex 의 옵션은 이미 {label, description} 이라 QuestionPrompt 가 기대하는 모양 그대로다.
  // 질문마다 id 가 있고, 답변은 **그 id 로** 되돌려 줘야 한다(질문문이 아니다).
  const questions = (params?.questions ?? []).map((q) => ({
    id: q.id ?? '',
    question: q.question ?? '',
    header: q.header || shortHeader(q.question ?? ''),
    options: (q.options ?? []).map((o) => ({
      label: o.label ?? '',
      description: o.description ?? ''
    })),
    // isOther 인 질문은 자유 입력을 받아야 하므로 다중 선택 UI 의 "Other" 경로를 연다.
    ...(q.isOther ? { multiSelect: false } : {})
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
export function answersFor(
  params: RequestUserInputParams,
  updatedInput: unknown
): Record<string, { answers: string[] }> {
  const raw = (updatedInput as { answers?: unknown } | undefined)?.answers
  const questions = params?.questions ?? []
  const out: Record<string, { answers: string[] }> = {}
  if (!raw || typeof raw !== 'object') return out

  const byQuestion = raw as Record<string, unknown>
  for (const q of questions) {
    const id = q.id
    if (!id) continue
    // QuestionPrompt 는 질문문을 키로 답을 돌려준다 — 그걸 질문 id 키로 옮긴다.
    const answer = byQuestion[q.question ?? '']
    if (answer === undefined || answer === null || answer === '') continue
    // 다중 선택은 ", " 로 이어 붙여 오므로 다시 나눠 배열로 만든다.
    const values = String(answer)
      .split(', ')
      .map((v) => v.trim())
      .filter(Boolean)
    if (values.length) out[id] = { answers: values }
  }
  return out
}

/**
 * Wooi 의 권한 결정 → codex 가 받는 decision 값.
 *
 * 서버가 제시한 결정이 객체였다면(payload 를 요구하는 결정) **그 객체를 통째로** 되돌려야 한다 —
 * 바깥 키만 문자열로 보내면 서버가 거절한다. 그래서 원본 목록을 함께 받아 대조한다.
 */
export function toCodexDecision(
  decision: { behavior: 'allow' | 'deny'; rememberForSession?: boolean; optionId?: string },
  available?: unknown[]
): CodexDecision | object {
  if (decision.optionId) {
    const original = available?.find((raw) => decisionId(raw) === decision.optionId)
    // 객체 결정은 원본 그대로, 문자열 결정은 그 문자열로.
    if (original !== undefined) return original as CodexDecision | object
    if (isDecision(decision.optionId)) return decision.optionId
  }
  if (decision.behavior === 'deny') return 'decline'
  return decision.rememberForSession ? 'acceptForSession' : 'accept'
}

function isDecision(value: string): value is CodexDecision {
  return (
    value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel'
  )
}
