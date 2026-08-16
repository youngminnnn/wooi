import type * as acp from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { AcpConnection } from '../acp/session'
import { permissionOutcome, type AcpPermissionChoice } from '../acp/permission'
import { createAcpMapperState } from '../acp/mapping'
import { mapGrokSessionUpdate } from './mapping'
import type { AcpMapped } from '../acp/mapping'
import type { PermissionDecision, PermissionRequest } from '@shared/types'

export interface GrokSessionConfig {
  cwd: string
  resumeSessionId: string | null
  modeId: string
  meta?: Record<string, unknown>
}

export interface GrokHostCallbacks {
  onMapped(workspaceId: string, mapped: AcpMapped): void
  onSessionId(workspaceId: string, sessionId: string): void
  askPermission(request: PermissionRequest): Promise<PermissionDecision>
  onDisconnect(error: unknown | null, stderr: string): void
}

/** 테스트가 실제 프로세스 없이 프로토콜 왕복을 고정할 수 있는 최소 연결 표면. */
export type GrokConnection = Pick<
  AcpConnection,
  | 'live'
  | 'newSession'
  | 'loadSession'
  | 'prompt'
  | 'cancel'
  | 'setMode'
  | 'ext'
  | 'closeSession'
  | 'dispose'
>

/** 하나의 Grok ACP 연결을 여러 워크스페이스 세션이 함께 쓰게 하는 수명주기 소유자. */
export class GrokHost {
  private readonly connection: GrokConnection
  private readonly sessions = new Map<string, string>()
  private readonly opening = new Map<string, Promise<string>>()
  private readonly mapperStates = new Map<string, ReturnType<typeof createAcpMapperState>>()
  private autoApprove = new Map<string, 'none' | 'auto' | 'yolo'>()
  /** 사이드 질문용 임시 세션. 트랜스크립트로 가지 않고 여기 등록된 수집기로만 흐른다. */
  private readonly asides = new Map<string, (text: string) => void>()

  constructor(
    private readonly callbacks: GrokHostCallbacks,
    connection?: GrokConnection
  ) {
    this.connection =
      connection ??
      new AcpConnection({
        launch: { command: 'grok', args: ['agent', 'stdio'], env: process.env },
        requestPermission: (request) => this.handlePermissionRequest(request),
        customRequests: {
          'x.ai/ask_user_question': (params) =>
            this.handleCustomRequest('x.ai/ask_user_question', params),
          'x.ai/exit_plan_mode': (params) => this.handleCustomRequest('x.ai/exit_plan_mode', params)
        },
        onUpdate: (sessionId, update, meta) => this.onUpdate(sessionId, update, meta.replay),
        onDisconnect: (error, stderr) => {
          this.sessions.clear()
          this.opening.clear()
          this.callbacks.onDisconnect(error, stderr)
        },
        clientName: 'wooi-grok'
      })
  }

  get live(): boolean {
    return this.connection.live
  }

  sessionId(workspaceId: string): string | undefined {
    return this.sessions.get(workspaceId)
  }

  async open(workspaceId: string, config: GrokSessionConfig): Promise<string> {
    const existing = this.sessions.get(workspaceId)
    if (existing) return existing
    const inflight = this.opening.get(workspaceId)
    if (inflight) return inflight
    const promise = this.doOpen(workspaceId, config).finally(() => this.opening.delete(workspaceId))
    this.opening.set(workspaceId, promise)
    return promise
  }

  private async doOpen(workspaceId: string, config: GrokSessionConfig): Promise<string> {
    let sessionId: string
    if (config.resumeSessionId) {
      await this.connection.loadSession({
        sessionId: config.resumeSessionId,
        cwd: config.cwd,
        _meta: config.meta
      })
      sessionId = config.resumeSessionId
    } else {
      const response = await this.connection.newSession({ cwd: config.cwd, _meta: config.meta })
      sessionId = response.sessionId
    }
    this.sessions.set(workspaceId, sessionId)
    this.mapperStates.set(workspaceId, createAcpMapperState())
    this.callbacks.onSessionId(workspaceId, sessionId)
    await this.connection.setMode(sessionId, config.modeId)
    return sessionId
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.connection.prompt(sessionId, prompt)
  }

  async interject(sessionId: string, text: string): Promise<void> {
    const result = await this.connection.ext('x.ai/interject', { sessionId, text })
    if (!result.supported) throw new Error('This Grok Build version does not support steering.')
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.cancel(sessionId)
  }

  /**
   * /btw 사이드 질문 — **메인 세션을 건드리지 않고** 한 턴만 묻는다.
   *
   * `x.ai/interject` 로 하면 안 된다. 그건 도는 턴에 입력을 **합치는** 것이라 질문과 답이 그대로
   * 메인 대화에 남는다 — 사이드 질문의 존재 이유와 정반대다. 대신 세션을 하나 더 연다.
   *
   * 맥락을 이어받아야 하므로 `x.ai/session/fork` 를 먼저 시도하고, 없으면 빈 세션으로 내려간다
   * (맥락 없이라도 답하는 편이 아무 것도 못 하는 것보다 낫다). 답은 트랜스크립트에 남기지 않고
   * 델타로만 흘려 보낸 뒤 세션을 닫는다.
   */
  async aside(
    parentSessionId: string | null,
    cwd: string,
    question: string,
    onDelta: (text: string) => void
  ): Promise<void> {
    const sessionId = await this.forkOrOpen(parentSessionId, cwd)
    this.asides.set(sessionId, onDelta)
    try {
      await this.connection.prompt(sessionId, [{ type: 'text', text: question }])
    } finally {
      this.asides.delete(sessionId)
      await this.connection
        .closeSession(sessionId)
        .catch(() => undefined /* 이미 닫혔으면 그만이다 */)
    }
  }

