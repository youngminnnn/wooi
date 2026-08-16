import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Notification, type BrowserWindow } from 'electron'
import {
  IPC,
  agentSettingsFor,
  workspaceDisplayName,
  type AgentAuthStatus,
  type AgentRateLimits,
  type ChatEvent,
  type ChatItem,
  type CommandPanelKind,
  type CommandResult,
  type EffortSetting,
  type ImageAttachment,
  type McpAction,
  type McpServerInfo,
  type ModelOption,
  type NotificationEvent,
  type PermissionDecision,
  type PermissionMode,
  type RateLimitSnapshot,
  type RewindActionResult,
  type SlashCommandInfo,
  type Workspace
} from '@shared/types'
import { ANTIGRAVITY_META, type AgentBackend, type TurnEndHook } from '../agent/backend'
import { getStore } from '../store'
import { getTranscripts } from '../transcripts'
import { log } from '../logger'
import { runLoginShell } from '../shell'
import { antigravityArgs } from './args'
import {
  getAntigravityAccountStatus,
  getAntigravityRateLimits,
  getAntigravityUsageWindows
} from './account'
import { detectAntigravity } from './executable'
import { execAntigravity } from './exec'
import { createMapperState, mapEvent, mapExitStderr, rememberOptimisticUser } from './mapping'
import { turnArgsFor } from './modes'
import { createAntigravityStream } from './stream'

type Dispatch = (channel: string, payload: unknown) => void
type Pending = {
  text: string
  images?: ImageAttachment[]
  opts?: { prefix?: string; silent?: boolean }
}
type State = {
  conversationId: string | null
  model: string | null
  effort: EffortSetting | null
  permissionMode: PermissionMode
  extraDirs: string[]
  child: ChildProcess | null
  abort: AbortController | null
  running: boolean
  queue: Pending[]
}

/**
 * 모델 목록 캐시.
 *
 * 성공과 실패를 **다른 수명으로** 들고 있는다.
 *
 * 실패를 아예 캐시하지 않으면 조회가 멈춰 있을 때 부르는 쪽마다 타임아웃만큼 통째로 멈춘다 —
 * `create_workspace` 의 모델 검증([[agent/tools/agentOptions]])처럼 사용자를 기다리게 하는
 * 자리가 있다. 반대로 성공만큼 오래 캐시하면 설치·로그인 직후에도 선택기가 한참 비어 있다.
 * 그래서 실패는 "연달아 부르는 것만 막을" 만큼만 짧게 잡는다.
 */
let modelCache: { at: number; value: ModelOption[] } | null = null
const MODEL_CACHE_MS = 60_000
const MODEL_FAILURE_CACHE_MS = 15_000

/**
 * 모델 조회 상한. `agy models` 는 매번 서버에 물어 4초 남짓 걸리고(실측), 첫 호출은 자동
 * 업데이트 확인까지 겹칠 수 있다. 짧게 잡으면 목록이 조용히 비는 쪽으로 실패한다.
 */
const MODELS_TIMEOUT_MS = 20_000

/** SIGTERM 을 보낸 뒤 SIGKILL 까지 기다리는 시간. 정상 종료가 마무리될 만큼만 준다. */
const KILL_GRACE_MS = 3_000

/**
 * 실제 첫 요청이 프로젝트 작업인데도 도구 없이 Go 예제만 답한 트랜스크립트가 있었다. `agy`에는
 * system-prompt 플래그가 없고 자동 문맥 탐색에서도 CLAUDE.md가 보이지 않으므로 첫 턴에만 보낸다.
 */
export function composeAntigravityPrompt(
  text: string,
  worktreePath: string,
  conversationId: string | null,
  callerPrefix?: string
): string {
  const workspaceContext = conversationId
    ? undefined
    : `You are working in the git worktree at ${worktreePath}, dedicated to this one task. Work there.\nPrefer changing the project's files over answering with standalone code when the request can be satisfied by a change.\nRead CLAUDE.md if the project has one and follow its instructions.\nYour output is rendered as chat markdown in a GUI, not a terminal.`
  return [workspaceContext, callerPrefix, text].filter(Boolean).join('\n\n')
}

