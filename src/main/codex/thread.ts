import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '../logger'
import type {
  ChatEvent,
  ChatItem,
  EffortSetting,
  ImageAttachment,
  PermissionMode
} from '@shared/types'
import type { RpcClient } from './jsonrpc'
import { NOTIFY, RPC, type FileUpdateChange, type ThreadResult } from './wire'
import { turnPolicyFor } from './modes'
import { WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import type { AgentBackendId } from '@shared/types'
import { wooiToolServer } from './appServer'
import {
  createMapperState,
  mapNotification,
  rememberOptimisticUser,
  type MapperState
} from './mapping'
import type { ItemParams } from './wire'
import type { CodexConfig } from './protocol'

/**
 * 워크스페이스 1개 = Codex 스레드 1개.
 *
 * app-server 연결은 모든 워크스페이스가 공유하고(호스트가 소유), 이 클래스는 그중 **자기
 * threadId 로 오는 알림만** 처리한다. 스레드 생성/재개, 턴 시작·스티어·중단, 그리고
 * 이벤트 매핑을 책임진다.
 */

export interface ThreadDeps {
  /** 공유 app-server 연결을 얻는다(필요하면 프로세스를 띄운다). */
  rpc: () => Promise<RpcClient>
  emit: (event: ChatEvent) => void
  persist: (item: ChatItem) => void
  /** 확정된 threadId 를 메인에 알린다(resume 토큰으로 저장된다). */
  onThreadId: (id: string) => void
  onRateLimit?: () => void
  /** 턴이 정상 종료 없이 끝났을 때 상태를 idle 로 확정한다. */
  settleIdle: () => void
}

export class CodexThread {
  /** 확정된 codex thread id. 스레드를 아직 안 열었으면 null. */
  private threadId: string | null = null
  /** 스레드 생성/재개 진행 중인 Promise. 동시 호출이 스레드를 두 개 만들지 않게 한다. */
  private opening: Promise<string> | null = null
  /** 지금 도는 턴 id. 있으면 steer, 없으면 새 턴. */
  private activeTurnId: string | null = null
  private state: MapperState = createMapperState()
  /** 모르는 아이템/알림을 종류당 한 번만 로깅하기 위한 기록. */
  private warned = new Set<string>()
  /**
   * 마지막으로 관측한 컨텍스트 사용량.
   *
   * Codex 에는 "지금 사용량을 알려 달라"는 조회 API 가 없다 — 턴 도중 알림으로만 흘러온다.
   * /context 카드가 언제든 답할 수 있도록 흘러가는 값을 여기 붙잡아 둔다.
   */
  private lastUsage: { usedTokens: number; maxTokens: number; percentage: number } | null = null
  /** 승인 대기 중인 패치의 변경 목록(itemId 기준). 승인 요청이 diff 를 싣지 않아 필요하다. */
  private pendingPatches = new Map<string, FileUpdateChange[]>()
  private disposed = false

  constructor(
    private workspaceId: string,
    private config: CodexConfig,
    private deps: ThreadDeps
  ) {}

  /** 이 스레드가 처리해야 할 알림인지. 호스트가 threadId 로 라우팅할 때 쓴다. */
  owns(threadId: string | undefined): boolean {
    return !!threadId && threadId === this.threadId
  }

  /** 설정 갱신(모델·effort·권한 모드). 다음 턴부터 적용된다. */
  update(config: CodexConfig): void {
    // resumeThreadId 는 이미 연 스레드를 덮어쓰면 안 된다 — 우리가 가진 threadId 가 정본이다.
    this.config = { ...config, resumeThreadId: this.threadId ?? config.resumeThreadId }
  }

  /**
   * 권한 모드만 바꾼다. codex 는 정책을 턴 파라미터로 받으므로 다음 턴부터 적용된다
   * (Claude 처럼 진행 중인 턴에 실시간으로 꽂을 수 있는 제어 채널이 없다).
   */
  setPermissionMode(mode: PermissionMode): void {
    this.config = { ...this.config, permissionMode: mode }
  }

  // ── 턴 ──────────────────────────────────────────────────────────────

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    if (this.disposed) return
    const attachments = (images ?? []).map((image) => ({
      name: image.name,
      mediaType: image.mediaType
    }))
    const item: ChatItem = {
      id: `user:${randomUUID()}`,
      type: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {})
    }
    // CLI 탐지·app-server 초기화보다 먼저 반응한다. 이후 userMessage 알림은 mapper 가 소비한다.
    rememberOptimisticUser(
      this.state,
      text,
      attachments.map((attachment) => attachment.name)
    )
    this.deps.persist(item)
    this.deps.emit({ type: 'item', item })
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      const input = buildInput(text, images)
      const policy = turnPolicyFor(this.config.permissionMode, this.config.cwd)

      // 턴이 도는 중이면 새 턴을 만들지 않고 밀어 넣는다(Codex 네이티브 steering).
      if (this.activeTurnId) {
        const steered = await rpc
          .tryRequest<{ turnId?: string }>(RPC.turnSteer, { threadId, input })
          .catch(() => undefined)
        if (steered) return
        // steer 를 못 쓰는 버전이거나 서버가 거절하면(리뷰·수동 압축 턴) 새 턴으로 떨어진다.
      }

      const turn = await rpc.request<{ turn?: { id?: string } }>(RPC.turnStart, {
        threadId,
        input,
        model: this.config.model ?? undefined,
        serviceTier: this.config.fastMode ? 'fast' : undefined,
        effort: codexEffort(this.config.effort),
        cwd: this.config.cwd,
        sandboxPolicy: policy.sandboxPolicy,
        approvalPolicy: policy.approvalPolicy,
        // collaborationMode 는 실험 API 라 initialize 에서 opt-in 해야 전달된다. 서버가 무시하면
        // Plan 모드는 읽기 전용 샌드박스만으로 동작한다(계획 지침 없이도 실행은 막힌다).
        ...(policy.collaborationMode
          ? { collaborationMode: { mode: policy.collaborationMode } }
          : {})
      })
      this.activeTurnId = turn?.turn?.id ?? null
    } catch (err) {
      this.fail(err)
    }
  }

  async interrupt(): Promise<void> {
    const threadId = this.threadId
    const turnId = this.activeTurnId
    if (!threadId || !turnId) {
      // 열린 턴이 없어도 사이드바가 '진행 중'에 갇히지 않도록 상태만 확정한다.
      this.deps.settleIdle()
      return
    }
    try {
      const rpc = await this.deps.rpc()
      await rpc.request(RPC.turnInterrupt, { threadId, turnId })
    } catch (err) {
      log.warn(`codex: interrupt failed for ${this.workspaceId}: ${describe(err)}`)
      this.deps.settleIdle()
    }
  }

  /**
   * 대화 압축을 시작한다(/compact). 진행 상황과 결과는 일반 턴/아이템 알림으로 흘러오므로
   * 여기서는 요청만 보낸다. 앱 재시작 직후라면 저장된 threadId 로 먼저 재개한다.
   */
  async compact(): Promise<void> {
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      await rpc.request(RPC.threadCompact, { threadId })
    } catch (err) {
      this.fail(err)
    }
  }

  /** CLI `/review` 와 같은 현재 worktree 미커밋 변경 리뷰를 현재 대화에서 실행한다. */
  async review(): Promise<void> {
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      await rpc.request(RPC.reviewStart, {
        threadId,
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      })
    } catch (err) {
      this.fail(err)
    }
  }

  /** Codex TUI 의 `!` bash mode. app-server가 같은 thread shell과 기록을 소유한다. */
  async shell(command: string): Promise<void> {
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      await rpc.request(RPC.threadShellCommand, { threadId, command })
    } catch (err) {
      this.fail(err)
    }
  }

  /** 현재 대화를 같은 워크스페이스의 새 Codex thread 로 분기한다. */
  async fork(): Promise<void> {
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      const result = await rpc.request<ThreadResult>(RPC.threadFork, { threadId })
      const forkedId = result?.thread?.id
      if (!forkedId) throw new Error('Codex did not return a forked thread id')
      this.adoptThread(forkedId)
      this.notice('Forked this conversation into a new Codex thread.')
    } catch (err) {
      this.fail(err)
    }
  }

  // ── 상태 조회 (/context·/usage·/permissions 카드용) ─────────────────────

  /** 마지막으로 관측한 컨텍스트 사용량. 아직 턴을 돌린 적이 없으면 null. */
  contextUsage(): { usedTokens: number; maxTokens: number; percentage: number } | null {
    return this.lastUsage
  }

  currentMode(): PermissionMode {
    return this.config.permissionMode
  }

  currentModel(): string | null {
    return this.config.model
  }

  currentCwd(): string {
    return this.config.cwd
  }

  dispose(): void {
    this.disposed = true
    this.activeTurnId = null
  }

  // ── 스레드 열기 ─────────────────────────────────────────────────────

  private ensureThread(rpc: RpcClient): Promise<string> {
    if (this.threadId) return Promise.resolve(this.threadId)
    // 동시에 두 메시지가 들어와도 스레드는 하나만 연다.
    if (!this.opening) {
      this.opening = this.openThread(rpc).finally(() => {
        this.opening = null
      })
    }
    return this.opening
  }

  private async openThread(rpc: RpcClient): Promise<string> {
    const policy = turnPolicyFor(this.config.permissionMode, this.config.cwd)
    // thread/start 는 상세 정책 객체가 아니라 `sandbox` 문자열만 받는다. 여기에 sandboxPolicy 를
    // 보내면 서버가 모르는 필드로 조용히 버리고 설정 기본값으로 스레드를 연다 — 실제 정책은
    // 매 턴의 turn/start 가 싣지만, 스레드 기준선도 맞춰 둔다.
    const params = {
      cwd: this.config.cwd,
      model: this.config.model ?? undefined,
      sandbox: policy.sandboxMode,
      approvalPolicy: policy.approvalPolicy,
      // 워크스페이스 안내와 위임 안내를 한 문자열로 합친다 — developerInstructions 는 하나뿐이라
      // 나중에 쓰는 쪽이 앞의 것을 덮는다.
      developerInstructions: [
        wooiWorkspaceInstructions(this.workspaceId),
        this.config.delegateInstructions
      ]
        .filter(Boolean)
        .join('\n\n'),
      // 위임 도구는 스레드 설정으로만 붙일 수 있다 — codex 에는 in-process MCP 서버가 없고,
      // 프로세스 인자로 넣으면 app-server 를 공유하는 다른 워크스페이스까지 오염된다.
      // 워크스페이스마다 도구 집합이 달라야 하므로(위임 도구는 멀티 에이전트에만) 스레드 단위로
      // 같은 shim 을 한 번 더 선언한다. 스레드 config 는 `-c` 로 등록한 서버를 **덮으므로**(실측)
      // 덮어쓰는 김에 위임 도구를 켠 설정으로 바꿔 놓는 셈이고, 서버 이름은 그대로 하나다.
      ...delegateMcpConfig(this.config.delegateBackends)
    }

    const resume = this.config.resumeThreadId
    if (resume) {
      try {
        const result = await rpc.request<ThreadResult>(RPC.threadResume, {
          threadId: resume,
          ...params
        })
        const id = result?.thread?.id ?? resume
        this.adoptThread(id)
        return id
      } catch (err) {
        // 재개 실패(rollout 파일 삭제·형식 변경 등)로 대화를 아예 못 하게 두지 않는다.
        // 맥락은 잃지만 새 스레드로 계속 진행하고, 그 사실을 사용자에게 알린다.
        log.warn(`codex: resume ${resume} failed, starting fresh: ${describe(err)}`)
        this.notice('Could not resume the previous Codex conversation — starting a new one.')
      }
    }

    const result = await rpc.request<ThreadResult>(RPC.threadStart, params)
    const id = result?.thread?.id
    if (!id) throw new Error('Codex did not return a thread id')
    this.adoptThread(id)
    return id
  }

  private adoptThread(id: string): void {
    this.threadId = id
    this.config = { ...this.config, resumeThreadId: id }
    this.deps.onThreadId(id)
  }

  // ── 알림 수신 ───────────────────────────────────────────────────────

  /** itemId → 그 패치의 변경 목록. 승인 요청에는 diff 가 없어 여기서 꺼내 쓴다. */
  fileChanges(itemId: string): FileUpdateChange[] {
    return this.pendingPatches.get(itemId) ?? []
  }

  /** 호스트가 이 스레드 앞으로 라우팅한 알림을 처리한다. */
  handleNotification(method: string, params: unknown): void {
    // 파일 변경 승인 요청에는 diff 가 실려 오지 않는다 — 같은 itemId 의 fileChange 아이템이
    // 먼저 도착하므로 그때 붙잡아 둔다. 아이템이 확정되면 더 필요 없으니 버린다.
    const item = (params as ItemParams)?.item
    if (item?.type === 'fileChange' && item.id) {
      if (method === NOTIFY.itemCompleted) this.pendingPatches.delete(item.id)
      else this.pendingPatches.set(item.id, item.changes ?? [])
    }

    // 턴 id 추적 — steer 대상과 interrupt 대상을 알기 위해 필요하다.
    const turn = (params as { turn?: { id?: string; status?: string } })?.turn
    if (method === 'turn/started' && turn?.id) this.activeTurnId = turn.id
    if (method === 'turn/completed' || method === 'turn/failed') this.activeTurnId = null

    const errorInfo = (params as { turn?: { error?: { codexErrorInfo?: string } } })?.turn?.error
      ?.codexErrorInfo
    if (
      this.config.autoResumeAfterRateLimit &&
      method === NOTIFY.turnCompleted &&
      errorInfo === 'UsageLimitExceeded'
    ) {
      this.deps.onRateLimit?.()
      return
    }

    const mapped = mapNotification(method, params, this.state, (what) => this.warnOnce(what))
    for (const event of mapped.events) {
      // /context 카드는 조회 API 가 없어 흘러가는 사용량 이벤트를 붙잡아 두어야 답할 수 있다.
      if (event.type === 'context') {
        this.lastUsage = {
          usedTokens: event.usedTokens,
          maxTokens: event.maxTokens,
          percentage: event.percentage
        }
      }
      this.deps.emit(event)
    }
    for (const item of mapped.persist) this.deps.persist(item)
  }

  private warnOnce(what: string): void {
    if (this.warned.has(what)) return
    this.warned.add(what)
    log.warn(`codex: unmapped ${what} — ignoring (codex may be newer than this Wooi build)`)
  }

  // ── 오류 표시 ───────────────────────────────────────────────────────

  private fail(err: unknown): void {
    const text = describe(err)
    log.error(`codex: turn failed for ${this.workspaceId}`, err)
    this.deps.persist(errorItem(text))
    this.deps.emit({ type: 'item', item: errorItem(text) })
    this.deps.emit({ type: 'status', status: 'error' })
    this.activeTurnId = null
  }

  /** 대화 흐름에 남기는 정보성 안내(오류는 아니지만 사용자가 알아야 하는 것). */
  private notice(text: string): void {
    const item: ChatItem = {
      id: `codex:notice:${Date.now()}`,
      type: 'system',
      text,
      ts: Date.now()
    }
    this.deps.persist(item)
    this.deps.emit({ type: 'item', item })
  }
}

