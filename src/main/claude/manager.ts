import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { statSync, type Stats } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  utilityProcess,
  Notification,
  app,
  type BrowserWindow,
  type UtilityProcess
} from 'electron'
import { getStore } from '../store'
import { wooiMcpSettings } from '../mcpSettings'
import { getTranscripts } from '../transcripts'
import { log } from '../logger'
import {
  IPC,
  agentSettingsFor,
  nativePeerInbound,
  peerSessionName,
  workspaceDisplayName
} from '@shared/types'
import { CLAUDE_META, CLAUDE_MODELS, type AgentBackend, type TurnEndHook } from '../agent/backend'
import { agentDefaultsFor, canLeadAgentTeam, delegateBackendsFor } from '../agent/multiAgent'
import { claudeMode, type HostCommand, type HostEvent, type SessionConfig } from './protocol'
import { runAgentTool } from '../agent/tools'
import { abortSubAgents } from '../agent/tools/subagent'
import { RATE_LIMIT_CONTINUATION, RateLimitResumeCoordinator } from '../rateLimitResume'
import type {
  AgentBackendId,
  AgentSettings,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  ModelOption,
  NotificationEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RateLimitSnapshot,
  RewindActionResult,
  SendMessageOptions,
  SlashCommandInfo,
  UsageInfo,
  Workspace
} from '@shared/types'

type Dispatch = (channel: string, payload: unknown) => void

/**
 * 턴 종료 후 레이트리밋 조회까지의 지연. 비슷한 시각에 끝난 여러 워크스페이스의 갱신을
 * 한 번으로 접고, result 처리 흐름과 제어 요청이 겹치지 않게 한다.
 */
const RATE_LIMIT_DEBOUNCE_MS = 1500

/**
 * 라이브 세션이 있는 동안의 폴링 간격. 5시간·7일 창이 움직이는 속도에 비하면 5분은 충분히 촘촘하고,
 * 라이브 Query 위에서 도는 제어 요청이라 비용도 사실상 없다(세션이 없으면 아예 no-op).
 */
const RATE_LIMIT_POLL_MS = 5 * 60_000

/** `~/src` 처럼 셸에서 익숙한 홈 경로 표기를 받아 준다(셸을 거치지 않으므로 직접 푼다). */
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

/**
 * workspace 단위 Claude 세션의 생명주기를 관리한다.
 *
 * 실제 SDK 쿼리 실행은 메인이 아니라 agent-host(유틸리티 프로세스, host.ts)에서 돈다 —
 * 이 클래스는 그 호스트를 spawn 하고, 명령을 메시지로 보내고, 호스트가 돌려주는 이벤트를
 * store·트랜스크립트·렌더러·OS 알림으로 반영하는 프록시다. 호스트가 (SDK/스트리밍 경로의
 * 네이티브 fatal 등으로) 죽어도 메인은 살아남아, 진행 중이던 workspace 를 idle 로 되돌리고
 * 다음 사용 시 호스트를 다시 띄운다. 권한 요청은 호스트 → 메인 → 렌더러로 라우팅한다.
 */
export class SessionManager implements AgentBackend {
  /** 이 백엔드의 메타데이터(식별·표시·capabilities). 추상화 계층이 라우팅/가드에 사용한다. */
  readonly meta = CLAUDE_META

  private host: UtilityProcess | null = null
  private hostReady = false
  /** 호스트가 spawn 되기 전 들어온 명령을 모았다가 'spawn' 시 비운다. */
  private outbox: HostCommand[] = []

