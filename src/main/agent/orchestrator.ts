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
import type { AgentBackend, AgentBackendMeta } from './backend'
import { createBackend, type Dispatch } from './registry'

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

  // ── capability-게이트 (지원 백엔드에만 위임) ──────────────────────────────

  sideQuestion(workspaceId: string, question: string): void {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.sideQuestion) return
    backend.sideQuestion(workspaceId, question)
  }

  runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    const backend = this.backendFor(workspaceId)
    if (!backend.meta.capabilities.interactiveCommands) {
      throw new Error(`${backend.meta.label} does not support interactive commands.`)
    }
    return backend.runCommand(workspaceId, kind)
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