export class AntigravitySessionManager implements AgentBackend {
  readonly meta = ANTIGRAVITY_META
  private states = new Map<string, State>()

  constructor(
    private dispatch: Dispatch,
    private getWindow: () => BrowserWindow | null,
    private onTurnEnd?: TurnEndHook
  ) {}

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: { prefix?: string; silent?: boolean }
  ): void {
    const ws = this.workspace(workspaceId)
    if (!ws) return
    const state = this.stateFor(ws)
    const pending = { text, images, opts }
    if (state.running) {
      state.queue.push(pending)
      return
    }
    void this.runTurn(ws, state, pending)
  }

  private async runTurn(ws: Workspace, state: State, pending: Pending): Promise<void> {
    if (pending.images?.length) {
      this.emitError(ws.id, 'Image attachments are not supported by the Antigravity backend.')
      this.finish(ws.id, state, 'error')
      return
    }

    state.running = true
    const prompt = composeAntigravityPrompt(
      pending.text,
      ws.worktreePath,
      state.conversationId,
      pending.opts?.prefix
    )
    const mapper = createMapperState(randomUUID())
    // silent도 CLI echo는 오므로 반드시 등록한다. 화면·기록에서만 사용자 버블을 생략한다.
    rememberOptimisticUser(mapper, prompt)
    if (!pending.opts?.silent) {
      const item: ChatItem = {
        id: `user:${randomUUID()}`,
        type: 'user',
        text: pending.text,
        ts: Date.now()
      }
      this.persist(ws.id, item)
      this.emit(ws.id, { type: 'item', item })
    }
    this.setRunning(ws.id)

    const install = await detectAntigravity()
    if (!install.path || !install.usable) {
      this.emitError(ws.id, install.reason ?? 'Antigravity is not available.')
      this.finish(ws.id, state, 'error')
      return
    }

    const abort = new AbortController()
    state.abort = abort
    const reader = createAntigravityStream((raw) => {
      const mapped = mapEvent(raw, mapper, (what) => log.warn(`antigravity: unknown ${what}`))
      for (const item of mapped.persist) this.persist(ws.id, item)
      for (const event of mapped.events) {
        if (event.type === 'session') {
          state.conversationId = event.sessionId
          getStore().update((store) => {
            const workspace = store.workspaces.find((w) => w.id === ws.id)
            if (workspace) workspace.sessionId = event.sessionId
          })
        }
        this.emit(ws.id, event)
      }
    })
    const args = antigravityArgs({
      prompt,
      cwd: ws.worktreePath,
      conversationId: state.conversationId,
      model: state.model,
      effort: state.effort,
      modeArgs: turnArgsFor(state.permissionMode),
      extraDirs: state.extraDirs
    })
    const outcome = await execAntigravity(
      install.path,
      args,
      { cwd: ws.worktreePath, abort, onSpawn: (child) => (state.child = child) },
      reader
    )
    state.child = null
    state.abort = null
    const exit = mapExitStderr(outcome.stderr, outcome.exitCode, outcome.aborted)
    for (const item of exit.persist) this.persist(ws.id, item)
    for (const event of exit.events) this.emit(ws.id, event)
    if (outcome.error && !outcome.stderr.trim()) this.emitError(ws.id, outcome.error)
    this.finish(ws.id, state, outcome.error || (outcome.exitCode ?? 0) !== 0 ? 'error' : 'idle')
  }

  private finish(workspaceId: string, state: State, status: 'idle' | 'error'): void {
    const queuedBeforeHook = state.queue.length
    const continued = this.onTurnEnd?.(workspaceId, status) ?? false
    state.running = false
    if (continued) {
      // 훅이 동기적으로 보낸 항목만 이어 실행한다. 그 전에 사용자가 넣어 둔 큐는 훅이 소유한
      // 자동 연속 턴이 끝난 뒤 처리해야 순서가 뒤집히지 않는다.
      const next = state.queue.splice(queuedBeforeHook, 1)[0]
      if (next) {
        const ws = this.workspace(workspaceId)
        if (ws) void this.runTurn(ws, state, next)
      }
      return
    }
    this.setStatus(workspaceId, status)
    const next = state.queue.shift()
    const ws = this.workspace(workspaceId)
    if (next && ws) void this.runTurn(ws, state, next)
  }

  async interrupt(workspaceId: string): Promise<void> {
    const state = this.states.get(workspaceId)
    if (!state) return
    // Node spawn의 signal은 기본 killSignal인 SIGTERM을 보낸다. CLI가 kill 뒤 conversation을 계속
    // resume할 수 있는지는 문서화되지 않았다(upstream #779). ID는 보존하고 다음 턴에 시도하며,
    // not-found 경고는 1.1.12부터 stderr로 나와 mapExitStderr가 보여 준다.
    this.kill(state)
  }

  /**
   * SIGTERM 뒤 유예를 두고 SIGKILL 까지 간다.
   *
   * 이 백엔드에서 턴의 끝은 **프로세스의 종료**뿐이다 — 다른 완료 신호가 없다. 그래서 `agy` 가
   * SIGTERM 을 무시하고 버티면 exec 의 promise 가 영원히 안 풀리고, `running` 이 켜진 채로
   * 워크스페이스가 통째로 잠긴다(사용자는 중단을 눌렀는데 아무 일도 일어나지 않는다). 실제로
   * 멈춰서 끝나지 않는 사례가 보고돼 있어(upstream #573 · #594) 가정으로 두지 않는다.
   */
  private kill(state: State): void {
    state.abort?.abort()
    const child = state.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, KILL_GRACE_MS).unref()
  }

  async setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void> {
    const state = this.stateForId(workspaceId)
    if (state) state.permissionMode = mode
    this.updateWorkspace(workspaceId, (ws) => (ws.permissionMode = mode))
  }

  setModel(workspaceId: string, model: string | null): void {
    const state = this.stateForId(workspaceId)
    if (state) state.model = model
    this.updateWorkspace(workspaceId, (ws) => (ws.model = model))
  }

  setEffort(workspaceId: string, effort: EffortSetting | null): void {
    // model·effort·permission은 spawn 인자로 고정되며 실행 중 변경 채널이 없다. 모두 다음 턴부터 적용된다.
    const state = this.stateForId(workspaceId)
    if (state) state.effort = effort
    this.updateWorkspace(workspaceId, (ws) => (ws.effort = effort))
  }

  setFastMode(): void {
    throw new Error('Antigravity does not support fast mode.')
  }

  addDirectory(workspaceId: string, dir: string): { error?: string } {
    if (!isAbsolute(dir)) return { error: 'Antigravity requires an absolute directory path.' }
    const state = this.stateForId(workspaceId)
    if (state && !state.extraDirs.includes(dir)) state.extraDirs.push(dir)
    this.updateWorkspace(workspaceId, (ws) => {
      if (!ws.additionalDirs?.includes(dir)) ws.additionalDirs = [...(ws.additionalDirs ?? []), dir]
    })
    return {}
  }

  clearSession(workspaceId: string): void {
    const state = this.stateForId(workspaceId)
    if (state) {
      state.conversationId = null
      state.queue = []
    }
    this.updateWorkspace(workspaceId, (ws) => (ws.sessionId = null))
  }

  respondPermission(_requestId: string, _decision: PermissionDecision): void {
    // headless agy는 승인 채널 없이 확인 필요 도구를 soft-deny한다(CHANGELOG 1.1.3, #794).
    // asksForApproval도 항상 false라 Wooi가 이 백엔드의 권한 카드를 만들거나 이 메서드를 부르지 않는다.
  }

  dispose(workspaceId: string): void {
    const state = this.states.get(workspaceId)
    if (state) this.kill(state)
    this.states.delete(workspaceId)
  }

  disposeAll(): void {
    for (const state of this.states.values()) this.kill(state)
    this.states.clear()
  }

  abortAll(): void {
    const ids = [...this.states.keys()]
    this.disposeAll()
    for (const id of ids) this.setStatus(id, 'idle')
  }

  recycleAll(): void {
    // 턴마다 새 프로세스라 버릴 resident session이 없다. 실행도 죽이지 않고 conversationId를 보존해
    // 현재 턴 뒤 다음 spawn이 새 자격증명으로 같은 대화를 resume하게 한다.
  }

  async listModels(): Promise<ModelOption[]> {
    const ttl = modelCache?.value.length ? MODEL_CACHE_MS : MODEL_FAILURE_CACHE_MS
    if (modelCache && Date.now() - modelCache.at < ttl) return modelCache.value
    // **종료 코드를 믿지 않는다.** 1.1.13 실측: `agy models --output-format json` 은
    // `flags provided but not defined: -output-format` 을 찍고도(#777 이 실측대로였다),
    // 로그인 전 `agy models` 는 `Error: Please sign in…` 을 찍고도 **둘 다 exit 0** 이다.
    // 그래서 성공 판정은 "무엇이 파싱됐는가" 로만 한다.
    //
    // 출력 문자열은 `--model` 이 요구하는 정확한 label 이므로(#581, #710) slugify 하거나
    // 보기 좋게 바꾸지 않는다.
    const json = await runLoginShell('agy models --output-format json', MODELS_TIMEOUT_MS)
    const fromJson = parseModelsJson(json.stdout)
    if (fromJson.length) return this.cacheModels(fromJson)

    const plain = await runLoginShell('agy models', MODELS_TIMEOUT_MS)
    const fromText = parseModelsText(`${plain.stdout}\n${plain.stderr}`)
    if (fromText.length) return this.cacheModels(fromText)

    // 검증되지 않은 ID 는 과거 CLI 에서 조용히 저가 모델로 downgrade 됐다(#581·#710). 그래서 빈
    // 목록이 정직한 fallback 이고, `defaultModel: null` 덕에 워크스페이스는 CLI 기본 모델로 정상
    // 동작한다 — 실측으로 확인했다.
    //
    // 이 경로는 드물지 않다. 실측에서 `agy models` 는 `-p` 턴이 멀쩡한 동안에도 아무것도 내놓지
    // 않고 무기한 멈추는 상태가 됐다(`--version` 과 턴은 정상). 그래서 타임아웃이 장식이 아니라
    // 이 기능을 지탱하는 부분이고, 빈 선택기는 눈에 띄지 않는 고장이므로 이유를 로그에 남긴다.
    log.warn(
      `antigravity: no models parsed (json rc=${json.code} plain rc=${plain.code}) — ` +
        `${(plain.stderr || plain.stdout).trim().slice(0, 200)}`
    )
    return this.cacheModels([])
  }

  private cacheModels(value: ModelOption[]): ModelOption[] {
    modelCache = { at: Date.now(), value }
    return value
  }

  accountStatus(): Promise<AgentAuthStatus> {
    return getAntigravityAccountStatus()
  }

  rateLimits(): Promise<AgentRateLimits | null> {
    return getAntigravityRateLimits()
  }

  async refreshRateLimits(allowShortLived: boolean): Promise<void> {
    if (!allowShortLived) return
    // 창 두 개로 접지 않고 **실제 창 전부**를 그대로 싣는다. agy 의 한도는 그룹(Gemini /
    // Claude·GPT) × 버킷(weekly / 5h) 네 개이고, 라벨이 곧 어느 모델군의 무슨 창인지를 말한다.
    // 임의로 두 개만 남기면 사용자를 실제로 멈추게 할 창이 사라질 수 있다.
    const windows = await getAntigravityUsageWindows()
    const snapshot: RateLimitSnapshot = {
      fetchedAt: Date.now(),
      available: windows.length > 0,
      subscriptionType: null,
      windows
    }
    getStore().update((store) => {
      store.rateLimitsByAgent = { ...store.rateLimitsByAgent, antigravity: snapshot }
    })
    this.dispatch(IPC.evtState, getStore().getState())
  }

  sideQuestion(): void {
    throw new Error('Antigravity does not support side questions.')
  }

  async runCommand(_workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
    if (kind !== 'usage') throw new Error(`Antigravity does not support the ${kind} command.`)
    const windows = await getAntigravityUsageWindows()
    return {
      kind: 'usage',
      usage: {
        // agy 는 비용도 diff 통계도 보고하지 않는다. 0 은 "모른다" 가 아니라 "없다" 는 뜻이고,
        // UI 는 rateLimits 만 그린다.
        totalCostUsd: 0,
        linesAdded: 0,
        linesRemoved: 0,
        subscriptionType: null,
        rateLimitsAvailable: windows.length > 0,
        rateLimits: windows,
        extraUsage: null
      }
    }
  }

  mcpAction(
    _workspaceId: string,
    _serverName: string,
    _action: McpAction
  ): Promise<McpServerInfo[]> {
    return Promise.reject(new Error('Antigravity does not support MCP actions.'))
  }

  rewindAction(): Promise<RewindActionResult> {
    return Promise.reject(new Error('Antigravity does not support rewind.'))
  }

  listCommands(): Promise<SlashCommandInfo[]> {
    return Promise.resolve([])
  }

  private stateFor(ws: Workspace): State {
    const found = this.states.get(ws.id)
    if (found) return found
    const defaults = agentSettingsFor(getStore().getState().settings, ANTIGRAVITY_META.id)
    const state: State = {
      conversationId: ws.sessionId,
      model: ws.model ?? defaults.model,
      effort: ws.effort ?? defaults.effort,
      permissionMode: ws.permissionMode,
      extraDirs: [...(ws.additionalDirs ?? [])],
      child: null,
      abort: null,
      running: false,
      queue: []
    }
    this.states.set(ws.id, state)
    return state
  }

  private stateForId(id: string): State | undefined {
    const ws = this.workspace(id)
    return ws ? this.stateFor(ws) : undefined
  }

  private workspace(id: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find((ws) => ws.id === id)
  }

  private updateWorkspace(id: string, update: (ws: Workspace) => void): void {
    getStore().update((store) => {
      const ws = store.workspaces.find((item) => item.id === id)
      if (ws) update(ws)
    })
  }

  private persist(workspaceId: string, item: ChatItem): void {
    getTranscripts().upsert(workspaceId, item)
  }

  private emit(workspaceId: string, event: ChatEvent): void {
    this.dispatch(IPC.evtChat, { workspaceId, event })
  }

  private emitError(workspaceId: string, text: string): void {
    const item: ChatItem = {
      id: `error:antigravity:${randomUUID()}`,
      type: 'error',
      text,
      ts: Date.now()
    }
    this.persist(workspaceId, item)
    this.emit(workspaceId, { type: 'item', item })
  }

  private setRunning(workspaceId: string): void {
    this.updateWorkspace(workspaceId, (ws) => {
      ws.status = 'running'
      ws.lastActiveAt = Date.now()
    })
    this.emit(workspaceId, { type: 'status', status: 'running' })
  }

  private setStatus(workspaceId: string, status: 'idle' | 'error'): void {
    this.updateWorkspace(workspaceId, (ws) => {
      ws.status = status
      ws.lastActiveAt = Date.now()
    })
    this.emit(workspaceId, { type: 'status', status })
    this.notify(
      workspaceId,
      status === 'idle' ? 'completed' : 'error',
      status === 'idle' ? 'Response complete' : 'Session error',
      status === 'error'
    )
  }

  private notify(
    workspaceId: string,
    event: NotificationEvent,
    body: string,
    urgent: boolean
  ): void {
    const win = this.getWindow()
    if (win?.isFocused() || !Notification.isSupported()) return
    const ws = this.workspace(workspaceId)
    if (ws?.muted) return
    const channels = getStore().getState().settings.notifications?.[event]
    if (!channels?.osNotification) return
    const notification = new Notification({
      title: ws ? `${urgent ? '⚠️ ' : ''}${workspaceDisplayName(ws)}` : 'Wooi',
      body,
      silent: !channels.sound
    })
    notification.on('click', () => {
      const current = this.getWindow()
      if (current) {
        if (current.isMinimized()) current.restore()
        current.show()
        current.focus()
      }
      this.dispatch(IPC.evtSelectWorkspace, workspaceId)
    })
    notification.show()
  }
}

