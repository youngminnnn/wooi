import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  utilityProcess,
  Notification,
  app,
  type BrowserWindow,
  type UtilityProcess
} from 'electron'
import { getStore } from '../store'
import { getTranscripts } from '../transcripts'
import { log } from '../logger'
import { IPC, workspaceDisplayName } from '@shared/types'
import { CLAUDE_META, type AgentBackend } from '../agent/backend'
import type { HostCommand, HostEvent, SessionConfig } from './protocol'
import type {
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  NotificationEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RewindActionResult,
  SlashCommandInfo,
  Workspace
} from '@shared/types'

type Dispatch = (channel: string, payload: unknown) => void

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

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null
  ) {}

  // ── 호스트 프로세스 ──────────────────────────────────────────────────────

  private ensureHost(): void {
    if (this.host) return

    const entry = join(import.meta.dirname, 'host.js')
    const host = utilityProcess.fork(entry, [], {
      serviceName: 'wooi-agent-host',
      // 메인이 로그인 셸로 보정한 PATH·토큰을 그대로 물려준다(자식 claude CLI 가 인증/설정을
      // 읽을 수 있도록). app 이 없는 유틸리티 프로세스용으로 userData·패키징 여부를 넘긴다.
      env: {
        ...process.env,
        WOOI_USER_DATA: app.getPath('userData'),
        WOOI_LOG_NAME: 'host.log',
        WOOI_PACKAGED: app.isPackaged ? '1' : ''
      }
    })

    host.on('spawn', () => {
      this.hostReady = true
      for (const cmd of this.outbox) host.postMessage(cmd)
      this.outbox = []
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
      case 'settleIdle':
        this.forceIdle(msg.workspaceId)
        break
      case 'permissionRequest':
        this.onPermissionRequest(msg.request)
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
    }
  }

  // ── 설정 ─────────────────────────────────────────────────────────────────

  private getWorkspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((w) => w.id === id)
  }

  private getRepoPath(repoId: string): string | null {
    return (
      getStore()
        .getState()
        .repos.find((r) => r.id === repoId)?.path ?? null
    )
  }

  /** store 에서 세션 생성에 필요한 설정을 계산한다(예전 ensure() 의 역할). */
  private configFor(ws: Workspace): SessionConfig {
    const settings = getStore().getState().settings
    return {
      cwd: ws.worktreePath,
      repoPath: this.getRepoPath(ws.repoId),
      model: ws.model ?? settings.model,
      effort: ws.effort ?? settings.effort,
      permissionMode: ws.permissionMode,
      autoCompact: settings.autoCompact,
      resumeSessionId: ws.sessionId
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

  sendMessage(workspaceId: string, text: string, images?: ImageAttachment[]): void {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    this.send({ type: 'send', workspaceId, config: this.configFor(ws), text, images })
  }

  /** /btw 사이드 질문. 메인 세션과 분리된 임시 query 로 호스트가 처리한다. */
  sideQuestion(workspaceId: string, question: string): void {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return
    const trimmed = question.trim()
    if (!trimmed) return

    const settings = getStore().getState().settings
    const id = randomUUID()
    this.dispatch(IPC.evtSideQuestion, { workspaceId, id, phase: 'start', question: trimmed })
    this.send({
      type: 'sideQuestion',
      workspaceId,
      id,
      cwd: ws.worktreePath,
      resumeSessionId: ws.sessionId,
      model: ws.model ?? settings.model,
      effort: ws.effort ?? settings.effort,
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
  async listCommands(cwd: string): Promise<SlashCommandInfo[]> {
    return this.request<SlashCommandInfo[]>((reqId) => ({ type: 'listCommands', reqId, cwd }))
  }

  async interrupt(workspaceId: string): Promise<void> {
    this.sendIfHost({ type: 'interrupt', workspaceId })
    // 세션이 없거나 끊긴 경우에도 사이드바가 '진행 중'에 갇히지 않도록 idle 로 확정한다.
    this.forceIdle(workspaceId)
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.permissionMode = mode
    })
    this.sendIfHost({ type: 'setPermissionMode', workspaceId, mode })
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

  dispose(workspaceId: string): void {
    this.sendIfHost({ type: 'dispose', workspaceId })
    // 세션이 사라지면 그 세션이 기다리던 권한 요청은 응답받을 수 없으므로 거둔다.
    for (const [requestId, wsId] of this.pendingPermissions) {
      if (wsId !== workspaceId) continue
      this.pendingPermissions.delete(requestId)
      this.sendIfHost({ type: 'permissionResponse', requestId, decision: { behavior: 'deny' } })
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
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
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) {
          w.status = event.status
          w.lastActiveAt = Date.now()
        }
      })
      // 창이 비활성일 때만 완료/에러를 OS 알림으로. (활성 창은 사이드바·알림음으로 충분)
      if (event.status === 'idle') this.notify(workspaceId, 'completed', 'Response complete', false)
      else if (event.status === 'error') this.notify(workspaceId, 'error', 'Session error', true)
    } else if (event.type === 'session' && event.model) {
      getStore().update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) w.lastModel = event.model ?? w.lastModel
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