  private async forkOrOpen(parentSessionId: string | null, cwd: string): Promise<string> {
    if (parentSessionId) {
      const forked = await this.connection.ext<{ sessionId?: string }>('x.ai/session/fork', {
        sessionId: parentSessionId
      })
      if (forked.supported && forked.value?.sessionId) return forked.value.sessionId
    }
    return (await this.connection.newSession({ cwd })).sessionId
  }

  setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
    return this.connection.setMode(sessionId, modeId)
  }

  setAutoApprove(workspaceId: string, value: 'none' | 'auto' | 'yolo'): void {
    this.autoApprove.set(workspaceId, value)
  }

  ext<Response, Params = unknown>(method: string, params?: Params) {
    return this.connection.ext<Response, Params>(method, params)
  }

  /** 표준 승인 역요청을 UI 또는 세션의 자동 승인 축으로 답한다. */
  async handlePermissionRequest(
    request: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return this.requestPermission(request)
  }

  /** Grok 고유 블로킹 역요청을 반드시 완료되는 응답으로 바꾼다. */
  async handleCustomRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'x.ai/ask_user_question') return this.askUserQuestion(params)
    if (method === 'x.ai/exit_plan_mode') return this.exitPlanMode(params)
    throw new Error(`Unsupported Grok reverse request: ${method}`)
  }

  /** ACP 업데이트 라우팅 진입점. load 재생분은 여기서 대화로 올라가기 전에 버린다. */
  handleUpdate(sessionId: string, update: acp.SessionUpdate, replay: boolean): void {
    this.onUpdate(sessionId, update, replay)
  }

  async close(workspaceId: string): Promise<void> {
    const sessionId = this.sessions.get(workspaceId)
    this.sessions.delete(workspaceId)
    this.mapperStates.delete(workspaceId)
    this.autoApprove.delete(workspaceId)
    if (sessionId) await this.connection.closeSession(sessionId)
  }

  dispose(): void {
    this.sessions.clear()
    this.opening.clear()
    this.mapperStates.clear()
    this.autoApprove.clear()
    this.connection.dispose()
  }

  private workspaceFor(sessionId: string): string | undefined {
    for (const [workspaceId, owned] of this.sessions) if (owned === sessionId) return workspaceId
    return undefined
  }

  private onUpdate(sessionId: string, update: acp.SessionUpdate, replay: boolean): void {
    // 저장된 트랜스크립트가 이미 가진 load 재생분은 매핑 전 버려 중복 기록과 방송을 함께 막는다.
    if (replay) return
    // 사이드 질문 세션은 대화가 아니다 — 매핑도 영속도 거치지 않고 수집기로만 흘린다.
    const aside = this.asides.get(sessionId)
    if (aside) {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        aside(update.content.text)
      }
      return
    }
    const workspaceId = this.workspaceFor(sessionId)
    if (!workspaceId) return
    const state = this.mapperStates.get(workspaceId) ?? createAcpMapperState()
    this.mapperStates.set(workspaceId, state)
    this.callbacks.onMapped(workspaceId, mapGrokSessionUpdate(update, state))
  }

  private async requestPermission(
    request: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const workspaceId = this.workspaceFor(request.sessionId)
    if (!workspaceId) return { outcome: { outcome: 'cancelled' } }
    const automatic = this.autoApprove.get(workspaceId) ?? 'none'
    if (automatic !== 'none') return permissionOutcome(request.options, 'allow')
    const decision = await this.callbacks.askPermission({
      requestId: randomUUID(),
      workspaceId,
      kind: 'tool',
      toolName: request.toolCall.title || 'Grok tool',
      title: request.toolCall.title ?? undefined,
      displayName: request.toolCall.title ?? undefined,
      input: isRecord(request.toolCall.rawInput) ? request.toolCall.rawInput : {},
      options: request.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        behavior: option.kind.startsWith('allow') ? 'allow' : 'deny',
        rememberForSession: option.kind.endsWith('always')
      }))
    })
    return permissionOutcome(request.options, choiceFor(decision))
  }

  private async askUserQuestion(params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {}
    const sessionId = stringField(p, 'sessionId', 'session_id')
    const workspaceId = sessionId ? this.workspaceFor(sessionId) : undefined
    if (!workspaceId) return { answers: {} }
    const decision = await this.callbacks.askPermission({
      requestId: randomUUID(),
      workspaceId,
      kind: 'question',
      toolName: 'AskUserQuestion',
      title: typeof p.question === 'string' ? p.question : 'Grok asks a question',
      input: p
    })
    return decision.behavior === 'allow'
      ? { answers: decision.updatedInput?.answers ?? {} }
      : { answers: {} }
  }

  private async exitPlanMode(params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {}
    const sessionId = stringField(p, 'sessionId', 'session_id')
    const workspaceId = sessionId ? this.workspaceFor(sessionId) : undefined
    if (!workspaceId) return { approved: false }
    const decision = await this.callbacks.askPermission({
      requestId: randomUUID(),
      workspaceId,
      kind: 'plan',
      toolName: 'ExitPlanMode',
      title: 'Approve Grok’s plan?',
      input: p,
      options: [
        { id: 'approve', label: 'Approve', behavior: 'allow' },
        { id: 'reject', label: 'Keep planning', behavior: 'deny' }
      ]
    })
    return { approved: decision.behavior === 'allow' }
  }
}

function choiceFor(decision: PermissionDecision): AcpPermissionChoice {
  if (decision.behavior === 'allow')
    return decision.optionId?.toLowerCase().includes('always') ? 'allowAlways' : 'allow'
  return decision.optionId?.toLowerCase().includes('always') ? 'rejectAlways' : 'reject'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string') return value[key]
  return undefined
}