/**
 * 평문 `agy models` 출력에서 모델 라벨만 걸러낸다.
 *
 * **필요한 이유가 실측에서 나왔다.** 1.1.13 은 오류에도 exit 0 을 돌려주므로, 줄을 그대로 라벨로
 * 삼으면 로그인 전에 이런 것들이 모델 선택기에 뜬다:
 *
 *   Fetching available models...
 *   Error: Please sign in to view available models. Launch the CLI without arguments to sign in.
 *
 * 게다가 그 값이 `--model` 로 넘어간다. 그래서 진단 문장을 걸러내고, 모델 라벨이 가질 만한
 * 모양(짧은 한 줄, 문장 부호 없음)만 남긴다. 애매하면 버리는 쪽을 택한다 — 놓친 모델은 사용자가
 * CLI 기본값으로 돌리면 되지만, 가짜 라벨은 조용히 잘못된 모델로 실행된다.
 */
export function parseModelsText(text: string): ModelOption[] {
  // **먼저 출력 전체를 본다.** 줄 단위 휴리스틱만으로는 부족하다 — 실측한 사용법 출력의
  // "List available models" 는 어느 모양 규칙으로도 모델 라벨과 구분되지 않는다. 반면 두 실패
  // 모드 모두 `Error:` 또는 `Usage:` 줄을 반드시 남기므로, 그게 보이면 **아무것도 건지지 않는다.**
  // 모델을 놓치면 사용자가 CLI 기본값으로 돌리면 되지만, 가짜 라벨은 조용히 잘못된 모델로 실행된다.
  if (/^\s*(Error|Usage)\s*:/im.test(text)) return []

  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim().replace(/^[*>●•]\s+/, '')
    if (!line) return []
    // 진행 표시·머리말. 목록 앞뒤에 섞여 온다("Fetching available models...").
    if (/^(Fetching|Available|Loading|No\b)/i.test(line)) return []
    if (line.endsWith('...') || line.endsWith('…') || line.endsWith(':')) return []

    // 실측 형식은 **탭으로 나뉜 2열**이다:
    //   gemini-3.1-pro-high\tGemini 3.1 Pro (High)
    // 앞이 `--model` 에 넘길 슬러그, 뒤가 사람이 읽는 이름이다. 줄 전체를 id 로 쓰면 탭까지
    // 포함된 문자열이 `--model` 로 넘어간다.
    const [slug, label] = line.split('\t').map((part) => part.trim())
    if (slug && label) return [{ id: slug, label }]
    return [{ id: slug, label: slug }]
  })
}

function parseModelsJson(text: string): ModelOption[] {
  try {
    const value = JSON.parse(text) as unknown
    const root =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    const entries = Array.isArray(value) ? value : Array.isArray(root?.models) ? root.models : []
    return entries.flatMap((entry) => {
      if (typeof entry === 'string' && entry) return [{ id: entry, label: entry }]
      if (!entry || typeof entry !== 'object') return []
      const object = entry as Record<string, unknown>
      const exact =
        typeof object.label === 'string'
          ? object.label
          : typeof object.name === 'string'
            ? object.name
            : typeof object.id === 'string'
              ? object.id
              : null
      return exact ? [{ id: exact, label: exact }] : []
    })
  } catch {
    return []
  }
}
