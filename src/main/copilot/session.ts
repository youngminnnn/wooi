import * as acp from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import type {
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  ImageAttachment,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SlashCommandInfo
} from '@shared/types'
import { unknownItemId } from '@shared/types'
import { log } from '../logger'
import {
  COPILOT_CONFIG_IDS,
  READ_ONLY_TOOL_KINDS,
  allowPermission,
  describeAcpFailure,
  initializeAcp,
  rejectPermission,
  spawnCopilotAcp,
  type CopilotAcpProcess
} from './acp'
import {
  commandsFrom,
  permissionRequestFrom,
  toolNameOf,
  toolResultItem,
  toolUseItem,
  touchesWorkingTree,
  unknownUpdateName
} from './mapping'
import { copilotModeSettings, isPlanMode } from './modes'
import { parseContextPanel, parseMcpPanel, parseUsagePanel } from './panels'

/**
 * Copilot ACP 연결과 세션.
 *
 * **한 프로세스가 여러 세션**을 든다 — 실측으로 서로 다른 cwd 의 두 세션이 같은 연결에서
 * 병렬로 돌았다. Codex 호스트가 app-server 하나에 스레드를 여럿 매다는 것과 같은 모양이고,
 * 워크스페이스마다 CLI 를 하나씩 띄우지 않으므로 메모리도 그만큼 아낀다.
 *
 * 유틸리티 프로세스를 쓰지 않고 **메인 프로세스에서** 돈다. 호스트의 존재 이유는 SDK·app-server
 * 의 fatal 격리인데, 여기서는 자식 프로세스의 ndjson 을 읽는 JSON-RPC 클라이언트일 뿐이라
 * Copilot 이 죽어도 stdout EOF 로 나타난다(메인의 uncaught exception 이 아니다). 유일한
 * 예외였던 spawn 의 비동기 'error' 는 [[copilot/acp]] 가 리스너로 받는다.
 */

/** 세션이 바깥세상(store·트랜스크립트·렌더러)과 이야기하는 유일한 창구. */
export interface CopilotHost {
  emit(workspaceId: string, event: ChatEvent): void
  persist(workspaceId: string, item: ChatItem): void
  /** ACP 세션 id 를 워크스페이스에 적어 둔다 — 앱을 다시 켰을 때 session/load 의 열쇠다. */
  noteSessionId(workspaceId: string, sessionId: string): void
  /** 승인 카드를 띄우고 사용자의 결정을 기다린다. */
  askPermission(request: PermissionRequest): Promise<PermissionDecision>
  /** 연결이 끊겼다. 매니저가 진행 상태를 정리하고 다음 사용 때 다시 띄운다. */
  onDisconnect(reason: string): void
}

/** 세션을 열 때 필요한 값. 매니저가 store 에서 계산해 넘긴다. */
export interface CopilotSessionConfig {
  cwd: string
  permissionMode: PermissionMode
  /** 이어 붙일 ACP 세션 id. 있으면 session/load 로 대화를 복원한다. */
  resumeSessionId: string | null
  /** `/add-dir` 로 더해 둔 worktree 밖 디렉터리. 세션을 새로 열 때마다 다시 적용한다. */
  extraDirs: string[]
}

// ── 연결 ─────────────────────────────────────────────────────────────────

export class CopilotConnection {
  private proc: CopilotAcpProcess | null = null
  private conn: acp.ClientConnection | null = null
  private starting: Promise<acp.ClientContext> | null = null
  /** workspaceId → 세션. */
  private sessions = new Map<string, CopilotSession>()
  /** ACP sessionId → 세션. 알림·승인 요청을 워크스페이스로 되돌리는 라우팅 표다. */
  private routes = new Map<string, CopilotSession>()

  constructor(private host: CopilotHost) {}

  /** 지금 살아 있는 연결이 있는가. 배경 조회가 프로세스를 띄우지 않으려고 본다. */
  get live(): boolean {
    return this.conn !== null
  }

