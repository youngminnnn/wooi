import { randomUUID } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { statSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import { getStore } from '../store'
import { getTranscripts } from '../transcripts'
import { log } from '../logger'
import { IPC, agentSettingsFor, normalizePermissionMode } from '@shared/types'
import { GROK_META, type AgentBackend, type TurnEndHook } from '../agent/backend'
import { GrokHost } from './host'
import { grokModeFor, midSessionModeFor } from './modes'
import { listGrokModels } from './models'
import type {
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  ModelOption,
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

interface PendingPermission {
  workspaceId: string
  resolve: (decision: PermissionDecision) => void
}

/** Grok Build ACP 세션을 Wooi 의 공통 AgentBackend 표면으로 연결한다. */
export class GrokSessionManager implements AgentBackend {
  readonly meta = GROK_META
  private host: GrokHost | null = null
  private running = new Set<string>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private commands = new Map<string, SlashCommandInfo[]>()
  private runtime = { rewind: true, commands: true, addDirectory: true, usage: true }

  constructor(
    private readonly dispatch: Dispatch,
    _getWindow: () => BrowserWindow | null,
    private readonly onTurnEnd?: TurnEndHook,
    private readonly makeHost?: (callbacks: ConstructorParameters<typeof GrokHost>[0]) => GrokHost
  ) {}

  private ensureHost(): GrokHost {
    if (this.host) return this.host
    const callbacks: ConstructorParameters<typeof GrokHost>[0] = {
      onMapped: (workspaceId, mapped) => {
        for (const item of mapped.persist) getTranscripts().upsert(workspaceId, item)
        for (const event of mapped.events) this.emit(workspaceId, event)
        if (mapped.commands) this.commands.set(workspaceId, mapped.commands)
      },
      onSessionId: (workspaceId, sessionId) => this.noteSessionId(workspaceId, sessionId),
      askPermission: (request) => this.askPermission(request),
      onDisconnect: (error, stderr) => this.onDisconnect(error, stderr)
    }
    this.host = this.makeHost ? this.makeHost(callbacks) : new GrokHost(callbacks)
    return this.host
  }

  private workspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((workspace) => workspace.id === id)
  }

  private config(ws: Workspace) {
    const defaults = agentSettingsFor(getStore().getState().settings, GROK_META.id)
    const permissionMode = normalizePermissionMode(GROK_META, ws.permissionMode)
    const selected = grokModeFor(permissionMode)
    return {
      cwd: ws.worktreePath,
      resumeSessionId: ws.sessionId,
      modeId: selected.modeId,
      meta: selected.meta,
      model: ws.model ?? defaults.model ?? GROK_META.defaultModel,
      effort: ws.effort ?? defaults.effort
    }
  }

  prewarm(): void {
    this.ensureHost()
  }

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void {
    const ws = this.workspace(workspaceId)
    if (!ws) return
    const prompt = `${opts?.prefix ?? ''}${text}`
    if (this.running.has(workspaceId)) {
      const sessionId = this.host?.sessionId(workspaceId)
      if (sessionId)
        void this.host?.interject(sessionId, prompt).catch((error) => this.fail(workspaceId, error))
      return
    }
    if (!images?.length && text.trim() === '/compact') {
      void this.compact(ws)
      return
    }
    void this.startTurn(ws, prompt, images)
  }

  private async startTurn(ws: Workspace, text: string, images?: ImageAttachment[]): Promise<void> {
    this.running.add(ws.id)
    this.emit(ws.id, { type: 'status', status: 'running' })
    try {
      const config = this.config(ws)
      const host = this.ensureHost()
      const sessionId = await host.open(ws.id, config)
      host.setAutoApprove(ws.id, midSessionModeFor(ws.permissionMode).autoApprove)
      await this.applyModel(host, sessionId, config.model, config.effort)
      await host.prompt(sessionId, [
        { type: 'text', text },
        ...(images ?? []).map((image) => ({
          type: 'image' as const,
          mimeType: image.mediaType,
          data: image.dataBase64
        }))
      ])
      this.running.delete(ws.id)
      this.emit(ws.id, { type: 'status', status: 'idle' })
    } catch (error) {
      this.running.delete(ws.id)
      this.fail(ws.id, error)
    }
  }

  private async compact(ws: Workspace): Promise<void> {
    try {
      const sessionId = await this.openFor(ws.id)
      const result = await this.ensureHost().ext('x.ai/compact_conversation', { sessionId })
      if (!result.supported)
        throw new Error('This Grok Build version does not support conversation compaction.')
    } catch (error) {
      this.fail(ws.id, error)
    }
  }

  /**
   * 모델과 effort 를 한 번에 적용한다. effort 는 `session/set_model` 의 `_meta` 로만 갈 수 있어
   * 둘을 나눌 수 없다 — 그래서 모델이 안 정해졌어도 카탈로그 기본 모델로 보낸다. 안 그러면
   * effort 슬라이더가 기본 모델에서 아무 일도 안 하는 스위치가 된다.
   *
   * 키 이름은 `reasoningEffort` 다(Grok 의 parse_reasoning_effort_meta). `effort` 로 보내면
   * 에이전트가 조용히 무시하고, 우리는 적용된 줄 안다.
   */
  private async applyModel(
    host: GrokHost,
    sessionId: string,
    model: string | null,
    effort: EffortSetting | null
  ): Promise<void> {
    const modelId = model ?? GROK_META.defaultModel
    if (!modelId) return
    const result = await host.ext('session/set_model', {
      sessionId,
      modelId,
      ...(effort ? { _meta: { reasoningEffort: effort } } : {})
    })
    if (!result.supported) log.info('grok: session/set_model is unsupported')
  }

  async interrupt(workspaceId: string): Promise<void> {
    const sessionId = this.host?.sessionId(workspaceId)
    if (sessionId) await this.host?.cancel(sessionId)
    this.running.delete(workspaceId)
    this.forceIdle(workspaceId)
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) ws.permissionMode = mode
    })
    const axes = midSessionModeFor(mode)
    this.host?.setAutoApprove(workspaceId, axes.autoApprove)
    const sessionId = this.host?.sessionId(workspaceId)
    if (sessionId) await this.host?.setMode(sessionId, axes.modeId)
  }

  setModel(workspaceId: string, model: string | null): void {
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) ws.model = model
    })
    const ws = this.workspace(workspaceId)
    const sessionId = this.host?.sessionId(workspaceId)
    if (ws && sessionId) {
      const config = this.config(ws)
      void this.applyModel(this.ensureHost(), sessionId, config.model, config.effort).catch(
        (error) => this.fail(workspaceId, error)
      )
    }
  }

  setEffort(workspaceId: string, effort: EffortSetting | null): void {
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) ws.effort = effort
    })
    const ws = this.workspace(workspaceId)
    const sessionId = this.host?.sessionId(workspaceId)
    if (ws && sessionId) {
      const config = this.config(ws)
      void this.applyModel(this.ensureHost(), sessionId, config.model, config.effort).catch(
        (error) => this.fail(workspaceId, error)
      )
    }
  }

  setFastMode(): void {
    throw new Error('Grok Build does not support fast mode.')
  }

  clearSession(workspaceId: string): void {
    void this.host
      ?.close(workspaceId)
      .catch((error) => log.warn(`grok: close failed (${describe(error)})`))
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) {
        ws.sessionId = null
        ws.status = 'idle'
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
    void this.host?.close(workspaceId).catch(() => undefined)
    this.cancelPermissions(workspaceId)
    this.running.delete(workspaceId)
  }

  disposeAll(): void {
    this.host?.dispose()
    this.host = null
    this.cancelPermissions()
    this.running.clear()
  }

  abortAll(): void {
    const running = [...this.running]
    this.disposeAll()
    for (const workspaceId of running) this.forceIdle(workspaceId)
  }

  recycleAll(): void {
    this.abortAll()
  }

  listModels(): Promise<ModelOption[]> {
    return listGrokModels()
  }

  /**
   * /btw 사이드 질문. 메인 세션 맥락을 이어받되 **대화에는 남기지 않고** 임시 카드로만 답한다
   * ([[shared/types]] SideQuestionEvent). 실제 세션 분기는 [[grok/host]] 의 aside 가 맡는다.
   */
  sideQuestion(workspaceId: string, question: string): void {
    const ws = this.workspace(workspaceId)
    const trimmed = question.trim()
    if (!ws || !trimmed) return
    const id = randomUUID()
    this.dispatch(IPC.evtSideQuestion, { workspaceId, id, phase: 'start', question: trimmed })
    void this.ensureHost()
      .aside(this.host?.sessionId(workspaceId) ?? null, ws.worktreePath, trimmed, (text) =>
        this.dispatch(IPC.evtSideQuestion, { workspaceId, id, phase: 'delta', text })
      )
      .then(() => this.dispatch(IPC.evtSideQuestion, { workspaceId, id, phase: 'done' }))
      .catch((error) =>
        // 사이드 질문 실패는 대화를 깨뜨리지 않는다 — 카드에만 적는다.
        this.dispatch(IPC.evtSideQuestion, {
          workspaceId,
          id,
          phase: 'error',
          message: describe(error)
        })
      )
  }

  async runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    if (kind !== 'context' && kind !== 'usage' && kind !== 'mcp')
      throw new Error(`Grok Build does not support /${kind}.`)
    const sessionId = await this.openFor(workspaceId)
    if (kind === 'mcp') return { kind, servers: await this.mcpServers(sessionId) }
    const usage = await this.extension<Record<string, unknown>>(
      workspaceId,
      'x.ai/session/usage',
      { sessionId },
      'usage'
    )
    if (kind === 'context')
      return {
        kind,
        context: contextFrom(usage, this.config(this.workspace(workspaceId)!).model ?? 'default')
      }
    const billing = await this.extension<Record<string, unknown>>(
      workspaceId,
      'x.ai/billing',
      {},
      'usage'
    )
    return { kind, usage: usageFrom(usage, billing) }
  }

  async mcpAction(
    workspaceId: string,
    serverName: string,
    action: McpAction
  ): Promise<McpServerInfo[]> {
    const sessionId = await this.openFor(workspaceId)
    await this.extension(workspaceId, `x.ai/mcp/${action}`, { sessionId, serverName }, 'commands')
    return this.mcpServers(sessionId)
  }

  async rewindAction(workspaceId: string, userMessageId: string): Promise<RewindActionResult> {
    const sessionId = await this.openFor(workspaceId)
    await this.extension(workspaceId, 'x.ai/rewind/points', { sessionId }, 'rewind')
    const result = await this.extension<Record<string, unknown>>(
      workspaceId,
      'x.ai/rewind/execute',
      { sessionId, userMessageId },
      'rewind'
    )
    return {
      canRewind: true,
      filesChanged: stringArray(result.filesChanged),
      insertions: numberValue(result.insertions),
      deletions: numberValue(result.deletions)
    }
  }

  async listCommands(workspaceId: string): Promise<SlashCommandInfo[]> {
    const cached = this.commands.get(workspaceId)
    if (cached) return cached
    const sessionId = await this.openFor(workspaceId)
    const value = await this.extension<{ commands?: SlashCommandInfo[] }>(
      workspaceId,
      'x.ai/commands/list',
      { sessionId },
      'commands'
    )
    const commands = value.commands ?? []
    this.commands.set(workspaceId, commands)
    return commands
  }

  addDirectory(workspaceId: string, dir: string): { error?: string } {
    const ws = this.workspace(workspaceId)
    if (!ws) return { error: 'Workspace not found.' }
    const path = resolve(ws.worktreePath, dir)
    try {
      if (!statSync(path).isDirectory()) return { error: `Not a directory: ${path}` }
    } catch {
      return { error: `No such directory: ${path}` }
    }
    if (path === ws.worktreePath || !relative(ws.worktreePath, path).startsWith('..'))
      return { error: 'That directory is already part of this workspace.' }
    void this.openFor(workspaceId)
      .then((sessionId) =>
        this.extension(
          workspaceId,
          'x.ai/session/add_local_workspace',
          { sessionId, path },
          'addDirectory'
        )
      )
      .catch((error) => this.fail(workspaceId, error))
    getStore().update((state) => {
      const item = state.workspaces.find((candidate) => candidate.id === workspaceId)
      if (item && !(item.additionalDirs ?? []).includes(path))
        item.additionalDirs = [...(item.additionalDirs ?? []), path]
    })
    return {}
  }

  async refreshRateLimits(allowShortLived: boolean): Promise<void> {
    if (!allowShortLived && !this.host?.live) return
    const workspace = getStore()
      .getState()
      .workspaces.find((item) => item.agentBackend === 'grok')
    if (!workspace) return
    const sessionId = await this.openFor(workspace.id)
    const billing = await this.extension<Record<string, unknown>>(
      workspace.id,
      'x.ai/billing',
      { sessionId },
      'usage'
    )
    const snapshot = rateLimitSnapshot(billing)
    getStore().update((state) => {
      state.rateLimitsByAgent = { ...state.rateLimitsByAgent, grok: snapshot }
    })
    this.dispatch(IPC.evtState, getStore().getState())
  }

  private async openFor(workspaceId: string): Promise<string> {
    const ws = this.workspace(workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.ensureHost().open(workspaceId, this.config(ws))
  }

  private async extension<T>(
    _workspaceId: string,
    method: string,
    params: unknown,
    capability: keyof GrokSessionManager['runtime']
  ): Promise<T> {
    if (!this.runtime[capability])
      throw new Error(`This Grok Build version does not support ${capability}.`)
    const result = await this.ensureHost().ext<T, unknown>(method, params)
    if (!result.supported) {
      this.runtime[capability] = false
      throw new Error(`This Grok Build version does not support ${capability}.`)
    }
    return result.value
  }

  private async mcpServers(sessionId: string): Promise<McpServerInfo[]> {
    const value = await this.extension<{ servers?: McpServerInfo[] }>(
      this.workspaceForSession(sessionId),
      'x.ai/commands/list',
      { sessionId, command: 'mcp' },
      'commands'
    )
    return value.servers ?? []
  }

  private workspaceForSession(sessionId: string): string {
    return (
      getStore()
        .getState()
        .workspaces.find((ws) => this.host?.sessionId(ws.id) === sessionId)?.id ?? ''
    )
  }

  private askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(request.requestId, { workspaceId: request.workspaceId, resolve })
      this.dispatch(IPC.evtPermission, request)
    })
  }

  private cancelPermissions(workspaceId?: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (workspaceId && pending.workspaceId !== workspaceId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve({ behavior: 'deny' })
      this.dispatch(IPC.evtPermissionCancel, requestId)
    }
  }

  private noteSessionId(workspaceId: string, sessionId: string): void {
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) ws.sessionId = sessionId
    })
  }

  private onDisconnect(error: unknown | null, stderr: string): void {
    this.host = null
    const message = subscriptionError(error, stderr)
    for (const workspaceId of this.running) this.fail(workspaceId, new Error(message))
    this.running.clear()
    this.cancelPermissions()
  }

  private fail(workspaceId: string, error: unknown): void {
    const item: ChatItem = {
      id: `error:grok:${randomUUID()}`,
      type: 'error',
      text: subscriptionError(error, ''),
      ts: Date.now()
    }
    getTranscripts().upsert(workspaceId, item)
    this.emit(workspaceId, { type: 'item', item })
    this.emit(workspaceId, { type: 'status', status: 'error' })
  }

  private forceIdle(workspaceId: string): void {
    getStore().update((state) => {
      const ws = state.workspaces.find((item) => item.id === workspaceId)
      if (ws) ws.status = 'idle'
    })
    this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'status', status: 'idle' } })
  }

  private emit(workspaceId: string, event: ChatEvent): void {
    if (event.type === 'status') {
      if (event.status !== 'running' && this.onTurnEnd?.(workspaceId, event.status)) return
      getStore().update((state) => {
        const ws = state.workspaces.find((item) => item.id === workspaceId)
        if (ws) {
          ws.status = event.status
          ws.lastActiveAt = Date.now()
        }
      })
    }
    this.dispatch(IPC.evtChat, { workspaceId, event })
  }
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
function subscriptionError(error: unknown, stderr: string): string {
  const raw = `${describe(error ?? '')} ${stderr}`.trim()
  return /subscription|premium|supergrok|api.?key|unauthorized|payment/i.test(raw)
    ? 'Grok Build needs a SuperGrok / X Premium+ subscription or an xAI API key.'
    : raw || 'The Grok Build process stopped unexpectedly. Please resend your last message.'
}
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}
function contextFrom(value: Record<string, unknown>, model: string) {
  const totalTokens = numberValue(value.totalTokens) ?? numberValue(value.usedTokens) ?? 0
  const maxTokens = numberValue(value.maxTokens) ?? numberValue(value.contextWindow) ?? 0
  return {
    totalTokens,
    maxTokens,
    percentage: maxTokens ? Math.round((totalTokens / maxTokens) * 100) : 0,
    model,
    categories: [{ name: 'Conversation', tokens: totalTokens }]
  }
}
function usageFrom(usage: Record<string, unknown>, billing: Record<string, unknown>): UsageInfo {
  return {
    totalCostUsd: numberValue(usage.totalCostUsd) ?? 0,
    linesAdded: numberValue(usage.linesAdded) ?? 0,
    linesRemoved: numberValue(usage.linesRemoved) ?? 0,
    subscriptionType:
      typeof billing.subscriptionType === 'string' ? billing.subscriptionType : null,
    rateLimitsAvailable: true,
    rateLimits: [],
    extraUsage: null
  }
}
function rateLimitSnapshot(billing: Record<string, unknown>): RateLimitSnapshot {
  return {
    fetchedAt: Date.now(),
    available: true,
    subscriptionType:
      typeof billing.subscriptionType === 'string' ? billing.subscriptionType : null,
    windows: []
  }
}