function errorItem(text: string): ChatItem {
  return { id: `codex:error:${Date.now()}`, type: 'error', text, ts: Date.now() }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * effort 를 codex 가 받는 값으로 좁힌다.
 * 'ultracode' 는 Claude 전용 모드라 Codex 에는 없다 — 가장 가까운 최고 단계로 환산한다.
 */
function codexEffort(effort: EffortSetting | null): string | undefined {
  if (!effort) return undefined
  if (effort === 'ultracode' || effort === 'max') return 'xhigh'
  return effort
}

/**
 * 사용자 입력을 app-server 의 UserInput 배열로.
 *
 * 이미지는 base64 본문을 그대로 실을 수 없어(프로토콜이 로컬 경로를 받는다) 임시 파일로 떨군다.
 * 임시 디렉터리는 OS 가 정리하므로 우리가 지우지 않는다 — 턴이 끝나기 전에 지우면 codex 가
 * 파일을 읽지 못한다.
 */
/**
 * 이 스레드가 어느 Wooi 워크스페이스인지 모델에게 알려 준다.
 *
 * Claude 는 세션마다 도구 서버 인스턴스를 따로 만들어 워크스페이스를 클로저로 잡지만, Codex 의
 * MCP 서버는 모든 워크스페이스가 공유하는 프로세스 하나뿐이라 그럴 수 없다(자세한 사정은
 * [[codex/toolShim]]). 그래서 값을 여기서 알려 주고 인자로 받는다.
 *
 * 이 문장이 신뢰의 근거는 아니다 — 모델이 다른 id 를 적을 수도 있으므로, 메인이 "실재하고 지금
 * 턴이 도는 워크스페이스인가" 로 다시 좁힌다([[agent/tools/socket]]).
 */
function wooiWorkspaceInstructions(workspaceId: string): string {
  return (
    `You are running inside Wooi workspace \`${workspaceId}\`. ` +
    'Whenever you call a `wooi` MCP tool, pass exactly that id as `workspaceId` — ' +
    'it identifies you, and calls claiming any other workspace are rejected.'
  )
}

function buildInput(text: string, images?: ImageAttachment[]): unknown[] {
  const input: unknown[] = []
  if (text.trim()) input.push({ type: 'text', text })

  for (const image of images ?? []) {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'wooi-codex-'))
      const path = join(dir, safeName(image.name))
      writeFileSync(path, Buffer.from(image.dataBase64, 'base64'))
      input.push({ type: 'localImage', path })
    } catch (err) {
      // 이미지 하나를 못 붙였다고 메시지 전송 자체를 막지는 않는다.
      log.warn(`codex: could not attach image ${image.name}: ${describe(err)}`)
    }
  }

  return input
}

