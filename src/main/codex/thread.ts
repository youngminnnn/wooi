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
import { RPC, type ThreadResult } from './wire'
import { turnPolicyFor } from './modes'
import { createMapperState, mapNotification, type MapperState } from './mapping'
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
        effort: codexEffort(this.config.effort),
        cwd: this.config.cwd,
        ...policy
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
   * 여기서는 요청만 보낸다. 스레드가 아직 없으면 압축할 것도 없다.
   */
  async compact(): Promise<void> {
    if (!this.threadId) return
    try {
      const rpc = await this.deps.rpc()
      await rpc.request(RPC.threadCompact, { threadId: this.threadId })
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
    const params = {
      cwd: this.config.cwd,
      model: this.config.model ?? undefined,
      ...policy
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

  /** 호스트가 이 스레드 앞으로 라우팅한 알림을 처리한다. */
  handleNotification(method: string, params: unknown): void {
    // 턴 id 추적 — steer 대상과 interrupt 대상을 알기 위해 필요하다.
    const turn = (params as { turn?: { id?: string; status?: string } })?.turn
    if (method === 'turn/started' && turn?.id) this.activeTurnId = turn.id
    if (method === 'turn/completed' || method === 'turn/failed') this.activeTurnId = null

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
