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
  PermissionMode,
  SendMessageOptions
} from '@shared/types'
import type { RpcClient } from './jsonrpc'
import {
  NOTIFY,
  RPC,
  type FileUpdateChange,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadResult
} from './wire'
import { turnPolicyFor } from './modes'
import { WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import type { AgentBackendId } from '@shared/types'
import { wooiMcpServerTable, wooiToolServer } from './appServer'
import {
  createMapperState,
  mapNotification,
  rememberOptimisticUser,
  type MapperState
} from './mapping'
import type { FileChangePatchParams, ItemParams } from './wire'
import type { CodexConfig } from './protocol'
import { unknownItemId } from '@shared/types'

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

  /**
   * `prefix` 는 사용자가 쓴 말이 아니라 Wooi 가 앞에 붙여 주는 맥락이다([[codex/protocol]]).
   * 기록에는 사용자의 말만 남지만 서버로는 합쳐서 가므로, echo 를 삼키는 등록은 **합친 쪽**으로
   * 해야 한다 — 서버가 되돌려 주는 것이 그것이라, 어긋나면 mapper 가 그 echo 를 처음 보는
   * 사용자 메시지로 알고 인수인계 프롬프트 전문을 화면에 되살린다.
   */
  async send(
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions,
    skill?: { name: string; path: string; prompt: string }
  ): Promise<void> {
    if (this.disposed) return
    const modelText = skill?.prompt ?? text
    const prompt = opts?.prefix ? `${opts.prefix}\n\n${modelText}` : modelText
    const attachments = (images ?? []).map((image) => ({
      name: image.name,
      mediaType: image.mediaType
    }))
    // CLI 탐지·app-server 초기화보다 먼저 반응한다. 이후 userMessage 알림은 mapper 가 소비한다.
    //
    // silent 전송에서도 **반드시** 등록한다([[agent/backend]] sendMessage). 기록만 건너뛰면 될 것
    // 같지만, 이걸 빼면 서버가 되돌려 주는 echo 를 mapper 가 처음 보는 사용자 메시지로 알고
    // 화면에 되살린다 — 숨기려던 문장이 그대로 뜬다.
    rememberOptimisticUser(
      this.state,
      prompt,
      attachments.map((attachment) => attachment.name)
    )
    if (!opts?.silent) {
      const item: ChatItem = {
        id: `user:${randomUUID()}`,
        type: 'user',
        text,
        ts: Date.now(),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(attachments.length ? { attachments } : {})
      }
      this.deps.persist(item)
      this.deps.emit({ type: 'item', item })
    }
    try {
      const rpc = await this.deps.rpc()
      const threadId = await this.ensureThread(rpc)
      // app-server 는 TUI 의 `/skill` 확장을 하지 않는다. 명시적인 SkillUserInput 을 실어야
      // 모델이 SKILL.md 를 호출 대상으로 받으므로, 자동완성 선택을 평문 슬래시로 보내지 않는다.
      const input = buildInput(prompt, images, skill)
      const policy = turnPolicyFor(this.config.permissionMode, this.config.cwd)

      // 턴이 도는 중이면 새 턴을 만들지 않고 밀어 넣는다(Codex 네이티브 steering).
      if (this.activeTurnId) {
        const steered = await rpc
          .tryRequest<{ turnId?: string }>(RPC.turnSteer, { threadId, input })
          .catch(() => undefined)
        if (steered) return
        // steer 를 못 쓰는 버전이면 사용자에게 알린다 — 서버가 거절한 경우(리뷰·수동 압축 턴)는
        // 정상 폴백이므로 알리지 않는다. 이 구분이 없으면 정상 동작에도 카드가 떠 노이즈가 된다.
        if (!rpc.supports(RPC.turnSteer)) {
          this.noticeUnknown(
            'method "turn/steer"',
            'Update the Codex CLI to use this: npm i -g @openai/codex'
          )
        }
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
        approvalsReviewer: policy.approvalsReviewer,
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
      await this.refreshGoal(rpc, forkedId)
      this.notice('Forked this conversation into a new Codex thread.')
    } catch (err) {
      this.fail(err)
    }
  }

  async setGoal(args: {
    objective?: string | null
    status?: ThreadGoalStatus | null
    tokenBudget?: number | null
  }): Promise<ThreadGoal> {
    const rpc = await this.deps.rpc()
    const threadId = await this.ensureThread(rpc)
    const result = await rpc.request<{ goal?: ThreadGoal }>(RPC.threadGoalSet, {
      threadId,
      ...args
    })
    if (!result?.goal) throw new Error('Codex did not return the updated goal')
    this.emitGoal(result.goal)
    return result.goal
  }

  async getGoal(): Promise<ThreadGoal | null> {
    const rpc = await this.deps.rpc()
    const threadId = await this.ensureThread(rpc)
    const result = await rpc.request<{ goal?: ThreadGoal | null }>(RPC.threadGoalGet, { threadId })
    const goal = result?.goal ?? null
    if (goal) this.emitGoal(goal)
    else this.deps.emit({ type: 'goal', goal: null })
    return goal
  }

  async clearGoal(): Promise<boolean> {
    const rpc = await this.deps.rpc()
    const threadId = await this.ensureThread(rpc)
    const result = await rpc.request<{ cleared?: boolean }>(RPC.threadGoalClear, { threadId })
    // 알림보다 응답이 먼저 와도 버튼이 즉시 사라져야 한다. 뒤따르는 clear 알림은 멱등이다.
    this.deps.emit({ type: 'goal', goal: null })
    return !!result?.cleared
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
    this.deps.emit({ type: 'goal', goal: null })
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
      approvalsReviewer: policy.approvalsReviewer,
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
      ...wooiMcpConfig(this.workspaceId, this.config.delegateBackends)
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
        await this.refreshGoal(rpc, id)
        // active 알림이 resume 응답보다 먼저 오면 아직 이 객체가 threadId 를 소유하지 않아 host
        // 라우터가 버린다. 응답의 상태도 함께 읽어 그 순서에서도 running 을 복구한다.
        if (threadStatusType(result?.thread?.status) === 'active') {
          this.deps.emit({ type: 'status', status: 'running' })
        }
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
    await this.refreshGoal(rpc, id)
    return id
  }

  private adoptThread(id: string): void {
    this.threadId = id
    this.config = { ...this.config, resumeThreadId: id }
    this.deps.onThreadId(id)
  }

  private async refreshGoal(rpc: RpcClient, threadId: string): Promise<void> {
    try {
      const result = await rpc.request<{ goal?: ThreadGoal | null }>(RPC.threadGoalGet, {
        threadId
      })
      if (result?.goal) this.emitGoal(result.goal)
      else this.deps.emit({ type: 'goal', goal: null })
    } catch (err) {
      // 목표 API가 없는 구버전에서도 대화 자체는 열려야 한다. 명시적 get/set/clear 호출은 그대로 실패한다.
      log.info(`codex: could not refresh goal for ${threadId}: ${describe(err)}`)
    }
  }

  // ── 알림 수신 ───────────────────────────────────────────────────────

  /** itemId → 그 패치의 변경 목록. 승인 요청에는 diff 가 없어 여기서 꺼내 쓴다. */
  fileChanges(itemId: string): FileUpdateChange[] {
    return this.pendingPatches.get(itemId) ?? []
  }

  /** 호스트가 이 스레드 앞으로 라우팅한 알림을 처리한다. */
  handleNotification(method: string, params: unknown): void {
    if (method === NOTIFY.threadGoalUpdated) {
      const goal = (params as { goal?: ThreadGoal })?.goal
      if (goal) this.emitGoal(goal)
      return
    }
    if (method === NOTIFY.threadGoalCleared) {
      this.deps.emit({ type: 'goal', goal: null })
      return
    }
    // 앱 재시작은 저장돼 있던 running 을 idle 로 초기화하지만, Codex app-server 는 resume 한
    // 스레드의 기존 턴을 계속 이어 갈 수 있다. 그 턴의 turn/started 는 재시작 전에 이미 지나가
    // 다시 오지 않으므로, 서버가 알려 주는 active 상태로 사이드바 상태를 복구한다.
    //
    // idle 은 여기서 옮기지 않는다. 정상 종료 때 turn/completed 와 같은 시점에 함께 와서 idle 을
    // 두 번 내보내면 매니저의 완료 알림도 두 번 울린다([[mapping]] 의 같은 규칙).
    if (
      method === NOTIFY.threadStatusChanged &&
      threadStatusType((params as { status?: unknown })?.status) === 'active'
    ) {
      this.deps.emit({ type: 'status', status: 'running' })
    }

    // 파일 변경 승인 요청에는 diff 가 실려 오지 않는다 — 같은 itemId 의 fileChange 아이템이
    // 먼저 도착하므로 그때 붙잡아 둔다. 아이템이 확정되면 더 필요 없으니 버린다.
    const item = (params as ItemParams)?.item
    if (item?.type === 'fileChange' && item.id) {
      if (method === NOTIFY.itemCompleted) this.pendingPatches.delete(item.id)
      else this.pendingPatches.set(item.id, item.changes ?? [])
    }

    // 승인 대기 중에 패치가 바뀌면 붙잡아 둔 것도 갱신한다 — 그러지 않으면 사용자가 옛 diff 를
    // 보고 새 내용을 승인하게 된다.
    if (method === NOTIFY.fileChangePatchUpdated) {
      const patch = params as FileChangePatchParams
      if (patch?.itemId && patch.changes?.length) {
        this.pendingPatches.set(patch.itemId, patch.changes)
      }
    }

    // 턴 id 추적 — steer 대상과 interrupt 대상을 알기 위해 필요하다.
    const turn = (params as { turn?: { id?: string; status?: string } })?.turn
    if (method === 'turn/started' && turn?.id) this.activeTurnId = turn.id
    if (method === 'turn/completed' || method === 'turn/failed') this.activeTurnId = null

    const errorInfo = (params as { turn?: { error?: { codexErrorInfo?: string } } })?.turn?.error
      ?.codexErrorInfo
    // 사용량 제한은 **설정과 무관하게** 메인에 알린다 — 자동 이어가기가 꺼져 있어도 사이드바가
    // "제한 때문에 멈췄다" 를 보여 줘야 한다. 오류 카드를 감추는 것(=return)은 이어가기를 예약할
    // 때뿐이다. 그때는 사용자에게 "잠시 멈췄다가 이어감" 한 흐름으로 보여야 하기 때문이다.
    if (method === NOTIFY.turnCompleted && errorInfo === 'UsageLimitExceeded') {
      this.deps.onRateLimit?.()
      if (this.config.autoResumeAfterRateLimit) return
    }

    const mapped = mapNotification(method, params, this.state, (what) => this.noticeUnknown(what))
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

  private emitGoal(goal: ThreadGoal): void {
    if (!goal.objective || !goal.status) return
    this.deps.emit({
      type: 'goal',
      goal: {
        backend: 'codex',
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget ?? null,
        tokensUsed: goal.tokensUsed ?? 0,
        timeUsedSeconds: goal.timeUsedSeconds ?? 0
      }
    })
  }

  /**
   * 해석하지 못한 입력을 사용자에게 한 번만 알린다(Claude 쪽 ClaudeSession.noticeUnknown 과 같은 규약).
   * 버리는 동작은 유지한다 — 여기서 throw 하면 대화가 멈춘다. 버리되 흔적을 남기는 게 목적이다.
   */
  private noticeUnknown(what: string, hint?: string): void {
    if (this.warned.has(what)) return
    this.warned.add(what)
    log.warn(`codex: unmapped ${what} — ignoring (codex may be newer than this Wooi build)`)
    const item: ChatItem = {
      id: unknownItemId('codex', what),
      type: 'unknown',
      backend: 'codex',
      what,
      ...(hint ? { hint } : {}),
      ts: Date.now()
    }
    this.deps.emit({ type: 'item', item })
    this.deps.persist(item)
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

/** app-server 버전별 thread status 모양을 한 문자열로 좁힌다. */
export function threadStatusType(status: unknown): string | null {
  if (typeof status === 'string') return status
  if (!status || typeof status !== 'object') return null
  const type = (status as { type?: unknown }).type
  return typeof type === 'string' ? type : null
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
 * 호출자 식별은 이 문장이 하지 않는다 — 그건 스레드 env 가 실어 나른다([[wooiMcpConfig]]).
 * 여기서 워크스페이스 id 를 알려 주는 것은 모델이 **자기를 가리켜 말할 수 있도록** 하기 위해서다
 * (사용자에게 "이 워크스페이스" 를 설명하거나, 대상 id 와 자기 id 를 구분해야 할 때).
 * 두 번째 문장이 더 중요하다: 옛 지침을 들고 있는 스레드가 `workspaceId` 에 자기 id 를 적어
 * 넣으면 남이 아니라 자기를 지목한 꼴이 되므로, 그 인자의 뜻을 못박아 둔다.
 */
function wooiWorkspaceInstructions(workspaceId: string): string {
  return (
    `You are running inside Wooi workspace \`${workspaceId}\`. ` +
    'Wooi already knows that when you call a `wooi` MCP tool, so you never pass your own id. ' +
    'Any argument naming a workspace on one of those tools means the workspace it ACTS ON, ' +
    'never you — passing your own id there targets yourself and fails. ' +
    // 재개된 스레드는 이 지침의 옛 판본("네 id 를 workspaceId 로 넘겨라")을 대화 기록에 그대로
    // 들고 있다. 새 지침은 resume 에도 실리지만 옛 문장이 지워지지는 않으므로, 상충을 남겨 두면
    // 모델이 기록 쪽을 따른다 — 실측으로 그렇게 실패했다. 그래서 무효를 명시적으로 선언한다.
    'If anything earlier in this conversation told you to pass your own workspace id to a Wooi ' +
    'tool, that instruction is obsolete — ignore it.'
  )
}

function buildInput(
  text: string,
  images?: ImageAttachment[],
  skill?: { name: string; path: string }
): unknown[] {
  const input: unknown[] = []
  if (skill) input.push({ type: 'skill', name: skill.name, path: skill.path })
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
 *
 * 같은 이유로 **Wooi 스코프 MCP 서버도 여기서 다시 선언한다**. 그 서버들은 `-c` 로 프로세스에
 * 등록돼 있는데, 이 config 가 테이블을 통째로 덮으므로 다시 싣지 않으면 멀티 에이전트
 * 워크스페이스에서만 조용히 사라진다.
 */
/**
 * 이 스레드가 쓸 Wooi 도구 서버. **스레드마다** 선언해 `-c` 로 등록된 공용 서버를 덮는다(실측).
 *
 * 덮어쓰는 진짜 이유는 위임 도구가 아니라 `WOOI_TOOL_WORKSPACE` 다. 이 shim 은 우리 프로세스
 * 밖에 있어 "누가 부르는가" 를 맥락으로 알 수 없는데, 한때 그 답을 **모델에게 물었다** — 모든
 * 도구 스키마에 인자를 하나 덧붙여 자기 워크스페이스 id 를 적게 했다. 두 가지가 잘못됐다.
 *
 * 첫째, 대상을 지목하는 도구(`send_to_workspace` 등)와 이름이 겹쳐 모델이 호출자와 대상을
 * 동시에 적을 수 없었다. 둘째, 이름을 바꿔도 지침은 스레드 생성 시점에 박히므로 **이미 열려 있던
 * 대화는 옛 이름을 계속 썼다** — 고쳐도 기존 대화에서는 계속 실패했다.
 *
 * 스레드 env 로 내리면 둘 다 사라진다. 모델은 이 값을 볼 수도 적을 수도 없고, `thread/resume`
 * 도 같은 params 를 받으므로 재개된 대화에도 즉시 적용된다.
 */
function wooiMcpConfig(workspaceId: string, backends: AgentBackendId[]): Record<string, unknown> {
  const server = wooiToolServer()
  if (!server) return {}
  return {
    config: {
      mcp_servers: {
        ...wooiMcpServerTable(),
        [WOOI_MCP_SERVER_NAME]: {
          ...server,
          env: {
            ...server.env,
            WOOI_TOOL_WORKSPACE: workspaceId,
            // 위임 도구는 멀티 에이전트 워크스페이스에만 노출한다 — 빈 값이면 shim 이 안 싣는다.
            ...(backends.length ? { WOOI_TOOL_DELEGATE: backends.join(',') } : {})
          }
        }
      }
    }
  }
}