  private async connect(): Promise<acp.ClientContext> {
    const handle = await spawnCopilotAcp()
    this.proc = handle

    let resolveCtx: (ctx: acp.ClientContext) => void
    const ready = new Promise<acp.ClientContext>((resolve) => (resolveCtx = resolve))

    const conn = acp
      .client({ name: 'wooi' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const session = this.routes.get(ctx.params.sessionId)
        // 라우팅이 안 되는 요청에 함부로 예라고 답할 수는 없다. 거절이 유일하게 안전한 기본값이다.
        return session ? session.handlePermission(ctx.params) : rejectPermission(ctx.params.options)
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.routes.get(ctx.params.sessionId)?.handleUpdate(ctx.params.update)
      })
      .onConnect((ctx) => {
        resolveCtx(ctx.agent)
      })
      .connect(handle.stream)

    this.conn = conn
    // stdout EOF·파이프 오류로 연결이 닫히면 여기로 온다. 프로세스가 살아 있는 채로 파이프만
    // 끊길 수도 있으므로 프로세스도 함께 정리한다.
    void conn.closed
      .then(() => this.teardown('The GitHub Copilot process stopped.'))
      .catch((err) => this.teardown(describeAcpFailure(err, handle.stderr())))

    const ctx = await ready
    await initializeAcp(ctx)
    return ctx
  }

  /** 연결을 보장한다. 여러 워크스페이스가 동시에 첫 메시지를 보내도 프로세스는 하나만 뜬다. */
  private ensure(): Promise<acp.ClientContext> {
    if (!this.starting) {
      this.starting = this.connect().catch((err) => {
        this.starting = null
        this.proc?.dispose()
        this.proc = null
        this.conn = null
        throw err
      })
    }
    return this.starting
  }

  /** 이 워크스페이스의 세션. 없으면 만든다(ACP 핸드셰이크는 첫 사용 때 일어난다). */
  session(workspaceId: string, config: CopilotSessionConfig): CopilotSession {
    let session = this.sessions.get(workspaceId)
    if (!session) {
      session = new CopilotSession(workspaceId, this.host, {
        ctx: () => this.ensure(),
        route: (sessionId, s) => this.routes.set(sessionId, s),
        unroute: (sessionId) => this.routes.delete(sessionId)
      })
      this.sessions.set(workspaceId, session)
    }
    session.configure(config)
    return session
  }

  /** 이미 열려 있는 세션만. 없으면 만들지 않는다(정리·조회 경로가 쓴다). */
  existing(workspaceId: string): CopilotSession | undefined {
    return this.sessions.get(workspaceId)
  }

  get openWorkspaces(): string[] {
    return [...this.sessions.keys()]
  }

  dispose(workspaceId: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session) return
    this.sessions.delete(workspaceId)
    session.dispose()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
    this.teardown(null)
  }

  /** 프로세스·연결을 버린다. `reason` 이 있으면 매니저에게 복구를 맡긴다. */
  private teardown(reason: string | null): void {
    const had = this.conn !== null || this.proc !== null
    this.conn?.close()
    this.conn = null
    this.proc?.dispose()
    this.proc = null
    this.starting = null
    this.routes.clear()
    for (const session of this.sessions.values()) session.onConnectionLost()
    if (reason && had) this.host.onDisconnect(reason)
  }
}

// ── 세션 ─────────────────────────────────────────────────────────────────

interface SessionWiring {
  ctx: () => Promise<acp.ClientContext>
  route: (sessionId: string, session: CopilotSession) => void
  unroute: (sessionId: string) => void
}

/** 지금 도는 턴. `owned` 는 이 턴을 시작시킨 prompt 인지(steering 과 구별). */
interface ActiveTurn {
  cancelled: boolean
}

export class CopilotSession {
  private sessionId: string | null = null
  private config: CopilotSessionConfig = {
    cwd: '',
    permissionMode: 'default',
    resumeSessionId: null,
    extraDirs: []
  }
  /** 세션 열기(중복 방지). 여러 메시지가 겹쳐 들어와도 session/new 는 한 번이다. */
  private opening: Promise<string> | null = null
  private turn: ActiveTurn | null = null
  /**
   * `session/load` 로 히스토리를 재생하는 동안 참. 이때 오는 user/agent 청크는 **이미
   * 트랜스크립트에 있는 과거**라 대화에 다시 쌓으면 안 된다.
   */
  private replaying = false
  /** 슬래시 명령의 답을 대화가 아니라 여기로 받는다(런타임에 하나만 존재). */
  private capture: string[] | null = null

