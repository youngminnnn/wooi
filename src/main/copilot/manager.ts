import { Notification, type BrowserWindow } from 'electron'
import { IPC, normalizePermissionMode, workspaceDisplayName } from '@shared/types'
import type {
  AgentRateLimits,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  ImageAttachment,
  McpServerInfo,
  ModelOption,
  NotificationEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RewindActionResult,
  SendMessageOptions,
  SlashCommandInfo,
  Workspace
} from '@shared/types'
import { randomUUID } from 'node:crypto'
import { COPILOT_META, type AgentBackend, type TurnEndHook } from '../agent/backend'
import { abortAllSubAgents, abortSubAgents } from '../agent/tools/subagent'
import { log } from '../logger'
import { getStore } from '../store'
import { getTranscripts } from '../transcripts'
import { CopilotConnection, type CopilotHost, type CopilotSessionConfig } from './session'

type Dispatch = (channel: string, payload: unknown) => void

/**
 * GitHub Copilot CLI 백엔드 — 워크스페이스별 ACP 세션의 생명주기를 관리한다.
 *
 * Claude·Codex 와 달리 **유틸리티 프로세스를 쓰지 않는다.** 그 호스트들의 존재 이유는
 * Agent SDK·app-server 의 fatal 을 메인에서 격리하는 것인데, 여기서 우리가 하는 일은 자식
 * 프로세스의 ndjson 을 읽는 JSON-RPC 클라이언트뿐이라 Copilot 이 죽어도 stdout EOF 로
 * 나타난다(→ [[copilot/session]] 의 teardown). 그 대가로 호스트 수명주기·메시지 프로토콜·
 * 크래시 복구를 세 번째로 복제하지 않는다.
 *
 * 프로세스는 **전체에 하나**고 세션이 워크스페이스마다 하나다(실측: 한 연결이 서로 다른 cwd 의
 * 세션을 병렬로 돌린다).
 */
export class CopilotSessionManager implements AgentBackend {
  readonly meta = COPILOT_META