/** 파일명에서 경로 구분자를 제거해 임시 디렉터리 밖으로 새지 않게 한다. */
function safeName(name: string): string {
  return name.replace(/[/\\]/g, '_') || 'image.png'
}

/**
 * 위임 도구를 켠 Wooi shim 을 스레드 설정으로 다시 선언한다.
 *
 * `-c` 로 등록된 프로세스 전역 shim 은 위임 도구를 노출하지 않는다(그쪽 워크스페이스에는 없어야
 * 하므로). 멀티 에이전트 워크스페이스만 여기서 같은 실행 파일을 `WOOI_TOOL_DELEGATE` 와 함께
 * 다시 선언해, 그 스레드에서만 서브에이전트 도구가 보이게 한다.
 *
 * 서버 이름은 그대로 하나다 — 스레드 config 가 프로세스 등록을 덮으므로(실측) 둘이 공존하지
 * 않고, 덮어쓰는 쪽이 더 넓은 도구 집합을 갖는다.
 */
function delegateMcpConfig(backends: AgentBackendId[]): Record<string, unknown> {
  if (!backends.length) return {}
  const server = wooiToolServer()
  if (!server) return {}
  return {
    config: {
      mcp_servers: {
        [WOOI_MCP_SERVER_NAME]: {
          ...server,
          env: { ...server.env, WOOI_TOOL_DELEGATE: backends.join(',') }
        }
      }
    }
  }
}