  /** 지금 자라고 있는 어시스턴트/생각 말풍선. 도구 호출이 끼면 끊고 새로 시작한다. */
  private streaming: { id: string; type: 'assistant' | 'thinking'; text: string } | null = null
  /** toolCallId → tool_call 이 알려 준 구체적인 이름. 승인 카드 제목을 살린다. */
  private toolNames = new Map<string, string>()
  private usage: { used: number; size: number } | null = null
  private commands: SlashCommandInfo[] = []
  /** 이미 `unknown` 카드로 알린 것. 대화당 한 장으로 합친다(백엔드 쪽 dedupe 기준). */
  private warned = new Set<string>()
  /** 세션에 실제로 적용된 권한 모드. 같은 값을 반복해 보내지 않으려고 들고 있다. */
  private appliedMode: PermissionMode | null = null

  constructor(
    readonly workspaceId: string,
    private host: CopilotHost,
    private wiring: SessionWiring
  ) {}

  configure(config: CopilotSessionConfig): void {
    this.config = config
  }

  get running(): boolean {
    return this.turn !== null
  }

  // ── 세션 열기 ──────────────────────────────────────────────────────────

  private open(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId)
    if (!this.opening) {
      this.opening = this.doOpen().catch((err) => {
        this.opening = null
        throw err
      })
    }
    return this.opening
  }

  private async doOpen(): Promise<string> {
    const ctx = await this.wiring.ctx()
    // MCP 서버는 넘기지 않는다 — Copilot 은 자기 설정(~/.copilot/mcp-config.json)의 서버를
    // 스스로 붙인다. Wooi 가 여기서 목록을 주면 그것으로 **대체**되어 사용자의 설정이 사라진다.
    const params: acp.NewSessionRequest = { cwd: this.config.cwd, mcpServers: [] }

    if (this.config.resumeSessionId) {
      // 재개는 **라우팅을 먼저 걸어 둬야** 한다 — session/load 는 응답보다 먼저 히스토리
      // 알림을 쏟아붓는다(실측). 그 알림을 받을 자리가 없으면 재생이 통째로 사라진다.
      const sessionId = this.config.resumeSessionId
      this.sessionId = sessionId
      this.wiring.route(sessionId, this)
      this.replaying = true
      try {
        await ctx.request(acp.methods.agent.session.load, { sessionId, ...params })
      } catch (err) {
        // 세션이 사라졌거나(디스크 정리) 프로토콜이 거절했다. 대화를 잃는 것보다 새 세션으로
        // 이어 가는 편이 낫다 — 사용자에게는 맥락이 끊겼다고 한 줄로 알린다.
        log.info(`copilot: session/load failed, starting fresh (${describeError(err)})`)
        this.wiring.unroute(sessionId)
        this.sessionId = null
        this.replaying = false
        this.note('Could not resume the previous GitHub Copilot conversation — starting a new one.')
        return this.start(ctx, params)
      }
      this.replaying = false
      this.host.noteSessionId(this.workspaceId, sessionId)
      this.host.emit(this.workspaceId, { type: 'session', sessionId })
      await this.applySettings(ctx, sessionId)
      return sessionId
    }

    return this.start(ctx, params)
  }

  private async start(ctx: acp.ClientContext, params: acp.NewSessionRequest): Promise<string> {
    const res = await ctx.request(acp.methods.agent.session.new, params)
    this.sessionId = res.sessionId
    this.wiring.route(res.sessionId, this)
    this.host.noteSessionId(this.workspaceId, res.sessionId)
    this.host.emit(this.workspaceId, { type: 'session', sessionId: res.sessionId })
    await this.applySettings(ctx, res.sessionId)
    return res.sessionId
  }

  /** 세션 시작·재개 직후에 권한 모드와 추가 디렉터리를 다시 얹는다. */
  private async applySettings(ctx: acp.ClientContext, sessionId: string): Promise<void> {
    await this.pushMode(ctx, sessionId, this.config.permissionMode)
    for (const dir of this.config.extraDirs) {
      // 명령 결과는 버린다 — 실패해도 대화를 막을 이유가 없고, 다음 /add-dir 이 다시 시도한다.
      await this.ask(ctx, sessionId, `/add-dir ${dir}`).catch(() => undefined)
    }
  }

  /**
   * 권한 모드를 세션에 얹는다.
   *
   * **순서가 중요하다** — 모드를 plan 으로 바꾸면 Copilot 이 `allow_all` 을 강제로 off 로
   * 되돌리므로(실측), mode 를 먼저 보내고 allow_all 을 나중에 보내야 우리가 원한 조합이 남는다.
   */
  private async pushMode(
    ctx: acp.ClientContext,
    sessionId: string,
    mode: PermissionMode
  ): Promise<void> {
    const { modeId, allowAll } = copilotModeSettings(mode)
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId })
    await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: COPILOT_CONFIG_IDS.allowAll,
      value: allowAll ? 'on' : 'off'
    })
    this.appliedMode = mode
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.config = { ...this.config, permissionMode: mode }
    if (!this.sessionId || this.appliedMode === mode) return
    const ctx = await this.wiring.ctx()
    await this.pushMode(ctx, this.sessionId, mode)
  }

  // ── 턴 ────────────────────────────────────────────────────────────────

  /**
   * 사용자 메시지를 보낸다.
   *
   * 턴이 이미 돌고 있으면 **steering** 이다 — Copilot 은 그 입력을 도는 턴 안에 반영한다
   * (실측: t=17.8s 에 반영, 턴은 t=20.7s 종료). 다만 그 `session/prompt` 는 **7ms 만에
   * `end_turn` 을 돌려준다** — 그 응답으로 턴이 끝났다고 판단하면 아직 도는 대화가 유휴로
   * 보이고 완료 알림까지 뜬다. 그래서 턴의 끝은 **처음 시작한 prompt** 만 말한다.
   */
  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const sessionId = await this.open()
    const ctx = await this.wiring.ctx()
    const blocks = promptBlocks(text, images)

    if (this.turn) {
      // steering — 응답을 기다리지도, 그 stopReason 을 믿지도 않는다.
      void ctx
        .request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks })
        .catch((err) => log.info(`copilot: steering prompt failed (${describeError(err)})`))
      return
    }

    const turn: ActiveTurn = { cancelled: false }
    this.turn = turn
    this.host.emit(this.workspaceId, { type: 'status', status: 'running' })
    try {
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks })
      this.finishTurn(turn, null)
    } catch (err) {
      this.finishTurn(turn, describeAcpFailure(err))
    }
  }

  /**
   * 턴을 끊는다.
   *
   * `session/cancel` 뒤 prompt 는 `cancelled` 가 아니라 **`end_turn`** 으로 resolve 된다(실측).
   * 그래서 stopReason 을 믿지 않고 우리가 세운 플래그로 취소를 안다.
   */
  async cancel(): Promise<void> {
    const turn = this.turn
    if (!turn || !this.sessionId) return
    turn.cancelled = true
    const ctx = await this.wiring.ctx()
    await ctx
      .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch((err) => log.info(`copilot: cancel failed (${describeError(err)})`))
  }

  private finishTurn(turn: ActiveTurn, error: string | null): void {
    if (this.turn !== turn) return
    this.turn = null
    this.flushStreaming()
    if (error && !turn.cancelled) {
      const item: ChatItem = {
        id: `copilot:error:${Date.now()}`,
        type: 'error',
        text: error,
        ts: Date.now()
      }
      this.host.persist(this.workspaceId, item)
      this.host.emit(this.workspaceId, { type: 'item', item })
    }
    this.host.emit(this.workspaceId, {
      type: 'status',
      status: error && !turn.cancelled ? 'error' : 'idle'
    })
  }

  // ── 슬래시 명령 패널 ────────────────────────────────────────────────────

  /**
   * `/context`·`/usage`·`/mcp` 를 실행해 텍스트를 받아 온다.
   *
   * **턴이 도는 중에는 거절한다.** 실측에서 도는 턴에 슬래시 명령을 밀어 넣으면 그 턴이
   * 취소된다(`Info: Operation cancelled by user`, prompt 는 `cancelled` 반환). 패널 하나
   * 보여 주자고 사용자의 작업을 죽일 수는 없다. 평범한 텍스트 steering 과 다른 점이다.
   */
  async runCommand(kind: CommandPanelKind): Promise<CommandResult> {
    if (this.turn) {
      throw new Error('GitHub Copilot is working — wait for the turn to finish, or interrupt it.')
    }
    const sessionId = await this.open()
    const ctx = await this.wiring.ctx()

    switch (kind) {
      case 'context': {
        const text = await this.ask(ctx, sessionId, '/context')
        const context = parseContextPanel(text, this.usage)
        // 첫 메시지 전에는 Copilot 이 "not yet available" 이라고만 답한다. 0/0 짜리 빈 막대를
        // 그리느니 Codex 와 같은 문장으로 끊는다.
        if (!context.maxTokens) throw new Error('No context usage yet — send a message first.')
        return { kind: 'context', context }
      }
      case 'usage':
        return { kind: 'usage', usage: parseUsagePanel(await this.ask(ctx, sessionId, '/usage')) }
      case 'mcp':
        return { kind: 'mcp', servers: parseMcpPanel(await this.ask(ctx, sessionId, '/mcp')) }
      default:
        throw new Error(`GitHub Copilot CLI does not support /${kind}.`)
    }
  }

  /**
   * `/add-dir`. 세션이 살아 있으면 지금 보내고, 없으면 config 에 남아 있다가 세션을 열 때 얹힌다
   * (applySettings). Copilot 은 이 명령을 세션 중에 받아 주므로 세션을 버릴 필요가 없다 —
   * 재시작이 필요한 Claude 경로와 다른 점이다.
   */
  addDirectory(dir: string): void {
    if (!this.sessionId || this.turn) return
    void this.wiring
      .ctx()
      .then((ctx) => this.ask(ctx, this.sessionId as string, `/add-dir ${dir}`))
      .catch((err) => log.info(`copilot: /add-dir failed (${describeError(err)})`))
  }

  /** 슬래시 명령 하나를 보내고 그 답을 **대화에 남기지 않고** 문자열로 받는다. */
  private async ask(ctx: acp.ClientContext, sessionId: string, command: string): Promise<string> {
    const buffer: string[] = []
    this.capture = buffer
    try {
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: command }]
      })
    } finally {
      this.capture = null
    }
    return buffer.join('')
  }

  listCommands(): SlashCommandInfo[] {
    return this.commands
  }

  // ── 들어오는 알림 ───────────────────────────────────────────────────────

  handleUpdate(update: acp.SessionUpdate): void {
    const ts = Date.now()
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (this.replaying || update.content.type !== 'text') return
        const text = update.content.text
        // 슬래시 명령의 답은 패널로 간다 — 대화에 그 원문이 쌓이면 안 된다.
        if (this.capture) {
          this.capture.push(text)
          return
        }
        this.streamText(
          update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'assistant',
          text
        )
        return
      }

      case 'user_message_chunk':
        // session/load 재생분이다. 트랜스크립트에 이미 있으므로 버린다.
        return

      case 'tool_call': {
        if (this.replaying || this.capture) return
        // 텍스트 말풍선을 도구 **앞에서** 끊는다 — Claude 의 블록 경계와 같은 굵기가 된다.
        this.flushStreaming()
        this.toolNames.set(update.toolCallId, toolNameOf(update))
        const item = toolUseItem(update, ts)
        this.host.persist(this.workspaceId, item)
        this.host.emit(this.workspaceId, { type: 'item', item })
        return
      }

      case 'tool_call_update': {
        if (this.replaying || this.capture) return
        const result = toolResultItem(update, ts)
        if (!result) return
        this.host.persist(this.workspaceId, result)
        this.host.emit(this.workspaceId, { type: 'item', item: result })
        // 작업 트리를 건드렸을 수 있다 — Changes 패널에 "git 을 다시 읽어라" 신호만 보낸다.
        if (touchesWorkingTree(update.kind)) {
          this.host.emit(this.workspaceId, { type: 'workingTreeChanged' })
        }
        return
      }

      case 'usage_update': {
        this.usage = { used: update.used, size: update.size }
        if (update.size > 0) {
          this.host.emit(this.workspaceId, {
            type: 'context',
            usedTokens: update.used,
            maxTokens: update.size,
            // 미터와 store 는 **0~1 fraction** 을 기대한다([[renderer/store]] ContextUsage).
            // 0~100 으로 보내면 10% 짜리 대화가 빨간 100% 로 그려진다(실앱에서 확인했다).
            percentage: Math.min(1, update.used / update.size)
          })
        }
        return
      }

      case 'available_commands_update':
        this.commands = commandsFrom(update)
        return

      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
        // 세션이 소비하지 않는 제어 알림. 버려도 대화에 구멍이 나지 않는다([[copilot/mapping]]).
        return

      default: {
        const what = unknownUpdateName(update)
        if (what) this.warnUnknown(what)
      }
    }
  }

  private streamText(type: 'assistant' | 'thinking', text: string): void {
    if (!this.streaming || this.streaming.type !== type) {
      this.flushStreaming()
      this.streaming = { id: `copilot:${type}:${randomUUID()}`, type, text: '' }
    }
    this.streaming.text += text
    this.host.emit(this.workspaceId, {
      type: 'delta',
      id: this.streaming.id,
      itemType: type,
      text
    })
  }

  /** 자라던 말풍선을 확정 아이템으로 굳혀 트랜스크립트에 남긴다. */
  private flushStreaming(): void {
    const streaming = this.streaming
    this.streaming = null
    if (!streaming || !streaming.text.trim()) return
    const item: ChatItem = {
      id: streaming.id,
      type: streaming.type,
      text: streaming.text,
      ts: Date.now()
    }
    this.host.persist(this.workspaceId, item)
    this.host.emit(this.workspaceId, { type: 'item', item })
  }

  private warnUnknown(what: string): void {
    if (this.warned.has(what)) return
    this.warned.add(what)
    const item: ChatItem = {
      id: unknownItemId('copilot', what),
      type: 'unknown',
      backend: 'copilot',
      what,
      hint: 'Update the GitHub Copilot CLI (`copilot update`) — Wooi may not know this yet.',
      ts: Date.now()
    }
    this.host.persist(this.workspaceId, item)
    this.host.emit(this.workspaceId, { type: 'item', item })
  }

  private note(text: string): void {
    const item: ChatItem = {
      id: `copilot:system:${Date.now()}`,
      type: 'system',
      text,
      ts: Date.now()
    }
    this.host.persist(this.workspaceId, item)
    this.host.emit(this.workspaceId, { type: 'item', item })
  }

  // ── 승인 ──────────────────────────────────────────────────────────────

  async handlePermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    // plan 의 마지막 방어선. 실측에서 plan 모드는 워크스페이스 파일을 건드리지 않아 요청 자체가
    // 오지 않지만, Copilot 의 plan 구현이 바뀌면 여기가 유일한 방어선이다 — ACP 에는 OS
    // 샌드박스라는 두 번째 방어선이 없다.
    if (isPlanMode(this.config.permissionMode)) {
      const kind = params.toolCall.kind
      if (!kind || !READ_ONLY_TOOL_KINDS.has(kind)) return rejectPermission(params.options)
    }

    const requestId = randomUUID()
    const request = permissionRequestFrom(
      params,
      requestId,
      this.workspaceId,
      this.toolNames.get(params.toolCall.toolCallId)
    )
    const decision = await this.host.askPermission(request)
    if (decision.behavior === 'deny') {
      return decision.optionId
        ? { outcome: { outcome: 'selected', optionId: decision.optionId } }
        : rejectPermission(params.options)
    }
    return decision.optionId
      ? { outcome: { outcome: 'selected', optionId: decision.optionId } }
      : allowPermission(params.options)
  }

  // ── 정리 ──────────────────────────────────────────────────────────────

  /** 연결이 끊겼다 — 세션 id 는 남기고(다음 메시지가 load 로 이어간다) 런타임 상태만 버린다. */
  onConnectionLost(): void {
    const turn = this.turn
    this.turn = null
    this.opening = null
    this.streaming = null
    this.capture = null
    this.replaying = false
    this.appliedMode = null
    // 다음에 열 때 이 대화를 이어 붙일 수 있도록 resume 을 걸어 둔다.
    this.config = { ...this.config, resumeSessionId: this.sessionId ?? this.config.resumeSessionId }
    this.sessionId = null
    if (turn) this.host.emit(this.workspaceId, { type: 'status', status: 'idle' })
  }

  dispose(): void {
    if (this.sessionId) this.wiring.unroute(this.sessionId)
    this.onConnectionLost()
  }

  /** 맥락을 비운다 — 다음 메시지가 새 세션을 연다. */
  clear(): void {
    if (this.sessionId) this.wiring.unroute(this.sessionId)
    this.sessionId = null
    this.opening = null
    this.warned.clear()
    this.toolNames.clear()
    this.usage = null
    this.appliedMode = null
    this.config = { ...this.config, resumeSessionId: null }
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────

function promptBlocks(text: string, images?: ImageAttachment[]): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = []
  // 이미지를 앞에 둔다 — 사용자의 문장이 이미지에 대한 지시인 경우가 대부분이다.
  for (const image of images ?? []) {
    blocks.push({ type: 'image', data: image.dataBase64, mimeType: image.mediaType })
  }
  if (text) blocks.push({ type: 'text', text })
  return blocks.length ? blocks : [{ type: 'text', text: '' }]
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
