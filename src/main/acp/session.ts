import * as acp from '@agentclientprotocol/sdk'
import type { AcpLaunchSpec, AcpProcess } from './process'
import { spawnAcpProcess } from './process'
import { requestExtension, type AcpExtensionResult } from './ext'

/** 승인 요청을 제품별 UI·정책으로 넘기는 콜백. */
export type AcpPermissionHandler = (
  request: acp.RequestPermissionRequest
) => Promise<acp.RequestPermissionResponse>

export interface AcpConnectionOptions {
  launch: AcpLaunchSpec
  requestPermission: AcpPermissionHandler
  /**
   * `replay` 는 이 업데이트가 **`session/load` 가 쏟아내는 과거 대화**라는 뜻이다.
   *
   * load 는 응답보다 **먼저** 지난 대화를 전부 다시 흘려보낸다(실측). 그걸 라이브 이벤트와
   * 같이 다루면 이미 트랜스크립트에 있는 대화가 한 번 더 쌓인다 — 앱을 다시 켤 때마다 히스토리가
   * 두 배가 된다. 그래서 호출부가 재생분만 골라 버릴 수 있게 표시해서 넘긴다.
   *
   * 버리는 판단을 여기서 대신 하지 않는 이유: 재생분이 필요한 호출부도 있다(세션을 처음 복구할
   * 때는 그것이 곧 대화 내용이다). 아는 쪽이 정한다.
   */
  onUpdate?: (sessionId: string, update: acp.SessionUpdate, meta: { replay: boolean }) => void
  /**
   * 표준 ACP 밖의 **역방향 요청** 처리기. 메서드 이름 → 처리 함수.
   *
   * 확장 메서드 중에는 알림이 아니라 **요청**으로 오는 것이 있고, 그런 것은 답할 때까지 턴이
   * 멈춘다(실측: Grok 의 `x.ai/ask_user_question`·`x.ai/exit_plan_mode` 는 도구 승인과 같은
   * 블로킹 역요청이다). 등록하지 않으면 에이전트는 영영 기다린다 — "가끔 멈추는" 백엔드의
   * 정체가 대개 이것이라, 표준 승인과 같은 자리에 두고 백엔드가 채우게 한다.
   */
  customRequests?: Record<string, (params: unknown) => Promise<unknown>>
  onDisconnect?: (error: unknown | null, stderr: string) => void
  clientName?: string
  /**
   * 기본값은 클라이언트 파일 접근을 **끈다**(`fs.readTextFile`·`writeTextFile` 둘 다 false).
   *
   * 상수가 아니라 옵션인 이유: 이건 프로토콜 제약이 아니라 **정책**이다. 끄면 에이전트가 자기
   * 파일 도구를 쓰게 되고, 그러면 모든 파일 접근이 승인 카드를 지난다 — Wooi 가 원하는 그림이다.
   * 하지만 클라이언트 fs 에 의존하는 에이전트는 이 값으로 깨지므로 백엔드가 바꿀 수 있어야 한다.
   */
  clientCapabilities?: acp.ClientCapabilities
  /** 테스트나 별도 수명 관리에서 프로세스 팩터리를 바꿀 때 쓴다. */
  spawn?: (spec: AcpLaunchSpec) => AcpProcess
}

export interface AcpNewSessionOptions {
  cwd: string
  mcpServers?: acp.McpServer[]
  _meta?: Record<string, unknown> | null
}

export interface AcpLoadSessionOptions extends AcpNewSessionOptions {
  sessionId: string
}

/**
 * 한 ACP 연결에 여러 세션을 매다는 수명주기 래퍼.
 *
 * 유틸리티 프로세스를 쓰지 않고 메인 프로세스에서 돈다. 이 계층은 자식 프로세스의 NDJSON 을
 * 읽는 JSON-RPC 클라이언트일 뿐이고, 에이전트 종료는 stdout EOF 로 격리된다. spawn 의 유일한
 * 비동기 예외 경로도 [[acp/process]] 가 `error` 리스너로 받는다.
 */
export class AcpConnection {
  private handle: AcpProcess | null = null
  private connection: acp.ClientConnection | null = null
  private starting: Promise<acp.ClientContext> | null = null
  private sessions = new Set<string>()
  /** `session/load` 가 도는 동안의 세션. 그 사이 온 업데이트는 과거 대화의 재생분이다. */
  private replaying = new Set<string>()

  constructor(private readonly options: AcpConnectionOptions) {}

  get live(): boolean {
    return this.connection !== null
  }

  get sessionIds(): string[] {
    return [...this.sessions]
  }