  // requestId → 그 권한 요청을 띄운 workspace. dispose 시 해당 요청만 골라 취소한다.
  private pendingPermissions = new Map<string, string>()
  // 요청-응답 명령(runCommand·mcpAction·listCommands)의 reqId → resolver.
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  // 레이트리밋 조회는 계정 단위라 동시에 여러 번 돌 이유가 없다 — 진행 중인 것 하나만 들고 공유한다.
  private rateLimitInflight: Promise<void> | null = null
  /** 진행 중인 조회가 단명 쿼리 폴백을 허용하는(=사용자가 명시적으로 요청한) 것인지. */
  private rateLimitInflightForced = false
  private rateLimitDebounce: ReturnType<typeof setTimeout> | null = null
  private rateLimitPoll: ReturnType<typeof setInterval> | null = null
  private readonly rateLimitResume: RateLimitResumeCoordinator

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null,
    private onTurnEnd?: TurnEndHook
  ) {
    this.rateLimitResume = new RateLimitResumeCoordinator({
      backend: CLAUDE_META.id,
      refreshLimits: () => this.refreshRateLimits(true),
      sendContinuation: (workspaceId) => this.sendContinuation(workspaceId),
      emitItem: (workspaceId, item) =>
        this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } }),
      broadcastState: () => this.dispatch(IPC.evtState, getStore().getState())
    })
    this.rateLimitResume.restore()
  }

  // ── 호스트 프로세스 ──────────────────────────────────────────────────────

  private ensureHost(): void {
    if (this.host) return

    const entry = join(import.meta.dirname, 'host.js')
    const host = utilityProcess.fork(entry, [], {
      serviceName: 'wooi-agent-host',
      // 메인이 로그인 셸로 보정한 PATH·토큰을 그대로 물려준다(자식 claude CLI 가 인증/설정을
      // 읽을 수 있도록). app 이 없는 유틸리티 프로세스용으로 userData 경로를 넘긴다.
      env: {
        ...process.env,
        WOOI_USER_DATA: app.getPath('userData'),
        WOOI_LOG_NAME: 'host.log'
      }
    })

    host.on('spawn', () => {
      this.hostReady = true
      for (const cmd of this.outbox) host.postMessage(cmd)
      this.outbox = []
      // 호스트가 떴다 = 세션이 생길 참이다. 이때부터 주기 갱신을 건다(라이브 세션이 없으면 no-op).
      this.startRateLimitPolling()
    })
    host.on('message', (msg: HostEvent) => this.onHostEvent(msg))
    host.on('exit', (code) => this.onHostExit(code))

    this.host = host
  }

  /** 호스트가 필요한 명령(세션을 만들/이어갈 수 있어야 하는 명령)을 보낸다. 없으면 spawn 한다. */
  private send(cmd: HostCommand): void {
    this.ensureHost()
    if (this.hostReady && this.host) this.host.postMessage(cmd)
    else this.outbox.push(cmd)
  }

  /** 호스트가 이미 있을 때만 의미 있는 명령(interrupt·dispose 등)을 보낸다. 없으면 무시. */
  private sendIfHost(cmd: HostCommand): void {
    if (!this.host) return
    if (this.hostReady) this.host.postMessage(cmd)
    else this.outbox.push(cmd)
  }

  /** 호스트가 죽으면 메인은 살아남아 진행 상태를 정리하고, 다음 사용 때 다시 spawn 한다. */
  private onHostExit(code: number | undefined): void {
    log.error(`agent-host exited (code ${code}); recovering without taking down the app`)
    this.host = null
    this.hostReady = false
    this.outbox = []

    // 호스트가 없으면 폴링할 대상도 없다. 다음 spawn 때 다시 건다.
    if (this.rateLimitPoll) {
      clearInterval(this.rateLimitPoll)
      this.rateLimitPoll = null
    }
    if (this.rateLimitDebounce) {
      clearTimeout(this.rateLimitDebounce)
      this.rateLimitDebounce = null
    }

    // 대기 중이던 요청-응답은 더 올 수 없으므로 거부한다.
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Agent host crashed'))
    }
    this.pendingRequests.clear()

    // 렌더러에 떠 있던 권한 프롬프트를 거둔다(응답해도 받을 호스트가 없다).
    for (const requestId of this.pendingPermissions.keys()) {
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
    this.pendingPermissions.clear()

    // 진행 중이던 workspace 는 멈췄으므로 idle 로 되돌리고, 사용자가 원인을 알 수 있게 알린다.
    const running = getStore()
      .getState()
      .workspaces.filter((w) => w.status === 'running')
    for (const w of running) {
      const item: ChatItem = {
        id: `error:hostcrash:${Date.now()}:${w.id}`,
        type: 'error',
        text: 'The agent process stopped unexpectedly and was restarted. Please resend your last message.',
        ts: Date.now()
      }
      getTranscripts().upsert(w.id, item)
      this.dispatch(IPC.evtChat, { workspaceId: w.id, event: { type: 'item', item } })
      this.forceIdle(w.id)
    }
  }

  private onHostEvent(msg: HostEvent): void {
    switch (msg.type) {
      case 'event':
        this.emit(msg.workspaceId, msg.event)
        break
      case 'persist':
        getTranscripts().upsert(msg.workspaceId, msg.item)
        break
      case 'sessionId':
        this.onSessionId(msg.workspaceId, msg.sessionId)
        break
      case 'rateLimit':
        void this.rateLimitResume.noteRateLimit(msg.workspaceId, msg.resetAt)
        break
      case 'settleIdle':
        this.forceIdle(msg.workspaceId)
        break
      case 'permissionRequest':
        this.onPermissionRequest(msg.request)
        break
      case 'permissionMode':
        // 호스트의 라이브 세션에는 이미 적용된 상태다 — 여기서는 store 와 UI 만 맞춘다.
        getStore().update((st) => {
          const w = st.workspaces.find((x) => x.id === msg.workspaceId)
          if (w) w.permissionMode = msg.mode
        })
        this.dispatch(IPC.evtState, getStore().getState())
        break
      case 'response': {
        const pending = this.pendingRequests.get(msg.reqId)
        if (pending) {
          this.pendingRequests.delete(msg.reqId)
          if (msg.ok) pending.resolve(msg.data)
          else pending.reject(new Error(msg.error))
        }
        break
      }
      case 'sideQuestion':
        this.dispatch(IPC.evtSideQuestion, msg.update)
        break
      case 'toolCall':
        void this.onToolCall(msg.callId, msg.workspaceId, msg.tool, msg.args)
        break
    }
  }

  /**
   * 에이전트가 부른 Wooi 도구를 실행하고 결과를 호스트로 회신한다.
   *
   * 실패해도 **반드시 회신한다** — 회신하지 않으면 호스트의 도구 호출이 영영 매달리고, 그 뒤로
   * 모델의 턴이 통째로 멈춘다. 실패는 도구 오류로 전달돼 모델이 스스로 고쳐 다시 부를 수 있다.
   */
  private async onToolCall(
    callId: string,
    workspaceId: string,
    tool: string,
    args: unknown
  ): Promise<void> {
    try {
      const data = await runAgentTool(workspaceId, tool, args)
      this.sendIfHost({ type: 'toolResult', callId, ok: true, data })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`agent tool failed: ${tool} — ${error}`)
      this.sendIfHost({ type: 'toolResult', callId, ok: false, error })
    }
  }

  // ── 설정 ─────────────────────────────────────────────────────────────────

  private getWorkspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((w) => w.id === id)
  }

  /** 세션 이름에 실을 리포 이름. 사라진 리포는 워크트리 경로로 이름을 지을 근거가 없어 비워 둔다. */
  private getRepoName(repoId: string): string {
    return (
      getStore()
        .getState()
        .repos.find((r) => r.id === repoId)?.name ?? 'repo'
    )
  }

  private getRepoPath(repoId: string): string | null {
    return (
      getStore()
        .getState()
        .repos.find((r) => r.id === repoId)?.path ?? null
    )
  }

  /** 이 백엔드(Claude)의 전역 기본값. 워크스페이스 오버라이드가 없을 때의 폴백이다. */
  private defaults(): AgentSettings {
    return agentSettingsFor(getStore().getState().settings, CLAUDE_META.id)
  }

  /**
   * 이 워크스페이스가 위임할 수 있는 백엔드. 세션 설정과 자동완성 목록이 같은 판단을 써야 하므로
   * 한 곳에 둔다 — 어긋나면 세션에는 있는 명령이 입력창에 안 뜨거나 그 반대가 된다.
   */
  private delegateBackendsOf(workspaceId: string): AgentBackendId[] {
    const ws = this.getWorkspace(workspaceId)
    return ws ? delegateBackendsFor(ws) : []
  }

  /** store 에서 세션 생성에 필요한 설정을 계산한다(예전 ensure() 의 역할). */
  private configFor(ws: Workspace): SessionConfig {
    const settings = getStore().getState().settings
    const defaults = this.defaults()
    return {
      cwd: ws.worktreePath,
      repoPath: this.getRepoPath(ws.repoId),
      model: ws.model ?? defaults.model,
      effort: ws.effort ?? defaults.effort,
      fastMode: ws.fastMode ?? defaults.fastMode,
      // 다른 백엔드에서 넘어온 값(전역 기본값 이관 등)이 SDK 로 새지 않도록 여기서 걸러 낸다.
      permissionMode: claudeMode(ws.permissionMode),
      // store 를 읽는 것은 메인뿐이다 — 호스트가 직접 읽으려 들면 electron 에 매인 모듈이
      // 딸려 들어와 로드 시점에 죽는다([[claude/protocol]] mcpSettings).
      mcpSettings: wooiMcpSettings(),
      autoCompact: settings.autoCompact,
      autoResumeAfterRateLimit: settings.autoResumeAfterRateLimit,
      // 네이티브 cross-session messaging 용. 이름은 사용자의 다른 터미널 세션이 `/list-agents` 로
      // 보는 값이고, 수신 정책은 워크스페이스의 것을 접어 넘긴다([[types]] nativePeerInbound).
      peer: {
        name: peerSessionName(this.getRepoName(ws.repoId), ws.branch),
        inbound: nativePeerInbound(ws.peerInbound)
      },
      resumeSessionId: ws.sessionId,
      additionalDirs: ws.additionalDirs ?? [],
      delegateBackends: delegateBackendsFor(ws),
      canSwitchToAgentTeam: canLeadAgentTeam(ws),
      agentDefaults: agentDefaultsFor(settings)
    }
  }

  /** reqId 로 상관되는 요청-응답 명령을 보내고 결과를 기다린다. */
  private request<T>(make: (reqId: string) => HostCommand): Promise<T> {
    const reqId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve: resolve as (v: unknown) => void, reject })
      this.send(make(reqId))
    })
  }

  // ── 공개 API (IPC 핸들러가 호출) ──────────────────────────────────────────

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void {
    this.rateLimitResume.cancel(workspaceId)
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    this.send({
      type: 'send',
      workspaceId,
      config: this.configFor(ws),
      text,
      images,
      prefix: opts?.prefix,
      silent: opts?.silent,
      origin: opts?.origin
    })
  }

  private sendContinuation(workspaceId: string): void {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    this.send({
      type: 'send',
      workspaceId,
      config: this.configFor(ws),
      text: RATE_LIMIT_CONTINUATION
    })
  }

  /** /btw 사이드 질문. 메인 세션과 분리된 임시 query 로 호스트가 처리한다. */
  sideQuestion(workspaceId: string, question: string): void {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    const trimmed = question.trim()
    if (!trimmed) return

    const defaults = this.defaults()
    const id = randomUUID()
    this.dispatch(IPC.evtSideQuestion, { workspaceId, id, phase: 'start', question: trimmed })
    this.send({
      type: 'sideQuestion',
      workspaceId,
      id,
      cwd: ws.worktreePath,
      resumeSessionId: ws.sessionId,
      model: ws.model ?? defaults.model,
      effort: ws.effort ?? defaults.effort,
      question: trimmed
    })
  }

  /** 인터랙티브 명령(/mcp·/context 등)을 실행해 카드용 데이터를 돌려준다. */
  async runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.request<CommandResult>((reqId) => ({
      type: 'runCommand',
      reqId,
      workspaceId,
      config: this.configFor(ws),
      kind
    }))
  }

  /** /mcp 패널의 서버별 동작(재연결·활성/비활성)을 실행하고 갱신된 서버 목록을 돌려준다. */
  async mcpAction(
    workspaceId: string,
    serverName: string,
    action: McpAction
  ): Promise<McpServerInfo[]> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.request<McpServerInfo[]>((reqId) => ({
      type: 'mcpAction',
      reqId,
      workspaceId,
      config: this.configFor(ws),
      serverName,
      action
    }))
  }

  /** /rewind — 고른 체크포인트로 추적된 파일을 되돌리고 결과를 돌려준다. */
  async rewindAction(workspaceId: string, userMessageId: string): Promise<RewindActionResult> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.request<RewindActionResult>((reqId) => ({
      type: 'rewindAction',
      reqId,
      workspaceId,
      config: this.configFor(ws),
      userMessageId
    }))
  }

  /**
   * /clear — 세션을 정리하고 대화 맥락을 초기화한다(워크스페이스·worktree 는 유지).
   * 세션 핸들을 dispose 하고 sessionId 를 비워, 다음 메시지가 빈 맥락의 새 세션으로 시작하게 한다.
   * (트랜스크립트 파일 삭제는 ipc 가 broadcastState 와 함께 처리한다.)
   */
  clearSession(workspaceId: string): void {
    this.rateLimitResume.cancel(workspaceId)
    this.dispose(workspaceId)
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) {
        w.sessionId = null
        w.status = 'idle'
      }
    })
    this.forceIdle(workspaceId)
  }

  /** 입력창 자동완성용 슬래시 명령 목록을 조회한다. */
  async listCommands(workspaceId: string, cwd: string): Promise<SlashCommandInfo[]> {
    return this.request<SlashCommandInfo[]>((reqId) => ({
      type: 'listCommands',
      reqId,
      cwd,
      team: this.delegateBackendsOf(workspaceId).length > 0
    }))
  }

  /**
   * Claude 의 모델 목록은 정적이다 — CLI 가 모델 카탈로그를 질의할 API 를 주지 않으므로,
   * 검증된 모델 ID 목록을 코드로 관리한다(backend.ts 의 CLAUDE_MODELS).
   */
  async listModels(): Promise<ModelOption[]> {
    return CLAUDE_MODELS
  }

  async interrupt(workspaceId: string): Promise<void> {
    this.rateLimitResume.cancel(workspaceId, true)
    this.sendIfHost({ type: 'interrupt', workspaceId })
    // 위임 서브런은 세션이 아니라 **메인에서** 돈다 — 호스트로 보낸 interrupt 로는 끊기지 않으므로
    // 여기서 끊는다(codex/manager.ts 가 같은 이유로 같은 줄을 갖고 있다). 이 줄이 없으면 사용자가
    // 멈춘 뒤에도 위임받은 에이전트가 계속 돌며 worktree 를 고친다 — 실측으로 확인했다:
    // 인터럽트 10초 뒤에도 `copilot --acp` 자식 프로세스가 살아 있었다.
    abortSubAgents(workspaceId)
    // 세션이 없거나 끊긴 경우에도 사이드바가 '진행 중'에 갇히지 않도록 idle 로 확정한다.
    this.forceIdle(workspaceId)
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.permissionMode = mode
    })
    this.sendIfHost({ type: 'setPermissionMode', workspaceId, mode: claudeMode(mode) })
  }

  /**
   * 모델 오버라이드를 바꾼다. 모델은 query 시작 시점에 고정되므로 기존 세션은 dispose 한다 —
   * 다음 메시지에서 새 모델로 query 를 다시 열되 resume(세션 ID)로 대화 맥락을 이어받는다.
   */
  setModel(workspaceId: string, model: string | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.model = model
    })
    this.dispose(workspaceId)
  }

  /**
   * reasoning effort 오버라이드를 바꾼다. effort 는 모델과 마찬가지로 query 시작 시점에 고정되므로
   * 기존 세션을 dispose 한다 — 다음 메시지에서 새 effort 로 query 를 다시 열되 resume(세션 ID)로
   * 대화 맥락을 이어받는다.
   */
  setEffort(workspaceId: string, effort: EffortSetting | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.effort = effort
    })
    this.dispose(workspaceId)
  }

  /**
   * fast mode 오버라이드를 바꾼다. fast mode 는 query 시작 시점의 settings 레이어로 전달되므로
   * 모델·effort 와 마찬가지로 기존 세션을 dispose 한다 — 다음 메시지에서 새 값으로 query 를 다시
   * 열되 resume(세션 ID)로 대화 맥락을 이어받는다.
   *
   * 실제 적용 여부는 CLI 가 정한다(지원 모델·플랜·쿨다운). 그래서 이전 세션이 보고했던 상태는
   * 여기서 지워, 새 세션의 result 가 알려 줄 때까지 "미확인" 으로 둔다.
   */
  setFastMode(workspaceId: string, fastMode: boolean | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) {
        w.fastMode = fastMode
        w.fastModeState = null
        w.fastModeReason = null
      }
    })
    this.dispose(workspaceId)
  }

  /**
   * `/add-dir` — worktree 밖 디렉토리를 작업 루트로 더한다.
   *
   * SDK 의 additionalDirectories 는 query 를 열 때 고정되고 세션 중에 넓힐 수 없다(제어 채널의
   * register_repo_root 는 cwd 하위만 받는다). 그래서 모델·effort 와 같은 방식으로 기존 세션을
   * dispose 하고, 다음 메시지에서 새 루트로 query 를 다시 열되 resume 으로 맥락을 이어받는다.
   */
  addDirectory(workspaceId: string, dir: string): { error?: string } {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return { error: 'Workspace not found.' }

    const abs = resolve(ws.worktreePath, expandHome(dir))
    let stat: Stats
    try {
      stat = statSync(abs)
    } catch {
      return { error: `No such directory: ${abs}` }
    }
    if (!stat.isDirectory()) return { error: `Not a directory: ${abs}` }
    // worktree 안은 이미 작업 루트다 — 더해 봐야 바뀌는 게 없으니 세션만 날리지 않도록 막는다.
    if (abs === ws.worktreePath || !relative(ws.worktreePath, abs).startsWith('..')) {
      return { error: 'That directory is already part of this workspace.' }
    }
    if ((ws.additionalDirs ?? []).includes(abs)) return { error: `Already added: ${abs}` }

    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.additionalDirs = [...(w.additionalDirs ?? []), abs]
    })
    this.dispose(workspaceId)
    return {}
  }

  /**
   * 세션 프로세스만 정리한다. **사용량 제한 예약은 건드리지 않는다** — 예약은 앱 재시작도 견디는
   * 영속 상태이고(restore), 세션은 다음 전송에서 resume 으로 되살아난다. 유휴 세션 정리나 /add-dir
   * 처럼 프로세스만 갈아 끼우는 경로가 예약을 조용히 지우면, 사이드바에서 카운트다운이 사라지고
   * 이어가기도 영영 오지 않는다. 예약을 접어야 하는 경로(/clear·중단·사용자 전송)는 직접 cancel 한다.
   */
  dispose(workspaceId: string): void {
    this.sendIfHost({ type: 'dispose', workspaceId })
    // 위임 서브런은 메인에서 돌므로 dispose 로 끊기지 않는다. 여기서 안 끊으면 워크스페이스를
    // 닫아도 자식 프로세스가 남아 worktree 를 계속 건드린다(codex/manager.ts 와 같은 이유).
    abortSubAgents(workspaceId)
    // 세션이 사라지면 그 세션이 기다리던 권한 요청은 응답받을 수 없으므로 거둔다.
    for (const [requestId, wsId] of this.pendingPermissions) {
      if (wsId !== workspaceId) continue
      this.pendingPermissions.delete(requestId)
      this.sendIfHost({ type: 'permissionResponse', requestId, decision: { behavior: 'deny' } })
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
  }

  cancelAllRateLimitResumes(): void {
    this.rateLimitResume.cancelAll()
  }

  disposeAll(): void {
    this.sendIfHost({ type: 'disposeAll' })
    for (const requestId of this.pendingPermissions.keys()) {
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
    this.pendingPermissions.clear()
  }

  /**
   * Claude 로그아웃 등으로 모든 세션의 인증이 한꺼번에 무효화됐을 때 호출한다.
   * 세션을 전부 정리하고 진행 중이던 workspace 상태를 idle 로 되돌린다.
   */
  abortAll(): void {
    this.stopAll(null)
  }

  /**
   * Claude 계정이 바뀐 뒤 호출한다 — 모든 세션의 CLI 프로세스를 버리되 **대화 맥락(sessionId)은
   * 그대로 남긴다**. 다음 메시지에서 같은 sessionId 로 resume 하므로, 터미널에서 CLI 를 껐다 켜고
   * `claude --resume` 하는 것과 결과가 같다(맥락 유지 + 새 자격증명 사용).
   *
   * 이 정리가 없으면 전환 전에 떠 있던 CLI 프로세스가 옛 토큰을 그대로 들고 있어, 전환 후 첫
   * 메시지가 그 프로세스로 흘러가 인증 오류로 죽는다(그 다음 전송은 새 프로세스라 성공한다 —
   * "한 번 실패하고 다시 보내면 되는" 증상의 원인이었다). 세션 핸들만 버리는 것이므로
   * clearSession(/clear)과 달리 sessionId·트랜스크립트는 건드리지 않는다.
   */
  recycleAll(): void {
    this.stopAll(
      'Signed in with a different Claude account. This conversation is kept — send again to continue.'
    )
  }

  /**
   * 모든 세션을 정리하고 진행 중이던 workspace 를 idle 로 되돌린다(sessionId 는 유지).
   * note 가 있으면 턴이 끊긴 workspace 의 트랜스크립트에 안내를 남긴다.
   */
  private stopAll(note: string | null): void {
    this.rateLimitResume.cancelAll()
    const running = getStore()
      .getState()
      .workspaces.filter((w) => w.status === 'running')
    this.disposeAll()
    for (const w of running) {
      if (note) {
        const item: ChatItem = {
          id: `system:recycle:${Date.now()}:${w.id}`,
          type: 'system',
          text: note,
          ts: Date.now()
        }
        getTranscripts().upsert(w.id, item)
        this.dispatch(IPC.evtChat, { workspaceId: w.id, event: { type: 'item', item } })
      }
      this.forceIdle(w.id)
    }
    if (note)
      log.info(`sessions: recycled all sessions (${running.length} running turn(s) stopped)`)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (!this.pendingPermissions.has(requestId)) return
    this.pendingPermissions.delete(requestId)
    this.sendIfHost({ type: 'permissionResponse', requestId, decision })
  }

  // ── 내부 ───────────────────────────────────────────────────────────────

  private onPermissionRequest(request: PermissionRequest): void {
    this.pendingPermissions.set(request.requestId, request.workspaceId)
    // 백그라운드 세션이 권한 대기로 멈춘 것을 놓치지 않도록 비활성 창에서는 알린다.
    this.notify(
      request.workspaceId,
      'needsInput',
      `Needs permission: ${request.displayName ?? request.toolName}`,
      false
    )
    this.dispatch(IPC.evtPermission, request)
  }

  // ── 레이트리밋(계정 단위) ────────────────────────────────────────────────

  /**
   * 턴 종료 직후의 갱신을 살짝 미뤄 한 번으로 합친다.
   *
   * 두 가지를 동시에 해결한다: (1) 턴 종료 시점엔 result 처리가 아직 흐르고 있어 제어 요청을
   * 곧바로 끼얹지 않는 편이 안전하고, (2) 워크스페이스 5~10 개가 비슷한 시각에 턴을 끝내면
   * 타이머가 계속 뒤로 밀리며 결국 조회 한 번으로 접힌다.
   */
  private scheduleRateLimitRefresh(): void {
    if (this.rateLimitDebounce) clearTimeout(this.rateLimitDebounce)
    this.rateLimitDebounce = setTimeout(() => {
      this.rateLimitDebounce = null
      void this.refreshRateLimits(false)
    }, RATE_LIMIT_DEBOUNCE_MS)
  }

  /**
   * 라이브 세션이 하나라도 있는 동안 주기적으로 갱신한다.
   *
   * 타이머는 항상 돌지만 allowShortLived=false 라, 라이브 세션이 없으면 호스트가 아무것도 하지
   * 않고 null 을 돌려준다 — 즉 유휴 상태에서는 프로세스도 네트워크도 건드리지 않는다.
   * (호스트가 아직 안 떠 있으면 명령이 outbox 에 쌓이므로, 호스트가 없을 땐 아예 보내지 않는다.)
   */
  private startRateLimitPolling(): void {
    if (this.rateLimitPoll) return
    this.rateLimitPoll = setInterval(() => {
      if (!this.host) return
      void this.refreshRateLimits(false)
    }, RATE_LIMIT_POLL_MS)
    // 메인 프로세스가 이 타이머 때문에 살아 있을 이유는 없다.
    this.rateLimitPoll.unref?.()
  }

  /**
   * 계정 레이트리밋을 다시 조회해 store 에 반영하고 렌더러로 방송한다.
   *
   * 진행 중인 조회가 있으면 새로 걸지 않고 그 promise 를 공유한다 — 워크스페이스 여러 개가
   * 동시에 턴을 끝내도 실제 조회는 하나뿐이다(과제 요구: in-flight 중복 요청 합치기).
   * 단, 이미 도는 조회가 값싼 경로(allowShortLived=false)인데 사용자가 명시적 갱신을 요청했다면
   * 그건 합치지 않는다 — 합쳤다가는 "갱신" 버튼이 null 만 받고 조용히 실패하기 때문이다.
   */
  refreshRateLimits(allowShortLived: boolean): Promise<void> {
    if (this.rateLimitInflight && !(allowShortLived && !this.rateLimitInflightForced)) {
      return this.rateLimitInflight
    }
    this.rateLimitInflightForced = allowShortLived
    const run = this.doRefreshRateLimits(allowShortLived).finally(() => {
      this.rateLimitInflight = null
      this.rateLimitInflightForced = false
    })
    this.rateLimitInflight = run
    return run
  }

  private async doRefreshRateLimits(allowShortLived: boolean): Promise<void> {
    // 배경 갱신은 절대 호스트를 새로 띄우지 않는다. request() → send() 는 ensureHost() 를 부르므로,
    // 이 가드가 없으면 "유휴 상태에서는 비용 0" 이라는 전제가 깨진다(아무 세션도 없는데 프로세스가 뜬다).
    // 사용자가 명시적으로 요청한 갱신(allowShortLived)만 호스트를 띄울 수 있다.
    if (!allowShortLived && !this.host) return

    // 단명 쿼리 폴백에 쓸 작업 디렉토리. 아카이브되지 않은 워크스페이스 아무거나면 된다 —
    // 레이트리밋은 계정 단위라 어디서 물어도 같은 값이 나온다.
    let fallback: Extract<HostCommand, { type: 'refreshUsage' }>['fallback'] = null
    if (allowShortLived) {
      const ws = getStore()
        .getState()
        .workspaces.find((w) => !w.archived)
      if (ws) {
        const config = this.configFor(ws)
        fallback = {
          cwd: ws.worktreePath,
          repoPath: config.repoPath,
          mcpSettings: config.mcpSettings
        }
      }
    }

    let usage: UsageInfo | null
    try {
      usage = await this.request<UsageInfo | null>((reqId) => ({
        type: 'refreshUsage',
        reqId,
        fallback
      }))
    } catch (err) {
      // 조회 실패는 조용히 넘긴다 — 마지막으로 성공한 스냅샷이 stale 로 계속 보이면 충분하고,
      // 배경 폴링 실패로 사용자에게 오류를 띄울 이유가 없다.
      log.info(`rate limits: refresh failed (${err instanceof Error ? err.message : String(err)})`)
      return
    }
    // 라이브 세션이 없어 조회 자체를 건너뛴 경우 — 기존 스냅샷을 그대로 둔다(stale 로 표시됨).
    if (!usage) return

    const store = getStore()
    // 라이브 세션 없이 띄운 단명 쿼리는 rate_limits_available 은 주면서 창은 비워서 온다 —
    // 실제 API 왕복이 없었으니 서버가 사용률을 실어 줄 기회가 없었던 것뿐이다. 이걸 그대로 저장하면
    // 마지막으로 알던 사용률이 앱을 켤 때마다 날아가, 상태줄과 Overview 가 "요금제 한도 없음"처럼 보인다.
    // 창이 빈 응답은 계정 종류(available·subscriptionType)만 갱신하고 창은 이전 값을 유지한다.
    const state = store.getState()
    const prev = state.rateLimitsByAgent ? state.rateLimitsByAgent.claude : state.rateLimits
    const keepPrevWindows = usage.rateLimits.length === 0 && (prev?.windows.length ?? 0) > 0
    const snapshot: RateLimitSnapshot = {
      // 창을 물려받았으면 조회 시각도 물려받는다 — 그래야 stale 표시가 실제 데이터 나이를 말한다.
      fetchedAt: keepPrevWindows ? (prev?.fetchedAt ?? Date.now()) : Date.now(),
      available: usage.rateLimitsAvailable,
      subscriptionType: usage.subscriptionType,
      windows: keepPrevWindows ? (prev?.windows ?? []) : usage.rateLimits
    }
    store.update((st) => {
      st.rateLimitsByAgent = { ...st.rateLimitsByAgent, claude: snapshot }
      // 구버전 renderer/저장 데이터와의 호환: 단일 필드는 Claude 값을 뜻한다.
      st.rateLimits = snapshot
    })
    this.dispatch(IPC.evtState, store.getState())
  }

  /**
   * workspace 를 idle 로 강제 확정한다(store + 렌더러). 완료 알림은 띄우지 않는다 —
   * 중단/크래시/인증 무효화로 푸는 경우라 "Response complete" 알림은 부적절하다.
   */
  private forceIdle(workspaceId: string): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.status = 'idle'
    })
    this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'status', status: 'idle' } })
  }

  private emit(workspaceId: string, event: ChatEvent): void {
    // 상태·모델 변화는 store 에도 반영해 재시작/새 창에서도 사이드바가 일치하도록 한다.
    if (event.type === 'status') {
      // 턴이 끝났다 — 소유자가 이어서 한 턴을 더 보냈다면 이 종료는 없던 일로 한다([[agent/backend]]
      // TurnEndHook). 여기서 빠져나가는 것이 요점이다: 아래로 내려가면 idle 이 방송돼 대화가 잠깐
      // 쉬는 것처럼 보이고, 그 틈에 사용자가 친 말이 사용자가 시작하지 않은 턴에 섞여 들어간다.
      if (event.status !== 'running' && this.onTurnEnd?.(workspaceId, event.status)) return
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) {
          w.status = event.status
          w.lastActiveAt = Date.now()
        }
      })
      // 창이 비활성일 때만 완료/에러를 OS 알림으로. (활성 창은 사이드바·알림음으로 충분)
      if (event.status === 'idle') {
        this.notify(workspaceId, 'completed', 'Response complete', false)
        // 턴이 막 끝났다 = 이 세션의 라이브 Query 가 아직 살아 있다는 뜻이라, 지금이 레이트리밋을
        // 공짜로 긁을 수 있는 가장 좋은 시점이다(프로세스 spawn 없음).
        this.scheduleRateLimitRefresh()
      } else if (event.status === 'error') this.notify(workspaceId, 'error', 'Session error', true)
    } else if (event.type === 'session' && event.model) {
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) w.lastModel = event.model ?? w.lastModel
      })
    } else if (event.type === 'fastMode') {
      // 세션이 알려 준 fast mode 실제 상태를 영속한다 — 설정을 켜 뒀어도 모델·플랜·쿨다운 때문에
      // 꺼져 있을 수 있어, 상태줄이 "설정" 이 아니라 "실제" 를 보여 주게 한다.
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) {
          w.fastModeState = event.state
          w.fastModeReason = event.reason ?? null
        }
      })
    }
    this.dispatch(IPC.evtChat, { workspaceId, event })
  }

  private onSessionId(workspaceId: string, sessionId: string): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) {
        w.sessionId = sessionId
        w.lastActiveAt = Date.now()
      }
    })
  }

  /**
   * 창이 비활성일 때 OS 알림을 띄운다. 클릭하면 창을 포커스하고 해당 workspace 를 연다.
   * 이벤트별 osNotification 채널이 꺼져 있거나 워크스페이스가 음소거면 띄우지 않는다.
   */
  private notify(
    workspaceId: string,
    event: NotificationEvent,
    body: string,
    urgent: boolean
  ): void {
    const win = this.getWindow()
    if (win && win.isFocused()) return
    if (!Notification.isSupported()) return

    const ws = this.getWorkspace(workspaceId)
    if (ws?.muted) return
    const channels = getStore().getState().settings.notifications?.[event]
    if (!channels?.osNotification) return
    const title = ws ? `${urgent ? '⚠️ ' : ''}${workspaceDisplayName(ws)}` : 'Wooi'
    // OS 알림 소리는 이벤트별 sound 채널을 따른다(설정에서 sound 를 끄면 무음 알림).
    const notification = new Notification({ title, body, silent: !channels.sound })
    notification.on('click', () => {
      const w = this.getWindow()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
      this.dispatch(IPC.evtSelectWorkspace, workspaceId)
    })
    notification.show()
  }
}
