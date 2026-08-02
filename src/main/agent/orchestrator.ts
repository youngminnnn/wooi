import type { BrowserWindow } from 'electron'
import { getStore } from '../store'
import {
  DEFAULT_AGENT_BACKEND,
  type AgentBackendId,
  type CommandPanelKind,
  type CommandResult,
  type EffortSetting,
  type ImageAttachment,
  type McpAction,
  type McpServerInfo,
  type PermissionDecision,
  type PermissionMode,
  type RewindActionResult,
  type SlashCommandInfo
} from '@shared/types'
import type { AgentBackendMeta, ModelOption } from '@shared/types'
import type { AgentBackend } from './backend'
import {
  AGENT_BACKENDS,
  backendAvailability,
  backendMeta,
  createBackend,
  type Dispatch
} from './registry'
import { log } from '../logger'

/**
 * 여러 에이전트 백엔드를 소유하고, 워크스페이스가 지정한 백엔드(workspace.agentBackend)로 호출을
 * 라우팅하는 오케스트레이터. IPC 계층은 SessionManager(=Claude 구현)에 직접 의존하지 않고 이
 * 오케스트레이터에만 의존한다 — 그래서 백엔드 종류가 늘어도 IPC 는 그대로다.
 *
 * 백엔드는 식별자별로 지연 생성해 재사용한다(한 백엔드 인스턴스가 그 종류의 모든 워크스페이스를
 * 멀티플렉싱한다 — Claude 의 경우 단일 agent-host 프로세스). capability-게이트 메서드는 해당
 * 백엔드가 그 기능을 지원하지 않으면 명확한 에러로 끊거나(Promise) 조용히 무시한다(void).
 */
