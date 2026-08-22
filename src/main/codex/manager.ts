import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  utilityProcess,
  Notification,
  app,
  powerMonitor,
  BrowserWindow,
  type UtilityProcess
} from 'electron'
import { getStore } from '../store'
import { codexMcpServerEnv } from '../mcpSettings'
import { getTranscripts } from '../transcripts'
import { log } from '../logger'
import {
  IPC,
  agentSettingsFor,
  isQuestionPermission,
  normalizePermissionMode,
  workspaceDisplayName
} from '@shared/types'
import { CODEX_META, type AgentBackend, type TurnEndHook } from '../agent/backend'
import { canLeadAgentTeam, delegateBackendsFor } from '../agent/multiAgent'
import { delegateThreadInstructions, soloThreadInstructions } from '../subagent/catalog'
import { abortAllSubAgents, abortSubAgents } from '../agent/tools/subagent'
import { durationLabel } from './rateLimits'
import { CodexSkillsCache, mergeSkillCommands } from './skills'
import type { SkillsListResponse } from './wire'
import { RATE_LIMIT_CONTINUATION, RateLimitResumeCoordinator } from '../rateLimitResume'
import { notifyRemotePush } from '../remote'
import { shouldSendRemotePush, type RemotePushKind } from '../remote/push'
import {
  expandWooiCommand,
  matchWooiCommand,
  wooiCommandName,
  wooiCommandsFor
} from '@shared/wooiCommands'
import type { CodexCommand, CodexConfig, CodexEvent } from './protocol'
import type { ThreadGoal, ThreadGoalStatus } from './wire'
import type {
  AgentBackendId,
  AgentAuthStatus,
  AgentRateLimits,
  CodexLoginMethod,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  CodexMcpServer,
  CodexPluginDetail,
  CodexPluginInventory,
  CodexPluginRef,
  McpAction,
  McpServerInfo,
  ModelOption,
  NotificationEvent,
  RateLimitSnapshot,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RewindActionResult,
  SendMessageOptions,
  SlashCommandInfo,
  Workspace
} from '@shared/types'

type Dispatch = (channel: string, payload: unknown) => void

const CODEX_COMMAND_NAMES = new Set([
  'model',
  'effort',
  'fast',
  'agent',
  'mcp',
  'context',
  'usage',
  'permissions',
  'compact',
  'review',
  'fork',
  'rename',
  'archive',
  'delete'
])