  private connection: CopilotConnection
  /** requestId → 그 승인 요청을 기다리는 resolver + 워크스페이스. */
  private pendingPermissions = new Map<
    string,
    { workspaceId: string; resolve: (decision: PermissionDecision) => void }
  >()
  /** workspaceId → `/add-dir` 로 더한 디렉터리. 세션을 새로 열 때마다 다시 얹는다. */
  private extraDirs = new Map<string, string[]>()

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null,
    private onTurnEnd?: TurnEndHook
  ) {
    const host: CopilotHost = {
      emit: (workspaceId, event) => this.emit(workspaceId, event),
      persist: (workspaceId, item) => getTranscripts().upsert(workspaceId, item),
      noteSessionId: (workspaceId, sessionId) => this.onSessionId(workspaceId, sessionId),
      askPermission: (request) => this.askPermission(request),
      onDisconnect: (reason) => this.onDisconnect(reason)
    }
    this.connection = new CopilotConnection(host)
  }

  // ── 설정 ─────────────────────────────────────────────────────────────────

  private getWorkspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((w) => w.id === id)
  }

  /** 이 백엔드로 구동 중인(진행 중) 워크스페이스들. 연결이 끊겼을 때 복구 대상을 좁힌다. */
  private runningWorkspaces(): Workspace[] {
    return getStore()
      .getState()
      .workspaces.filter((w) => w.status === 'running' && w.agentBackend === COPILOT_META.id)
  }

  private configFor(ws: Workspace): CopilotSessionConfig {
    return {
      cwd: ws.worktreePath,
      // 다른 백엔드에서 넘어온 모드(acceptEdits·readOnly)가 그대로 새지 않도록 여기서 거른다.
      permissionMode: normalizePermissionMode(COPILOT_META, ws.permissionMode),
      resumeSessionId: ws.sessionId,
      extraDirs: this.extraDirs.get(ws.id) ?? []
    }
  }

  private sessionFor(workspaceId: string): ReturnType<CopilotConnection['session']> | null {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return null
    return this.connection.session(workspaceId, this.configFor(ws))
  }

  // ── 핵심 API ─────────────────────────────────────────────────────────────

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void {
    const session = this.sessionFor(workspaceId)
    if (!session) return

    // 기록에는 사용자의 말만, 모델에게는 접두사까지 합쳐 보낸다([[agent/backend]] sendMessage).
    if (!opts?.silent) {
      const item: ChatItem = {
        id: `user:${randomUUID()}`,
        type: 'user',
        text,
        ts: Date.now(),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(images?.length
          ? { attachments: images.map((i) => ({ name: i.name, mediaType: i.mediaType })) }
          : {})
      }
      getTranscripts().upsert(workspaceId, item)
      this.emit(workspaceId, { type: 'item', item })
    }

    // Copilot 은 슬래시 명령을 **CLI 가 직접** 해석한다(프롬프트 텍스트로 보내면 모델을 거치지
    // 않고 실행된다 — 실측). 그래서 Codex 처럼 Wooi 가 `/compact`·`/review` 를 전용 RPC 로
    // 돌리거나 손으로 확장할 필요가 없다. 그대로 흘려보내면 된다.
    const prompt = opts?.prefix ? `${opts.prefix}\n\n${text}` : text
    void session.prompt(prompt, images).catch((err) => this.fail(workspaceId, err))
  }

  async interrupt(workspaceId: string): Promise<void> {
    await this.connection.existing(workspaceId)?.cancel()
    // 위임 서브런은 세션이 아니라 메인에서 돈다 — ACP cancel 로는 끊기지 않으므로 여기서 끊는다.
    abortSubAgents(workspaceId)
    // 세션이 없거나 취소가 실패한 경우에도 사이드바가 '진행 중'에 갇히지 않도록 확정한다.
    this.forceIdle(workspaceId)
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.permissionMode = mode
    })
    const session = this.connection.existing(workspaceId)
    if (!session) return
    await session
      .setPermissionMode(normalizePermissionMode(COPILOT_META, mode))
      .catch((err) => log.info(`copilot: set permission mode failed (${describe(err)})`))
  }

  /**
   * 모델 오버라이드. store 에만 적는다 — Copilot 에 넘길 자리가 없기 때문이다
   * ([[agent/backend]] COPILOT_META 의 근거). 모델 피커도 비어 있어(listModels) 실제로는
   * 이 경로로 값이 들어오지 않는다.
   */
  setModel(workspaceId: string, model: string | null): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.model = model
    })
  }

  /**
   * 맥락을 비우고 새 세션으로 시작한다(워크스페이스·worktree 유지).
   * 트랜스크립트는 건드리지 않는다 — 화면 비우기는 렌더러의 resetTranscript 가 맡는다.
   */
  clearSession(workspaceId: string): void {
    this.connection.existing(workspaceId)?.clear()
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) {
        w.sessionId = null
        w.status = 'idle'
      }
    })
    this.forceIdle(workspaceId)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    pending.resolve(decision)
  }

  dispose(workspaceId: string): void {
    this.connection.dispose(workspaceId)
    // 위임 서브런은 메인에서 돌므로 세션 정리로 끊기지 않는다. 여기서 안 끊으면 워크스페이스를
    // 닫아도 자식 프로세스가 남아 worktree 를 계속 건드린다.
    abortSubAgents(workspaceId)
    this.cancelPermissionsOf(workspaceId)
  }

  disposeAll(): void {
    this.connection.disposeAll()
    abortAllSubAgents()
    this.cancelPermissionsOf(null)
  }

  abortAll(): void {
    this.stopAll(null)
  }

  /**
   * 계정이 바뀐 뒤 호출한다 — 프로세스를 버리되 **대화 맥락(sessionId)은 유지**한다.
   * 다음 메시지가 같은 sessionId 로 `session/load` 하므로 새 자격증명으로 대화가 이어진다.
   */
  recycleAll(): void {
    this.stopAll(
      'Signed in with a different GitHub account. This conversation is kept — send again to continue.'
    )
  }

  private stopAll(note: string | null): void {
    const running = this.runningWorkspaces()
    this.disposeAll()
    for (const w of running) {
      if (note) this.systemNote(w.id, note)
      this.forceIdle(w.id)
    }
  }

  /**
   * 모델 선택지 — **없다**. 문서에 있는 경로를 전부 실측했고 ACP 로는 하나도 닿지 않는다.
   *
   *  - `session/new` 에 모델 필드가 없다(ACP v1).
   *  - `providers/list` → "Method not found".
   *  - 서버 플래그 `--model <id>` → **조용히 무시된다.** 없는 모델 이름을 줘도 서버가 뜨고
   *    `/model` 은 여전히 선택된 모델이 없다고 답한다(같은 플래그를 비대화형 `copilot -p` 에
   *    주면 즉시 거절하므로, 파싱이 안 되는 게 아니라 ACP 경로가 안 읽는 것이다).
   *  - `COPILOT_MODEL` 환경변수 → 위와 똑같이 무시된다.
   *  - `/model <id>` 슬래시 명령 → "Switched model to: …" 라고 답하지만 곧바로 `/model` 을
   *    물으면 선택된 모델이 없다. 존재하지 않는 이름조차 그대로 받는다.
   *
   * 계정 쪽 제약도 따로 있다 — 이 개발 계정(Copilot Free)은 `auto` 외 모든 모델을 CLI 가
   * 직접 거절한다(`Model "claude-haiku-4.5" from --model flag is not available.`). 둘은
   * 독립적인 이유라, 유료 계정이라도 ACP 로는 여전히 못 고른다.
   *
   * 검증할 수 없는 값을 피커에 띄우느니 비워 두고, 전환은 Copilot 자신의 `/model` 슬래시
   * 명령에 맡긴다(그 명령은 자동완성 목록에 그대로 실린다). GitHub 이 모델을 ACP 로 열면
   * `session/new` 응답의 `configOptions` 에 나타날 자리가 가장 유력하다 — 지금 거기에는
   * `mode` 와 `allow_all` 둘뿐이다([[copilot/acp]]).
   */
  listModels(): Promise<ModelOption[]> {
    return Promise.resolve([])
  }

  // ── capability-게이트 ─────────────────────────────────────────────────────

  async runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    const session = this.sessionFor(workspaceId)
    if (!session) throw new Error('This workspace is no longer open.')
    return session.runCommand(kind)
  }

  /**
   * `/add-dir`. Copilot 은 세션이 도는 중에도 이 명령을 받아 주므로 세션을 버리지 않는다 —
   * 세션 시작 시점에 굳는 Claude 경로와 다른 점이다. 값은 기억해 뒀다가 세션을 새로 열 때
   * 다시 얹는다(재개·크래시 복구 뒤에도 살아남아야 한다).
   */
  addDirectory(workspaceId: string, dir: string): { error?: string } {
    const dirs = this.extraDirs.get(workspaceId) ?? []
    if (!dirs.includes(dir)) this.extraDirs.set(workspaceId, [...dirs, dir])
    this.connection.existing(workspaceId)?.addDirectory(dir)
    return {}
  }

  /**
   * 입력창 자동완성 목록. Copilot 이 `available_commands_update` 로 알려 준 것을 그대로 쓴다
   * (실측: 32개가 이름·설명·인자 힌트와 함께 온다). 세션이 아직 없으면 빈 목록이고, 첫 턴
   * 뒤부터 채워진다 — 없는 명령을 미리 지어내는 것보다 낫다.
   */
  listCommands(workspaceId: string): Promise<SlashCommandInfo[]> {
    return Promise.resolve(this.connection.existing(workspaceId)?.listCommands() ?? [])
  }

  // ── capability 미지원 (오케스트레이터가 capabilities 로 먼저 가드한다) ────

  sideQuestion(): void {
    // capabilities.sideQuestion=false — 호출되지 않는다.
  }

  setEffort(): void {
    // capabilities.effort=false — 넘길 자리가 없다(COPILOT_META 근거 참고).
  }

  setFastMode(): void {
    // capabilities.fastMode=false — 대응 개념이 없다.
  }

  mcpAction(): Promise<McpServerInfo[]> {
    return Promise.reject(new Error('GitHub Copilot CLI cannot manage MCP servers from Wooi.'))
  }

  rewindAction(): Promise<RewindActionResult> {
    return Promise.reject(new Error('GitHub Copilot CLI does not support rewind.'))
  }

  /** capabilities.rateLimits=false — 계정 사용량을 조회할 경로가 없다. */
  refreshRateLimits(): Promise<void> {
    return Promise.resolve()
  }

  rateLimits(): Promise<AgentRateLimits | null> {
    return Promise.resolve(null)
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  private askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(request.requestId, { workspaceId: request.workspaceId, resolve })
      this.notify(
        request.workspaceId,
        'needsInput',
        `Needs permission: ${request.displayName ?? request.toolName}`,
        false
      )
      this.dispatch(IPC.evtPermission, request)
    })
  }

  /** 응답받을 세션이 사라졌다 — 떠 있던 카드를 거두고 거절로 확정한다. */
  private cancelPermissionsOf(workspaceId: string | null): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (workspaceId && pending.workspaceId !== workspaceId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve({ behavior: 'deny' })
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
  }

  /** 프로세스·파이프가 끊겼다. 메인은 살아남아 상태를 정리하고, 다음 사용 때 다시 띄운다. */
  private onDisconnect(reason: string): void {
    log.error(`copilot: ACP connection lost — ${reason}`)
    this.cancelPermissionsOf(null)
    for (const w of this.runningWorkspaces()) {
      this.systemNote(
        w.id,
        `${reason} Wooi will start it again on your next message — the conversation is kept.`,
        'error'
      )
      this.forceIdle(w.id)
    }
  }

  private fail(workspaceId: string, err: unknown): void {
    log.error('copilot: session failed', err)
    this.systemNote(workspaceId, describe(err), 'error')
    this.emit(workspaceId, { type: 'status', status: 'error' })
  }

  private systemNote(workspaceId: string, text: string, type: 'system' | 'error' = 'system'): void {
    const item: ChatItem = {
      id: `copilot:${type}:${Date.now()}:${workspaceId}`,
      type,
      text,
      ts: Date.now()
    }
    getTranscripts().upsert(workspaceId, item)
    this.emit(workspaceId, { type: 'item', item })
  }

  /** workspace 를 idle 로 강제 확정한다(store + 렌더러). 완료 알림은 띄우지 않는다. */
  private forceIdle(workspaceId: string): void {
    getStore().update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.status = 'idle'
    })
    this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'status', status: 'idle' } })
  }

  private emit(workspaceId: string, event: ChatEvent): void {
    if (event.type === 'status') {
      // 턴이 끝났다 — 소유자가 이어서 한 턴을 더 보냈다면 이 종료는 없던 일로 한다(Claude·Codex
      // 의 emit 과 같은 규칙이고, 같아야 한다. 한쪽만 다르면 백엔드에 따라 자동 재개가 되기도
      // 안 되기도 한다). 왜 idle 을 방송하면 안 되는지는 [[agent/orchestrator]] 에 있다.
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