export class AgentOrchestrator {
  private backends = new Map<AgentBackendId, AgentBackend>()

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null
  ) {}

  /** 식별자별 백엔드를 지연 생성·캐시한다. */
  private get(id: AgentBackendId): AgentBackend {
    let backend = this.backends.get(id)
    if (!backend) {
      backend = createBackend(id, { dispatch: this.dispatch, getWindow: this.getWindow })
      this.backends.set(id, backend)
    }
    return backend
  }

  /** 워크스페이스가 지정한 백엔드(없으면 기본)로 해석한다. */
  private backendFor(workspaceId: string): AgentBackend {
    const ws = getStore()
      .getState()
      .workspaces.find((w) => w.id === workspaceId)
    return this.get(ws?.agentBackend ?? DEFAULT_AGENT_BACKEND)
  }

  /** 워크스페이스를 구동하는 백엔드의 메타(식별·표시·capabilities). */
  metaFor(workspaceId: string): AgentBackendMeta {
    return this.backendFor(workspaceId).meta
  }

  // ── 카탈로그 (렌더러가 선택지 UI 를 그리는 근거) ─────────────────────────

  /**
   * 등록된 모든 백엔드의 메타를 가용성까지 반영해 돌려준다.
   *
   * 가용성 확인(CLI 설치·버전)은 백엔드를 **인스턴스화하지 않고** 정적 메타만 읽는 것으로는
   * 알 수 없으므로 여기서 한 번 물어본다. 확인이 실패해도 목록 자체는 항상 돌려준다 —
   * 렌더러는 available=false 인 항목을 이유와 함께 비활성으로 보여 준다.
   */
  async listBackends(): Promise<AgentBackendMeta[]> {
    const ids = Object.keys(AGENT_BACKENDS) as AgentBackendId[]
    return Promise.all(
      ids.map(async (id) => {
        const meta = backendMeta(id)
        try {
          const { available, reason } = await backendAvailability(id)
          return { ...meta, available, unavailableReason: available ? undefined : reason }
        } catch (err) {
          log.error(`agent: availability check failed for ${id}`, err)
          return { ...meta, available: false, unavailableReason: 'Availability check failed' }
        }
      })
    )
  }

  /**
   * 백엔드의 계정 API. 이 백엔드가 계정을 직접 다루지 않으면(Claude) null.
   * 호출부는 null 을 "그 백엔드는 다른 경로로 인증한다"로 해석해야 한다.
   */
  accountFor(id: AgentBackendId): AgentBackend | null {
    const backend = this.get(id)
    return backend.accountStatus ? backend : null
  }

  /**
   * 백엔드의 모델 선택지. 쓸 수 없는 백엔드(CLI 미설치)는 프로세스를 띄우지 않고 빈 목록으로
   * 끊는다 — 조회 실패도 마찬가지로 빈 목록이며, 렌더러는 저장된 값으로 폴백한다.
   */
  async listModels(id: AgentBackendId): Promise<ModelOption[]> {
    try {
      const { available } = await backendAvailability(id)
      if (!available) return []
      return await this.get(id).listModels()
    } catch (err) {
      log.error(`agent: model list failed for ${id}`, err)
      return []
    }
  }

  // ── 핵심 (모든 백엔드 위임) ──────────────────────────────────────────────

  sendMessage(workspaceId: string, text: string, images?: ImageAttachment[]): void {
    this.backendFor(workspaceId).sendMessage(workspaceId, text, images)
  }

  interrupt(workspaceId: string): Promise<void> {
    return this.backendFor(workspaceId).interrupt(workspaceId)
  }

  setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    return this.backendFor(workspaceId).setPermissionMode(workspaceId, mode)
  }

  setModel(workspaceId: string, model: string | null): void {
    this.backendFor(workspaceId).setModel(workspaceId, model)
  }

  setEffort(workspaceId: string, effort: EffortSetting | null): void {
    this.backendFor(workspaceId).setEffort(workspaceId, effort)
  }

  setFastMode(workspaceId: string, fastMode: boolean | null): void {
    this.backendFor(workspaceId).setFastMode(workspaceId, fastMode)
  }

  clearSession(workspaceId: string): void {
    this.backendFor(workspaceId).clearSession(workspaceId)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    // requestId 는 워크스페이스에 매이지 않으므로, 어느 백엔드가 그 요청을 띄웠는지 알 수 없다.
    // 권한 응답은 멱등(대상 백엔드만 매칭, 나머지는 무시)이라 활성 백엔드 전부에 전달한다.
    for (const backend of this.backends.values()) backend.respondPermission(requestId, decision)
  }

  dispose(workspaceId: string): void {
    this.backendFor(workspaceId).dispose(workspaceId)
  }

  disposeAll(): void {
    for (const backend of this.backends.values()) backend.disposeAll()
  }

  abortAll(): void {
    for (const backend of this.backends.values()) backend.abortAll()
  }

  /** 계정 전환 후 모든 백엔드의 세션 프로세스를 재활용한다(대화 맥락은 유지). */
  recycleAll(): void {
    for (const backend of this.backends.values()) backend.recycleAll()
  }

  // ── capability-게이트 (지원 백엔드에만 위임) ──────────────────────────────

  sideQuestion(workspaceId: string, question: string): void {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.sideQuestion) return
    backend.sideQuestion(workspaceId, question)
  }

  runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.interactiveCommands.includes(kind)) {
      throw new Error(`${backend.meta.label} does not support /${kind}.`)
    }
    return backend.runCommand(workspaceId, kind)
  }

  /**
   * 계정 레이트리밋 스냅샷 갱신. 레이트리밋은 계정에 하나뿐인 값이라 워크스페이스로 라우팅하지
   * 않고, 해당 기능을 지원하는 백엔드 전부에 요청한다(Claude·Codex 둘 다 지원한다).
   * 지원하지 않는 백엔드는 조용히 건너뛴다 — 배경 갱신이 에러를 던질 이유가 없다.
   */
  async refreshRateLimits(allowShortLived: boolean): Promise<void> {
    // 사용자가 명시적으로 요청한 갱신은 아직 백엔드가 하나도 없을 수도 있다(앱을 켜고 아무 세션도
    // 돌리지 않은 상태). 이때는 기본 백엔드를 만들어서라도 답을 준다 — 배경 갱신은 그러지 않는다.
    if (allowShortLived) this.get(DEFAULT_AGENT_BACKEND)
    await Promise.all(
      [...this.backends.values()]
        // capabilities.rateLimits 로 가른다. interactiveCommands 는 이제 배열이라 빈 값도 truthy 라서
        // 그걸로 거르면 지원하지 않는 백엔드까지 전부 통과한다.
        .filter((b) => b.meta.capabilities.rateLimits)
        .map((b) => b.refreshRateLimits(allowShortLived))
    )
  }

  mcpAction(workspaceId: string, serverName: string, action: McpAction): Promise<McpServerInfo[]> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.mcp) {
      throw new Error(`${backend.meta.label} does not support MCP.`)
    }
    return backend.mcpAction(workspaceId, serverName, action)
  }

  rewindAction(workspaceId: string, userMessageId: string): Promise<RewindActionResult> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.rewind) {
      throw new Error(`${backend.meta.label} does not support rewind.`)
    }
    return backend.rewindAction(workspaceId, userMessageId)
  }

  /** 워크스페이스 백엔드로 라우팅해 슬래시 명령 목록을 조회한다. 미지원이면 빈 목록. */
  listCommands(workspaceId: string, cwd: string): Promise<SlashCommandInfo[]> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.slashCommands) return Promise.resolve([])
    return backend.listCommands(cwd)
  }
}