export function parseReviewTarget(
  text: string
):
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }
  | null {
  const match = /^\/review(?:\s+([\s\S]+))?$/.exec(text.trim())
  if (!match) return null
  const args = match[1]?.trim()
  if (!args) return { type: 'uncommittedChanges' }
  const base = /^base\s+(\S+)$/.exec(args)
  if (base) return { type: 'baseBranch', branch: base[1] }
  const commit = /^commit\s+(\S+)$/.exec(args)
  if (commit) return { type: 'commit', sha: commit[1] }
  return null
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * codex 의 rate limit 창 하나를 스냅샷 모양으로. 사용률이 없으면 null 을 돌려 걸러 낸다 —
 * 0% 로 채우면 "한도를 안 썼다"로 잘못 읽힌다.
 */
function rateLimitWindow(
  fallbackLabel: string,
  window:
    { usedPercent?: number; resetsAt?: number; windowDurationMins?: number } | null | undefined
): RateLimitSnapshot['windows'][number] | null {
  if (!window || window.usedPercent === undefined) return null
  return {
    label: durationLabel(window.windowDurationMins, fallbackLabel),
    utilization: window.usedPercent,
    resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null
  }
}

/**
 * Codex 백엔드 — 워크스페이스별 Codex 스레드의 생명주기를 관리한다.
 *
 * 실제 app-server 통신은 메인이 아니라 codex-host(유틸리티 프로세스, host.ts)에서 돈다.
 * 이 클래스는 그 호스트를 spawn 하고, 명령을 메시지로 보내고, 호스트가 돌려주는 이벤트를
 * store·트랜스크립트·렌더러·OS 알림으로 반영하는 프록시다.
 *
 * NOTE(중복): 호스트 수명주기·상태 반영·알림 로직이 claude/manager.ts 와 거의 같다. 지금은
 * 의도적으로 복제해 둔다 — Claude 의 크래시 복구 경로는 가장 예민한 코드라, 새 백엔드를 들이는
 * 변경과 그 리팩터링을 한 커밋에 섞으면 문제가 생겼을 때 원인을 가릴 수 없다. 두 구현이 모두
 * 검증된 뒤 공통 베이스로 추출한다.
 */
export class CodexSessionManager implements AgentBackend {
  readonly meta = CODEX_META

  private host: UtilityProcess | null = null
  private hostReady = false
  /** 호스트가 spawn 되기 전 들어온 명령을 모았다가 'spawn' 시 비운다. */
  private outbox: CodexCommand[] = []

  // requestId → 그 승인 요청을 띄운 workspace. dispose 시 해당 요청만 골라 취소한다.
  private pendingPermissions = new Map<string, string>()
  // 요청-응답 명령(listModels)의 reqId → resolver.
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private validModelIds: Set<string> | null = null
  private readonly rateLimitResume: RateLimitResumeCoordinator
  /** 자동완성 hot path 는 이 캐시만 읽는다. app-server 의 skills/changed 알림만 이를 비운다. */
  private readonly skills = new CodexSkillsCache(async (cwd) => {
    const response = await this.request<SkillsListResponse>((reqId) => ({
      type: 'listSkills',
      reqId,
      cwd
    }))
    for (const entry of response.data) {
      for (const error of entry.errors) {
        log.warn(
          `codex: skill load failed at ${error.path ?? entry.cwd ?? cwd}: ${error.message ?? 'unknown error'}`
        )
      }
    }
    return response
  })

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null,
    private onTurnEnd?: TurnEndHook
  ) {
    this.rateLimitResume = new RateLimitResumeCoordinator({
      backend: CODEX_META.id,
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

    const entry = join(import.meta.dirname, 'codexHost.js')
    const host = utilityProcess.fork(entry, [], {
      serviceName: 'wooi-codex-host',
      // 메인이 로그인 셸로 보정한 PATH 를 그대로 물려준다 — codex 는 npm global 에 있는 경우가
      // 많아 GUI 앱의 기본 PATH 로는 찾지 못한다.
      env: {
        ...process.env,
        WOOI_USER_DATA: app.getPath('userData'),
        WOOI_LOG_NAME: 'codex-host.log',
        // 호스트는 설정 store 를 읽을 수 없다(electron `app` 이 없다) — 메인이 계산해 넘긴다.
        // 값이 fork 시점에 굳으므로 MCP 설정 변경은 앱 재시작 후 Codex 에 반영된다.
        ...codexMcpServerEnv()
      }
    })

    host.on('spawn', () => {
      this.hostReady = true
      for (const cmd of this.outbox) host.postMessage(cmd)
      this.outbox = []
    })
    host.on('message', (msg: CodexEvent) => this.onHostEvent(msg))
    host.on('exit', (code) => this.onHostExit(code))

    this.host = host
  }

  /** 호스트가 필요한 명령을 보낸다. 없으면 spawn 한다. */
  private send(cmd: CodexCommand): void {
    this.ensureHost()
    if (this.hostReady && this.host) this.host.postMessage(cmd)
    else this.outbox.push(cmd)
  }

  /** 호스트가 이미 있을 때만 의미 있는 명령(interrupt·dispose 등). 없으면 무시. */
  private sendIfHost(cmd: CodexCommand): void {
    if (!this.host) return
    if (this.hostReady) this.host.postMessage(cmd)
    else this.outbox.push(cmd)
  }

  /** 호스트가 죽으면 메인은 살아남아 진행 상태를 정리하고, 다음 사용 때 다시 spawn 한다. */
  private onHostExit(code: number | undefined): void {
    log.error(`codex-host exited (code ${code}); recovering without taking down the app`)
    this.host = null
    this.hostReady = false
    this.outbox = []

    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Codex host crashed'))
    }
    this.pendingRequests.clear()

    // 렌더러에 떠 있던 승인 프롬프트를 거둔다(응답해도 받을 호스트가 없다).
    for (const requestId of this.pendingPermissions.keys()) {
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
    this.pendingPermissions.clear()

    for (const w of getStore().getState().workspaces) {
      if (w.agentBackend === CODEX_META.id) this.clearGoalState(w.id)
    }

    for (const w of this.runningCodexWorkspaces()) {
      const item: ChatItem = {
        id: `error:codexhostcrash:${Date.now()}:${w.id}`,
        type: 'error',
        text: 'The Codex process stopped unexpectedly and was restarted. Please resend your last message.',
        ts: Date.now()
      }
      getTranscripts().upsert(w.id, item)
      this.dispatch(IPC.evtChat, { workspaceId: w.id, event: { type: 'item', item } })
      this.forceIdle(w.id)
    }
  }

  private onHostEvent(msg: CodexEvent): void {
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
        void this.rateLimitResume.noteRateLimit(msg.workspaceId)
        break
      case 'settleIdle':
        this.forceIdle(msg.workspaceId)
        break
      case 'permissionRequest':
        this.onPermissionRequest(msg.request)
        break
      case 'permissionCancel':
        this.pendingPermissions.delete(msg.requestId)
        this.dispatch(IPC.evtPermissionCancel, msg.requestId)
        break
      case 'login':
        this.dispatch(IPC.evtCodexLogin, msg.update)
        break
      case 'accountChanged':
        // 계정이 바뀌었으니 옛 자격증명을 든 스레드를 버린다(대화 맥락은 threadId 로 유지된다).
        // 렌더러에는 인증 상태를 다시 읽도록 알린다.
        this.recycleAll()
        this.dispatch(IPC.evtAuthChanged, undefined)
        break
      case 'mcpOauthLoginCompleted':
        this.dispatch(IPC.evtMcpCodexOauthLoginCompleted, {
          name: msg.name,
          success: msg.success,
          error: msg.error
        })
        break
      case 'skillsChanged':
        this.skills.invalidate()
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
    }
  }

  // ── 설정 ─────────────────────────────────────────────────────────────────

  private getWorkspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((w) => w.id === id)
  }

  /** 이 백엔드로 구동 중인(진행 중) 워크스페이스들. 호스트 크래시 복구가 대상을 좁히는 데 쓴다. */
  private runningCodexWorkspaces(): Workspace[] {
    return getStore()
      .getState()
      .workspaces.filter((w) => w.status === 'running' && w.agentBackend === CODEX_META.id)
  }

  /** store 에서 스레드 생성/재개에 필요한 설정을 계산한다. */
  /**
   * 이 워크스페이스가 위임할 수 있는 백엔드. 세션 설정(configFor)과 자동완성·확장이 같은 판단을
   * 써야 하므로 한 곳에 둔다 — 어긋나면 입력창에 뜨는 명령이 세션에는 없게 된다.
   */
  private delegateBackendsOf(workspaceId: string): AgentBackendId[] {
    const ws = this.getWorkspace(workspaceId)
    return ws ? delegateBackendsFor(ws) : []
  }

  private configFor(ws: Workspace): CodexConfig {
    const settings = getStore().getState().settings
    const defaults = agentSettingsFor(settings, CODEX_META.id)
    // 위임이 닫혀 있으면 소켓을 띄우지도 않는다 — 단일 에이전트 사용자에게 유닉스 소켓이 하나
    // 생길 이유가 없다(socketPath() 가 첫 호출에서 리슨을 시작한다).
    const backends = delegateBackendsFor(ws)
    return {
      cwd: ws.worktreePath,
      model: ws.model ?? defaults.model,
      effort: ws.effort ?? defaults.effort,
      fastMode: ws.fastMode ?? defaults.fastMode,
      autoResumeAfterRateLimit: settings.autoResumeAfterRateLimit,
      // 다른 백엔드에서 넘어온 모드가 정책 변환으로 새지 않도록 여기서 걸러 낸다.
      permissionMode: normalizePermissionMode(CODEX_META, ws.permissionMode),
      resumeThreadId: ws.sessionId,
      delegateBackends: backends,
      // Solo 라고 아무 말도 하지 않으면 Codex 는 전환 도구의 **이름조차** 보지 못한다(MCP 도구가
      // 모델의 목록에 안 뜬다 — [[subagent/catalog]] 의 실측). 팀으로 바꿀 수 있을 때만 안내한다.
      delegateInstructions: backends.length
        ? delegateThreadInstructions(backends)
        : canLeadAgentTeam(ws)
          ? soloThreadInstructions()
          : null
    }
  }

  private request<T>(make: (reqId: string) => CodexCommand): Promise<T> {
    const reqId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve: resolve as (v: unknown) => void, reject })
      this.send(make(reqId))
    })
  }

  // ── 핵심 API ─────────────────────────────────────────────────────────────

  prewarm(): void {
    this.send({ type: 'prewarm' })
  }

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void {
    this.rateLimitResume.cancel(workspaceId)
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return

    // Claude Code 는 `/compact` 를 CLI 가 직접 해석하지만, Codex 로는 그냥 모델에게 가는 텍스트가
    // 된다("압축해 줘"라고 말을 거는 셈). 전용 RPC 로 돌려 실제로 압축되게 한다.
    if (!images?.length && text.trim() === '/compact') {
      this.send({ type: 'compact', workspaceId, config: this.configFor(ws) })
      return
    }
    const reviewTarget = !images?.length ? parseReviewTarget(text) : null
    if (reviewTarget) {
      this.send({ type: 'review', workspaceId, config: this.configFor(ws), target: reviewTarget })
      return
    }
    // `/wooi:*` 는 Wooi 커맨드다. Claude 는 CLI 가 플러그인 본문으로 확장해 주지만 Codex 는
    // app-server 에 확장 RPC 가 없어(슬래시 처리가 TUI 크레이트에만 있다) 그냥 모델에게 가는
    // 텍스트가 된다 — `/compact`·`/review` 를 전용 RPC 로 돌리는 것과 같은 이유로 여기서 푼다.
    // 즉시 실행 명령(mode: 'direct')은 렌더러가 이미 가로챘으므로 여기까지 오지 않는다.
    const wooi = !images?.length
      ? matchWooiCommand(text, this.delegateBackendsOf(workspaceId))
      : null
    if (wooi) {
      this.send({
        type: 'send',
        workspaceId,
        config: this.configFor(ws),
        text: expandWooiCommand(wooi.spec, wooi.rest)
      })
      return
    }

    if (!images?.length) {
      const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      const skill =
        match && !CODEX_COMMAND_NAMES.has(match[1])
          ? this.skills.find(ws.worktreePath, match[1])
          : undefined
      if (skill) {
        this.send({
          type: 'send',
          workspaceId,
          config: this.configFor(ws),
          text,
          skill: { name: skill.name, path: skill.path, prompt: match?.[2] ?? '' }
        })
        return
      }

      // 전체 입력이 슬래시 명령처럼 생길 때만 막는다. 문장 중간의 경로·URL은 평범한 프롬프트다.
      // 설치된 skill은 바로 위에서 먼저 찾으므로 동적 `/skill-name` 명령도 계속 동작한다.
      if (match) {
        const usage =
          match[1] === 'review'
            ? 'Use /review, /review base <branch>, or /review commit <sha>.'
            : match[1] === 'delete'
              ? '/delete is unavailable because Wooi cannot make its scope and confirmation unambiguous from chat.'
              : `Unknown or unsupported command: /${match[1]}`
        const item: ChatItem = {
          id: `codex:command:${randomUUID()}`,
          type: 'system',
          text: usage,
          ts: Date.now()
        }
        getTranscripts().upsert(workspaceId, item)
        this.emit(workspaceId, { type: 'item', item })
        return
      }
    }

    if (!images?.length && text.trim().startsWith('!')) {
      const command = text.trim().slice(1).trim()
      if (command) this.send({ type: 'shell', workspaceId, config: this.configFor(ws), command })
      return
    }

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

  async interrupt(workspaceId: string): Promise<void> {
    this.rateLimitResume.cancel(workspaceId, true)
    this.sendIfHost({ type: 'interrupt', workspaceId })
    // 위임 서브런은 세션이 아니라 메인에서 돈다 — 스레드 인터럽트로는 끊기지 않으므로 여기서 끊는다.
    abortSubAgents(workspaceId)
    // 스레드가 없거나 끊긴 경우에도 사이드바가 '진행 중'에 갇히지 않도록 idle 로 확정한다.
    this.forceIdle(workspaceId)
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.permissionMode = mode
    })
    this.sendIfHost({ type: 'setPermissionMode', workspaceId, mode })
  }

  async setGoal(
    workspaceId: string,
    args: {
      objective?: string | null
      status?: ThreadGoalStatus | null
      tokenBudget?: number | null
    }
  ): Promise<ThreadGoal> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.request((reqId) => ({
      type: 'goalSet',
      reqId,
      workspaceId,
      config: this.configFor(ws),
      ...args
    }))
  }

  async getGoal(workspaceId: string): Promise<ThreadGoal | null> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.request((reqId) => ({
      type: 'goalGet',
      reqId,
      workspaceId,
      config: this.configFor(ws)
    }))
  }

  async clearGoal(workspaceId: string): Promise<void> {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    await this.request((reqId) => ({
      type: 'goalClear',
      reqId,
      workspaceId,
      config: this.configFor(ws)
    }))
  }

  /**
   * 모델 오버라이드를 바꾼다. Codex 는 모델을 **턴 파라미터**로 받으므로 세션을 버릴 필요가 없다 —
   * 다음 턴부터 새 모델이 적용되고 대화 맥락은 그대로 이어진다(Claude 는 재시작이 필요하다).
   */
  setModel(workspaceId: string, model: string | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.model = model
    })
  }

  /** effort 도 모델과 마찬가지로 턴 파라미터라 세션 재시작이 필요 없다. */
  setEffort(workspaceId: string, effort: EffortSetting | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.effort = effort
    })
  }

  setFastMode(workspaceId: string, fastMode: boolean | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.fastMode = fastMode
    })
    this.dispatch(IPC.evtChat, {
      workspaceId,
      event: { type: 'fastMode', state: fastMode ? 'on' : 'off' }
    })
  }

  /**
   * 계정 레이트리밋을 다시 조회해 store 에 반영한다.
   *
   * Codex 도 ChatGPT 플랜 사용량을 제공하므로(`account/rateLimits/read`) Claude 와 같은 스냅샷
   * 모양으로 채운다. 다만 조회에 app-server 가 필요해, 배경 갱신(allowShortLived=false)은 호스트가
   * 이미 떠 있을 때만 한다 — 유휴 상태에서 프로세스를 띄우지 않기 위함이다(Claude 와 같은 규칙).
   */
  async refreshRateLimits(allowShortLived: boolean): Promise<void> {
    if (!allowShortLived && !this.host) return

    let limits: AgentRateLimits | null
    try {
      limits = await this.rateLimits()
    } catch (err) {
      // 배경 폴링 실패로 사용자에게 오류를 띄울 이유가 없다 — 마지막 스냅샷이 stale 로 남으면 충분하다.
      log.info(`codex rate limits: refresh failed (${describe(err)})`)
      return
    }

    const windows = [
      rateLimitWindow('Primary', limits?.primary),
      rateLimitWindow('Secondary', limits?.secondary)
    ].filter((w): w is RateLimitSnapshot['windows'][number] => w !== null)

    const store = getStore()
    // 창이 빈 응답으로 마지막으로 알던 사용률을 날리지 않는다(Claude 경로와 같은 이유).
    const prev = store.getState().rateLimitsByAgent?.codex
    const keepPrev = windows.length === 0 && (prev?.windows.length ?? 0) > 0
    const snapshot: RateLimitSnapshot = {
      fetchedAt: keepPrev ? (prev?.fetchedAt ?? Date.now()) : Date.now(),
      // API 키 인증이면 플랜 한도 개념이 없어 null 이 온다 — 그때는 UI 가 통째로 숨긴다.
      available: !!limits,
      subscriptionType: null,
      windows: keepPrev ? (prev?.windows ?? []) : windows
    }
    store.update((st) => {
      st.rateLimitsByAgent = { ...st.rateLimitsByAgent, codex: snapshot }
    })
    this.dispatch(IPC.evtState, store.getState())
  }

  /**
   * 맥락을 비우고 새 스레드로 시작한다(워크스페이스·worktree 유지).
   * 트랜스크립트는 건드리지 않는다 — 화면 비우기는 렌더러의 resetTranscript 가 맡는다(Claude 와 동일).
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
    this.clearGoalState(workspaceId)
  }

  /**
   * 스레드만 정리한다. 사용량 제한 예약은 유지한다 — 예약은 영속 상태라 프로세스 정리로 사라지면
   * 안 된다(Claude manager 의 dispose 주석 참고). 예약을 접는 건 /clear·중단·사용자 전송의 몫이다.
   */
  dispose(workspaceId: string): void {
    this.sendIfHost({ type: 'dispose', workspaceId })
    // 위임 서브런은 메인에서 돌므로 dispose 로 끊기지 않는다. 여기서 안 끊으면 워크스페이스를
    // 닫아도 자식 프로세스가 남아 worktree 를 계속 건드린다.
    abortSubAgents(workspaceId)
    this.clearGoalState(workspaceId)
    // 스레드가 사라지면 그 스레드가 기다리던 승인 요청은 응답받을 수 없으므로 거둔다.
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
    abortAllSubAgents()
    for (const ws of getStore().getState().workspaces) {
      if (ws.agentBackend === CODEX_META.id) this.clearGoalState(ws.id)
    }
    for (const requestId of this.pendingPermissions.keys()) {
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
    this.pendingPermissions.clear()
  }

  abortAll(): void {
    this.stopAll(null)
  }

  /**
   * 계정이 바뀐 뒤 호출한다 — 호스트를 버리되 **대화 맥락(threadId)은 유지**한다.
   * 다음 메시지가 같은 threadId 로 resume 하므로 새 자격증명으로 대화가 이어진다.
   */
  recycleAll(): void {
    this.stopAll(
      'Signed in with a different Codex account. This conversation is kept — send again to continue.'
    )
  }

  private stopAll(note: string | null): void {
    this.rateLimitResume.cancelAll()
    const running = this.runningCodexWorkspaces()
    this.disposeAll()
    for (const w of running) {
      if (note) {
        const item: ChatItem = {
          id: `system:codexrecycle:${Date.now()}:${w.id}`,
          type: 'system',
          text: note,
          ts: Date.now()
        }
        getTranscripts().upsert(w.id, item)
        this.dispatch(IPC.evtChat, { workspaceId: w.id, event: { type: 'item', item } })
      }
      this.forceIdle(w.id)
    }
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (!this.pendingPermissions.has(requestId)) return
    this.pendingPermissions.delete(requestId)
    this.sendIfHost({ type: 'permissionResponse', requestId, decision })
  }

  /** codex 카탈로그의 모델 목록(model/list). */
  async listModels(): Promise<ModelOption[]> {
    const models = await this.request<ModelOption[]>((reqId) => ({ type: 'listModels', reqId }))
    if (models.length === 0) return models

    this.validModelIds = new Set(models.map((model) => model.id))
    this.reconcileStoredModels()
    return models
  }

  /**
   * 별도 model/list 요청을 만들지 않고 이미 UI 카탈로그 갱신에 쓰이는 성공 응답에만 올라탄다 —
   * 턴 시작을 막지 않으면서 같은 시점의 실제 선택지를 근거로 삼기 위해서다. 실패·빈 목록은
   * app-server 준비 전일 수 있으므로 "전부 은퇴"가 아니라 "아직 모름"으로 취급한다. 사라진 모델은
   * 후속 모델을 추측하지 않고 null 로 돌려 Codex 카탈로그가 정한 기본값을 따르게 한다.
   */
  private reconcileStoredModels(): void {
    const validModelIds = this.validModelIds
    if (!validModelIds || validModelIds.size === 0) return

    const store = getStore()
    const state = store.getState()
    const hasStaleWorkspaceModel = state.workspaces.some(
      (workspace) =>
        workspace.agentBackend === CODEX_META.id &&
        !!workspace.model &&
        !validModelIds.has(workspace.model)
    )
    const codexDefaultModel = state.settings.agents.codex.model
    const hasStaleDefault = !!codexDefaultModel && !validModelIds.has(codexDefaultModel)
    if (!hasStaleWorkspaceModel && !hasStaleDefault) return

    let changed = false
    store.update((st) => {
      for (const workspace of st.workspaces) {
        const model = workspace.model
        if (workspace.agentBackend !== CODEX_META.id || !model || validModelIds.has(model)) continue
        log.info(`codex model catalog: dropped stored model ${model} for workspace ${workspace.id}`)
        workspace.model = null
        changed = true
      }

      const defaults = st.settings.agents.codex
      if (defaults.model && !validModelIds.has(defaults.model)) {
        log.info(
          `codex model catalog: dropped stored default model ${defaults.model} for Codex settings`
        )
        defaults.model = null
        changed = true
      }
    })
    if (changed) this.dispatch(IPC.evtState, store.getState())
  }

  // ── 계정 ─────────────────────────────────────────────────────────────────

  /** 설치·로그인 상태. auth 계층이 통합 인증 상태를 만들 때 호출한다. */
  accountStatus(): Promise<AgentAuthStatus> {
    return this.request<AgentAuthStatus>((reqId) => ({ type: 'accountStatus', reqId }))
  }

  /** ChatGPT 플랜 사용량. API 키 인증이거나 조회 불가면 null. */
  rateLimits(): Promise<AgentRateLimits | null> {
    return this.request<AgentRateLimits | null>((reqId) => ({ type: 'rateLimits', reqId }))
  }

  /**
   * 로그인을 시작한다. ChatGPT 방식은 브라우저를 열고 완료 알림을 기다리며(evtCodexLogin),
   * API 키 방식은 곧바로 끝난다.
   */
  loginStart(method: CodexLoginMethod, apiKey?: string): Promise<void> {
    return this.request<void>((reqId) => ({ type: 'loginStart', reqId, method, apiKey }))
  }

  loginCancel(): void {
    this.sendIfHost({ type: 'loginCancel' })
  }

  logout(): Promise<void> {
    return this.request<void>((reqId) => ({ type: 'logout', reqId }))
  }

  // ── capability 미지원 (오케스트레이터가 capabilities 로 먼저 가드한다) ────

  sideQuestion(): void {
    // capabilities.sideQuestion=false — 호출되지 않는다.
  }

  /** /context·/usage·/permissions 카드. 지원 범위는 meta.capabilities.interactiveCommands. */
  runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    return this.request<CommandResult>((reqId) => ({
      type: 'runCommand',
      reqId,
      workspaceId,
      kind
    }))
  }

  /** /compact — 대화 압축을 시작한다. 진행 상황은 일반 턴 이벤트로 흘러온다. */
  compact(workspaceId: string): void {
    const ws = this.getWorkspace(workspaceId)
    if (ws) this.send({ type: 'compact', workspaceId, config: this.configFor(ws) })
  }

  mcpAction(_workspaceId: string, serverName: string, action: McpAction): Promise<McpServerInfo[]> {
    return this.request<McpServerInfo[]>((reqId) => ({
      type: 'mcpAction',
      reqId,
      serverName,
      action
    }))
  }

  /** 설정 화면용 — `~/.codex/config.toml` 에 설정된 MCP 서버 목록(워크스페이스와 무관). */
  listConfiguredMcpServers(): Promise<CodexMcpServer[]> {
    return this.request<CodexMcpServer[]>((reqId) => ({ type: 'mcpConfigList', reqId }))
  }

  /** 그 서버의 `enabled` 를 사용자 파일에 쓰고, 갱신된 목록을 돌려준다. */
  setMcpServerEnabled(serverName: string, enabled: boolean): Promise<CodexMcpServer[]> {
    return this.request<CodexMcpServer[]>((reqId) => ({
      type: 'mcpSetEnabled',
      reqId,
      serverName,
      enabled
    }))
  }

  /** Codex 가 호스팅하는 OAuth 콜백 흐름을 시작하고 브라우저용 URL 을 돌려준다. */
  loginMcpServer(serverName: string): Promise<string> {
    return this.request<string>((reqId) => ({ type: 'mcpOauthLogin', reqId, serverName }))
  }

  /** 설정 화면용 — 이 설치본에 깔린 Agent Plugins(워크스페이스와 무관). */
  listPlugins(cwds: string[]): Promise<CodexPluginInventory> {
    return this.request<CodexPluginInventory>((reqId) => ({ type: 'pluginList', reqId, cwds }))
  }

  /** 그중 하나가 무엇을 싣고 있는지. 목록 행을 펼칠 때만 부른다. */
  readPlugin(ref: CodexPluginRef): Promise<CodexPluginDetail> {
    return this.request<CodexPluginDetail>((reqId) => ({ type: 'pluginRead', reqId, ref }))
  }

  rewindAction(): Promise<RewindActionResult> {
    return Promise.reject(new Error('Codex does not support rewind.'))
  }

  async listCommands(workspaceId: string, cwd: string): Promise<SlashCommandInfo[]> {
    const backends = this.delegateBackendsOf(workspaceId)
    const commands: SlashCommandInfo[] = [
      { name: 'model', description: 'Choose the model' },
      { name: 'effort', description: 'Choose reasoning effort' },
      { name: 'fast', description: 'Toggle Fast service tier' },
      // Wooi 가 로컬에서 처리하는 명령. 고를 에이전트가 둘 이상일 때만 통한다
      // (하나뿐이면 평범한 메시지로 나간다).
      { name: 'agent', description: 'Switch this workspace’s agent' },
      { name: 'mcp', description: 'Show MCP servers and tools' },
      { name: 'context', description: 'Show context usage' },
      { name: 'usage', description: 'Show plan usage' },
      { name: 'permissions', description: 'Show active permissions' },
      { name: 'compact', description: 'Compact the conversation' },
      { name: 'review', description: 'Review uncommitted changes' },
      // `/wooi:*` — Wooi 내장 도구를 직접 부르는 명령([[shared/wooiCommands]]).
      // Claude 는 같은 목록을 플러그인으로 받아 CLI 가 알아서 실어 주지만(agent/plugin.ts),
      // Codex 는 app-server 로 몰기 때문에 여기서 손으로 실어야 한다. 슬래시 확장이 Codex 의
      // TUI 크레이트에만 있고 app-server RPC 에는 없어서, 확장도 sendMessage 가 직접 한다.
      ...wooiCommandsFor(backends).map((c) => ({
        name: wooiCommandName(c),
        description: c.description,
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {})
      }))
    ]
    const response = await this.skills.list(cwd)
    return mergeSkillCommands(commands, response)
  }

  // ── 내부 ───────────────────────────────────────────────────────────────

  private onPermissionRequest(request: PermissionRequest): void {
    this.pendingPermissions.set(request.requestId, request.workspaceId)
    // 질문은 승인과 다른 말로 알린다 — claude/manager 의 같은 자리와 같은 규칙이다.
    const question = isQuestionPermission(request)
    this.notify(
      request.workspaceId,
      'needsInput',
      question
        ? 'Has a question for you'
        : `Needs permission: ${request.displayName ?? request.toolName}`,
      false,
      question ? 'question' : 'needsInput'
    )
    this.dispatch(IPC.evtPermission, request)
  }

  /** workspace 를 idle 로 강제 확정한다(store + 렌더러). 완료 알림은 띄우지 않는다. */
  private forceIdle(workspaceId: string): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.status = 'idle'
    })
    this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'status', status: 'idle' } })
  }

  private clearGoalState(workspaceId: string): void {
    this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'goal', goal: null } })
  }

  private emit(workspaceId: string, event: ChatEvent): void {
    if (event.type === 'status') {
      // 턴이 끝났다 — 소유자가 이어서 한 턴을 더 보냈다면 이 종료는 없던 일로 한다(Claude 쪽 emit
      // 과 같은 규칙이고, 같아야 한다. 한쪽만 고치면 백엔드에 따라 자동 재개가 되기도 안 되기도
      // 한다). 왜 idle 을 방송하면 안 되는지는 [[agent/orchestrator]] 의 handleTurnEnd 에 있다.
      if (event.status !== 'running' && this.onTurnEnd?.(workspaceId, event.status)) return
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) {
          w.status = event.status
          w.lastActiveAt = Date.now()
        }
      })
      if (event.status === 'idle') this.notify(workspaceId, 'completed', 'Response complete', false)
      else if (event.status === 'error') this.notify(workspaceId, 'error', 'Session error', true)
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

  /** 창이 비활성일 때 OS 알림을 띄운다. 클릭하면 창을 포커스하고 해당 workspace 를 연다. */
  private notify(
    workspaceId: string,
    event: NotificationEvent,
    body: string,
    urgent: boolean,
    /**
     * 폰 배너의 종류. 기본은 설정 이벤트와 같지만 갈릴 수 있다 — 질문은 설정에서는
     * 'needsInput' 채널을 따르면서도 배너에서는 승인과 다른 말을 해야 한다(remote/push.ts).
     */
    pushKind: RemotePushKind = event
  ): void {
    const win = this.getWindow()
    const ws = this.getWorkspace(workspaceId)
    if (ws?.muted) return
    const channels = getStore().getState().settings.notifications?.[event]
    if (!channels?.osNotification) return

    const focused = win?.isFocused() === true
    // 폰 푸시는 데스크톱을 쓰고 있지 않을 때만 보낸다(설정으로 항상 보내게 할 수 있다).
    // 포커스는 메인 창이 아니라 Wooi 창 전체로 본다 — 분리한 패널도 데스크톱을 쓰는 중이다.
    if (
      shouldSendRemotePush({
        appFocused: BrowserWindow.getFocusedWindow() !== null,
        idleSeconds: powerMonitor.getSystemIdleTime(),
        always: getStore().getState().settings.remotePushWhileActive === true
      })
    ) {
      notifyRemotePush(workspaceId, ws ? workspaceDisplayName(ws) : 'Workspace', pushKind)
    }
    if (focused || !Notification.isSupported()) return

    const title = ws ? `${urgent ? '⚠️ ' : ''}${workspaceDisplayName(ws)}` : 'Wooi'
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