  async newSession(options: AcpNewSessionOptions): Promise<acp.NewSessionResponse> {
    const ctx = await this.ensure()
    const response = await ctx.request(acp.methods.agent.session.new, sessionParams(options))
    this.sessions.add(response.sessionId)
    return response
  }

  async loadSession(options: AcpLoadSessionOptions): Promise<acp.LoadSessionResponse> {
    const ctx = await this.ensure()
    // load 는 응답보다 먼저 히스토리 알림을 보내므로 라우팅 표부터 연다 — 나중에 열면 재생분을
    // 통째로 놓친다. 동시에 재생 표시도 켜 둔다([[acp/session]] onUpdate 의 replay).
    this.sessions.add(options.sessionId)
    this.replaying.add(options.sessionId)
    try {
      return await ctx.request(acp.methods.agent.session.load, {
        sessionId: options.sessionId,
        ...sessionParams(options)
      })
    } catch (error) {
      this.sessions.delete(options.sessionId)
      throw error
    } finally {
      this.replaying.delete(options.sessionId)
    }
  }

  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return (await this.ensure()).request(acp.methods.agent.session.prompt, { sessionId, prompt })
  }

  async cancel(sessionId: string): Promise<void> {
    await (await this.ensure()).notify(acp.methods.agent.session.cancel, { sessionId })
  }

  async setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
    return (await this.ensure()).request(acp.methods.agent.session.setMode, { sessionId, modeId })
  }

  async setModel<Response = unknown>(sessionId: string, modelId: string): Promise<Response> {
    // ACP 1.3 SDK 의 안정 메서드 표에는 아직 없지만 일부 에이전트가 표준 이름으로 구현한다.
    return (await this.ensure()).request<Response, { sessionId: string; modelId: string }>(
      'session/set_model',
      { sessionId, modelId }
    )
  }

  /**
   * 확장 메서드를 부른다. 미지원(`method_not_found`)은 예외가 아니라 값으로 돌아오므로
   * 호출부가 그 기능만 런타임에 내릴 수 있다([[acp/ext]]).
   */
  async ext<Response, Params = unknown>(
    method: string,
    params?: Params
  ): Promise<AcpExtensionResult<Response>> {
    return requestExtension<Response, Params>(await this.ensure(), method, params)
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await (await this.ensure()).request(acp.methods.agent.session.close, { sessionId })
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  dispose(): void {
    this.connection?.close()
    this.connection = null
    this.handle?.dispose()
    this.handle = null
    this.starting = null
    this.sessions.clear()
    this.replaying.clear()
  }

  private async connect(): Promise<acp.ClientContext> {
    const handle = (this.options.spawn ?? spawnAcpProcess)(this.options.launch)
    this.handle = handle
    const app = acp
      .client({ name: this.options.clientName ?? 'wooi' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.options.requestPermission(ctx.params)
      )
    // 확장 역요청은 SDK 의 타입 표에 없으므로 파서를 직접 준다. 파싱은 하지 않고 그대로
    // 넘긴다 — 스키마를 아는 것은 백엔드지 이 계층이 아니다.
    for (const [method, handler] of Object.entries(this.options.customRequests ?? {})) {
      app.onRequest<unknown, unknown>(
        method,
        (params: unknown) => params,
        (ctx) => handler(ctx.params)
      )
    }
    app.onNotification(acp.methods.client.session.update, (ctx) => {
      const { sessionId, update } = ctx.params
      if (this.sessions.has(sessionId)) {
        this.options.onUpdate?.(sessionId, update, { replay: this.replaying.has(sessionId) })
      }
    })
    const connection = app.connect(handle.stream)
    this.connection = connection
    void connection.closed
      .then(() => this.disconnected(null, handle))
      .catch((error) => this.disconnected(error, handle))

    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.options.clientCapabilities ?? {
        fs: { readTextFile: false, writeTextFile: false }
      }
    })
    return connection.agent
  }

  private ensure(): Promise<acp.ClientContext> {
    if (!this.starting) {
      this.starting = this.connect().catch((error) => {
        this.starting = null
        this.connection?.close()
        this.connection = null
        this.handle?.dispose()
        this.handle = null
        throw error
      })
    }
    return this.starting
  }

  private disconnected(error: unknown | null, handle: AcpProcess): void {
    if (this.handle !== handle) return
    this.connection = null
    this.handle = null
    this.starting = null
    this.sessions.clear()
    this.replaying.clear()
    handle.dispose()
    this.options.onDisconnect?.(error, handle.stderr())
  }
}

function sessionParams(options: AcpNewSessionOptions): acp.NewSessionRequest {
  return {
    cwd: options.cwd,
    mcpServers: options.mcpServers ?? [],
    ...(options._meta !== undefined ? { _meta: options._meta } : {})
  }
}
