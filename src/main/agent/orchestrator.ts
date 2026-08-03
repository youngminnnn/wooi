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
import { backendAvailability, createBackend, type Dispatch } from './registry'
import { AGENT_BACKENDS, backendMeta } from './backend'
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
/**
 * 동시에 살려 둘 세션 수의 상한.
 *
 * 세션 하나는 에이전트 CLI 자식 프로세스 하나를 붙들고 있고, 그게 200~300MB 다. 워크스페이스를
 * 열 때마다 쌓이면 10개를 넘어가는 순간 앱 하나가 3GB 를 넘겨 기기가 스와핑에 들어간다 —
 * 그때의 증상은 "특정 기능이 느림"이 아니라 "전부 버벅임"이다.
 *
 * 시간 기준(예: 30분 유휴면 정리)이 아니라 **개수 기준**인 것이 중요하다. 시간 기준은
 * 워크스페이스를 3개만 쓰는 사용자에게도 이유 없이 재시작 비용을 물린다. 개수 기준이면
 * 상한 아래에서는 아무 일도 일어나지 않고, 실제로 문제가 되는 구간에서만 발동한다.
 */
const MAX_LIVE_SESSIONS = 6

/**
 * 이 시간 안에 쓴 세션은 정리 대상에서 뺀다. 방금 오간 대화로 돌아갔을 때까지 재시작을
 * 겪게 하면, 아낀 메모리보다 잃는 체감이 크다.
 */
const MIN_IDLE_BEFORE_EVICT_MS = 5 * 60_000

/**
 * 정리할 세션을 고른다. 결정 규칙만 떼어 낸 순수 함수다 — 잘못 고르면 사용자가 쓰고 있던
 * 세션이 끊기므로, 백엔드나 스토어 없이 규칙 자체를 검증할 수 있어야 한다.
 *
 * 상한을 넘은 만큼만, 오래 안 쓴 것부터 고른다. 실행 중이거나 방금 쓴 것은 후보에서 뺀다.
 */
export function pickEvictableSessions(args: {
  lastUsedAt: ReadonlyMap<string, number>
  running: ReadonlySet<string>
  now: number
  max?: number
  minIdleMs?: number
}): string[] {
  const max = args.max ?? MAX_LIVE_SESSIONS
  const minIdleMs = args.minIdleMs ?? MIN_IDLE_BEFORE_EVICT_MS
  const excess = args.lastUsedAt.size - max
  if (excess <= 0) return []

  return [...args.lastUsedAt.entries()]
    .filter(([id, at]) => !args.running.has(id) && args.now - at >= minIdleMs)
    .sort((a, b) => a[1] - b[1])
    .slice(0, excess)
    .map(([id]) => id)
}

export class AgentOrchestrator {
  private backends = new Map<AgentBackendId, AgentBackend>()
  /**
   * 세션이 살아 있을 법한 워크스페이스와 마지막 사용 시각. 세션은 첫 전송 때 지연 생성되므로
   * "전송한 적 있고 아직 dispose 되지 않은" 것이 곧 살아 있는 세션이다.
   */
  private lastUsedAt = new Map<string, number>()

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null
  ) {}

  /** 지금 살아 있는 세션 수(계측용). */
  liveSessionCount(): number {
    return this.lastUsedAt.size
  }

  private touch(workspaceId: string): void {
    this.lastUsedAt.set(workspaceId, Date.now())
  }

  /**
   * 상한을 넘은 만큼 오래 안 쓴 세션을 정리한다. 정리해도 대화는 남는다 — 다음 전송이
   * 저장된 sessionId 로 resume 하므로([[claude/manager]] 의 resumeSessionId), 사용자에게는
   * 그 한 번의 응답이 조금 느린 것으로만 나타난다.
   *
   * 실행 중이거나 방금 쓴 세션은 건드리지 않는다. 그래서 상한을 넘겨도 정리할 후보가 없으면
   * 아무것도 하지 않는다 — 상한은 목표치이지 강제 한도가 아니다.
   */
  private trimIdleSessions(): void {
    if (this.lastUsedAt.size <= MAX_LIVE_SESSIONS) return

    const running = new Set(
      getStore()
        .getState()
        .workspaces.filter((w) => w.status === 'running')
        .map((w) => w.id)
    )
    const evictable = pickEvictableSessions({
      lastUsedAt: this.lastUsedAt,
      running,
      now: Date.now()
    })

    for (const workspaceId of evictable) {
      log.info(`orchestrator: 유휴 세션 정리 (${workspaceId}) — 다음 전송에서 resume 된다`)
      this.dispose(workspaceId)
    }
  }

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

  /** 저장된 Codex 워크스페이스가 있으면 app-server 를 백그라운드에서 미리 준비한다. */
  prewarm(): void {
    const hasCodexWorkspace = getStore()
      .getState()
      .workspaces.some((workspace) => workspace.agentBackend === 'codex' && !workspace.archived)
    if (hasCodexWorkspace) this.get('codex').prewarm?.()
  }

  sendMessage(workspaceId: string, text: string, images?: ImageAttachment[]): void {
    this.touch(workspaceId)
    this.backendFor(workspaceId).sendMessage(workspaceId, text, images)
    this.trimIdleSessions()
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
    this.lastUsedAt.delete(workspaceId)
    this.backendFor(workspaceId).dispose(workspaceId)
  }

  disposeAll(): void {
    this.lastUsedAt.clear()
    for (const backend of this.backends.values()) backend.disposeAll()
  }

  abortAll(): void {
    this.lastUsedAt.clear()
    for (const backend of this.backends.values()) backend.abortAll()
  }

  /** 계정 전환 후 모든 백엔드의 세션 프로세스를 재활용한다(대화 맥락은 유지). */
  recycleAll(): void {
    // 프로세스가 갈리므로 살아 있던 세션도 함께 사라진다 — 다음 전송이 다시 만든다.
    this.lastUsedAt.clear()
    for (const backend of this.backends.values()) backend.recycleAll()
  }

  // ── capability-게이트 (지원 백엔드에만 위임) ──────────────────────────────

  sideQuestion(workspaceId: string, question: string): void {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.sideQuestion) return
    backend.sideQuestion(workspaceId, question)
  }

  /** /add-dir — 지원하지 않는 백엔드에서는 이유를 담은 에러로 돌려준다(입력창이 토스트로 띄운다). */
  addDirectory(workspaceId: string, dir: string): { error?: string } {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.addDirectory || !backend.addDirectory) {
      return { error: `${backend.meta.label} does not support /add-dir.` }
    }
    return backend.addDirectory(workspaceId, dir)
  }

  runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.interactiveCommands.includes(kind)) {
      throw new Error(`${backend.meta.label} does not support /${kind}.`)
    }
    // 슬래시 명령도 그 세션을 쓴 것이다 — 방금 /context 를 띄운 세션을 유휴로 보고 정리하면 안 된다.
    if (this.lastUsedAt.has(workspaceId)) this.touch(workspaceId)
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

  /** 한 backend의 계정 사용량만 갱신한다. Overview가 느린 다른 backend를 기다리지 않게 한다. */
  async refreshRateLimitsFor(id: AgentBackendId, allowShortLived: boolean): Promise<void> {
    const backend = this.get(id)
    if (!backend.meta.capabilities.rateLimits) return
    await backend.refreshRateLimits(allowShortLived)
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
