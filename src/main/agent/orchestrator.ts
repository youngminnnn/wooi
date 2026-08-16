import type { BrowserWindow } from 'electron'
import { getStore } from '../store'
import { getTranscripts } from '../transcripts'
import { buildHandoffPrompt } from '@shared/handoff'
import {
  DEFAULT_AGENT_BACKEND,
  type AgentBackendId,
  type CommandPanelKind,
  type CommandResult,
  type EffortSetting,
  type ImageAttachment,
  type McpAction,
  type CodexMcpServer,
  type CodexPluginDetail,
  type CodexPluginInventory,
  type CodexPluginRef,
  type McpServerInfo,
  type PermissionDecision,
  type PermissionMode,
  type RewindActionResult,
  type SendMessageOptions,
  type SlashCommandInfo
} from '@shared/types'
import type { AgentBackendMeta, ModelOption } from '@shared/types'
import type { AgentBackend } from './backend'
import { backendAvailability, createBackend, type Dispatch } from './registry'
import { AGENT_BACKENDS, backendMeta } from './backend'
import { log } from '../logger'
import { flushBufferedPeerMessages, resetAllPeerSessions, resetPeerSession } from './tools/peer'

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
  /**
   * 다음 전송 전에 세션을 다시 열어야 하는 워크스페이스들([[restartBeforeNextMessage]]).
   *
   * 백엔드별 매니저가 아니라 여기 두는 이유: 세션을 열 때 고정되는 것을 바꾸는 일(멀티 에이전트
   * 전환)은 백엔드 공통이고, Claude·Codex 가 각자 예약을 들고 있으면 한쪽만 고쳐진 채로 갈린다.
   */
  private pendingRestart = new Set<string>()
  /**
   * 지금 도는 턴이 **끝나는 즉시** 세션을 다시 열고 이어 보낼 프롬프트([[resumeAfterTurn]]).
   *
   * pendingRestart 와 짝이지만 다른 것을 정한다. 저쪽은 "언제 다시 여는가"(다음 전송 직전)이고,
   * 이쪽은 "그 전송을 누가 하는가"(사용자가 아니라 Wooi)다. 그래서 이 자리에 값이 있으면
   * pendingRestart 에도 반드시 들어 있다.
   */
  private pendingResume = new Map<string, string>()

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
      backend = createBackend(id, {
        dispatch: this.dispatch,
        getWindow: this.getWindow,
        // 턴의 끝은 백엔드만 알지만, 그때 무엇을 할지는 백엔드 공통이다([[handleTurnEnd]]).
        onTurnEnd: (workspaceId, status) => this.handleTurnEnd(workspaceId, status)
      })
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
    const pendingBackends = new Set(
      getStore()
        .getState()
        .workspaces.flatMap((workspace) =>
          workspace.pendingRateLimitResume ? [workspace.pendingRateLimitResume.backend] : []
        )
    )
    for (const backend of pendingBackends) this.get(backend)
    const hasCodexWorkspace = getStore()
      .getState()
      .workspaces.some((workspace) => workspace.agentBackend === 'codex' && !workspace.archived)
    if (hasCodexWorkspace) this.get('codex').prewarm?.()
  }

  /**
   * 다음 전송에서 세션을 새로 열게 한다. 대화는 그대로다 — 다음 전송이 저장된 sessionId 로
   * resume 하므로(모델·effort 를 바꿀 때와 같은 길), 사용자에게는 그 한 번의 응답이 조금 느린
   * 것으로만 나타난다.
   *
   * **지금 끊지 않는** 것이 요점이다. 이 예약을 부르는 쪽은 도구 실행부이고, 그 도구는 지금
   * 도는 턴 안에서 불린다 — 여기서 dispose 하면 도구 결과가 돌아갈 세션이 사라져 턴이 통째로
   * 죽는다. 그래서 지금이 아니라 나중에 건다.
   *
   * 사용자가 손으로 켠 것(헤더 배지)처럼 **아무도 기다리고 있지 않은** 변경에 쓴다. 사용자가
   * 방금 말로 시킨 일이 이 재시작을 기다리고 있다면 [[resumeAfterTurn]] 이다 — 그때는 다음 말을
   * 걸어 달라고 하는 것 자체가 마찰이다.
   */
  restartBeforeNextMessage(workspaceId: string): void {
    this.pendingRestart.add(workspaceId)
    // 예약해 둔 자동 이어가기가 있었다면 접는다. 이쪽을 부른 쪽은 "사용자의 다음 메시지에 반영
    // 하라" 고 말한 것이라 "지금 이어 가라" 와 정면으로 어긋난다 — 실제로 겹치는 경우가 그렇다:
    // 모델이 팀으로 바꾼 턴이 끝나기 전에 사용자가 헤더 배지로 다시 Solo 로 돌리면(ipc 의
    // workspaceSetMultiAgent), 이어 갈 턴은 "팀원 도구가 실렸다" 는 거짓말로 시작하게 된다.
    this.cancelResume(workspaceId)
  }

  /**
   * 지금 도는 턴이 끝나는 즉시 세션을 다시 열고, 이어서 한 턴을 더 보낸다.
   *
   * [[restartBeforeNextMessage]] 와 예약하는 것은 같고 **시점만 다르다**. 저쪽은 사용자가 다음
   * 말을 걸 때까지 기다리므로, 사용자가 방금 말로 시킨 일("Codex 한테 리뷰 시켜줘")이 도구 하나
   * 켜는 데서 멈추고 "이제 다시 말해 주세요" 로 끝난다. 이쪽은 그 요청의 연장선에서 턴이 이어진다.
   *
   * 사용자가 시작하지 않은 턴을 도는 것은 한 번 되돌린 적이 있는 설계다([[shared/handoff]]).
   * 거기서는 사용자가 **아무것도 요청하지 않은** 상태에서 요약 턴이 돌았고, 그 사이 입력한 명령이
   * 그 턴에 빨려 들어가 무시됐다. 여기는 사용자가 방금 작업을 시켰고 그 결과를 기다리는 중이라
   * 이어지는 턴이 곧 사용자가 원한 그 작업이다. 그래도 같은 함정을 피하는 방어는 따로 있다 —
   * [[handleTurnEnd]] 가 턴 사이에 틈을 만들지 않는다.
   */
  resumeAfterTurn(workspaceId: string, prompt: string): void {
    this.pendingRestart.add(workspaceId)
    this.pendingResume.set(workspaceId, prompt)
  }

  /**
   * 백엔드가 턴 종료를 알려 온다([[agent/backend]] TurnEndHook). 이어 보낼 것이 있으면 여기서
   * 보내고 true 를 돌려준다 — 그러면 백엔드는 이 턴을 끝난 것으로 방송하지 않는다.
   *
   * **방송하지 않는 것이 이 설계의 전부다.** 방송하면 턴과 턴 사이에 렌더러가 "쉬고 있다" 고 보는
   * 틈이 생기고, 그 틈에 사용자가 친 말은 곧 시작될 자동 턴에 섞여 들어간다 — Codex 는 steering
   * 으로 즉시([[agent/backend]] CODEX_META 의 capabilities.steering), Claude 는 대기 큐가 풀려서
   * (렌더러 store 의 messageQueue). 정확히 그 실패를 한 번 겪고 설계를 되돌린 적이 있다
   * ([[shared/handoff]]). 틈이 없으면 입력창은 계속 '진행 중' 규칙으로 동작하므로 렌더러는 고칠
   * 것이 없다 — 사용자에게는 턴 하나가 이어서 도는 것으로만 보인다.
   */
  private handleTurnEnd(workspaceId: string, status: 'idle' | 'error'): boolean {
    if (status === 'error') {
      // 오류 뒤 백엔드가 같은 프로세스를 재사용할지 새 세션을 만들지 확정할 수 없다. 보안 규칙이
      // 빠진 표식만 보내는 것보다 다음 건에 전문을 한 번 더 싣는 쪽으로 기울인다.
      resetPeerSession(workspaceId)
    }
    const resume = this.pendingResume.get(workspaceId)
    if (!resume) {
      // accept 메시지는 running 턴을 끊지 않고 여기까지 모은다. 여기서 true 를 돌려 idle 방송을
      // 막아야 합쳐진 사용자 메시지가 시작하는 다음 턴 사이에 거짓 idle 틈이 생기지 않는다.
      return status === 'idle' && flushBufferedPeerMessages(workspaceId)
    }
    // 어느 쪽으로 끝났든 예약은 여기서 소진된다. 남겨 두면 한참 뒤 다른 턴이 끝날 때 뜬금없이
    // 되살아난다.
    this.pendingResume.delete(workspaceId)
    // 오류로 끝난 자리에서 자동으로 한 턴을 더 태우지 않는다 — 같은 실패를 반복하기 쉽고,
    // 무엇보다 사용자가 멈춘 것을 화면에서 봐야 한다. 재시작 예약은 남으므로 다음 메시지가 연다.
    if (status !== 'idle') return false

    // 여기서는 끊어도 된다 — 턴이 이미 끝나 결과를 기다리는 도구 호출이 없다. 이게 예약을 "다음
    // 전송 직전" 이 아니라 지금 풀 수 있는 이유다(restartBeforeNextMessage 주석 참고).
    this.dispose(workspaceId)
    this.touch(workspaceId)
    try {
      // silent — 사용자가 치지도 않은 문장이 자기 말풍선으로 대화에 쌓이면 안 된다. 모델에게만
      // 가고 기록에는 아무것도 남지 않는다([[agent/backend]] sendMessage).
      this.backendFor(workspaceId).sendMessage(workspaceId, resume, undefined, { silent: true })
    } catch (err) {
      log.error(`orchestrator: 턴 종료 뒤 자동 이어가기 실패 (${workspaceId})`, err)
      // 못 보냈으면 턴은 그냥 끝난 것이다. false 를 돌려 백엔드가 idle 을 방송하게 둔다 —
      // 여기서 true 를 돌리면 사이드바가 영영 '진행 중' 에 갇힌다.
      return false
    }
    return true
  }

  /**
   * 사용자가 직접 개입했다 — 예약된 자동 이어가기를 접는다.
   *
   * 자동 턴의 명분은 "사용자가 방금 시킨 일을 이어서 한다" 하나뿐이다. 그 사이 사용자가 직접
   * 보내거나·중단하거나·대화를 비웠다면 그 명분이 사라진다. 재시작 예약(pendingRestart)은 건드리지
   * 않는다 — 세션이 낡았다는 사실은 개입과 무관하게 그대로다.
   */
  private cancelResume(workspaceId: string): void {
    this.pendingResume.delete(workspaceId)
  }

  sendMessage(
    workspaceId: string,
    text: string,
    images?: ImageAttachment[],
    opts?: SendMessageOptions
  ): void {
    // 사용자가 먼저 말을 걸었다 — 이 전송이 세션을 다시 열므로 자동 이어가기는 할 일이 없다.
    this.cancelResume(workspaceId)
    // 세션이 없으면 dispose 는 no-op 이고, 어차피 이 전송이 새로 연다.
    if (this.pendingRestart.has(workspaceId)) this.dispose(workspaceId)
    this.touch(workspaceId)
    const prefix = this.takeHandoffPrefix(workspaceId, text)
    this.backendFor(workspaceId).sendMessage(
      workspaceId,
      text,
      images,
      prefix ? { ...opts, prefix } : opts
    )
    this.trimIdleSessions()
  }

  /**
   * 에이전트를 바꾸면서 예약해 둔 인수인계가 있으면([[ipc]] 의 workspaceSetAgentBackend), 이번
   * 메시지 앞에 붙일 프롬프트를 만들고 예약을 지운다.
   *
   * 교체 직후에 따로 한 턴을 돌리지 않고 **다음 메시지에 얹는** 이유는 [[shared/handoff]] 에
   * 적어 뒀다 — 요약하면, 사용자가 시작하지 않은 턴이 도는 동안 입력한 명령이 그 턴으로 빨려
   * 들어가 엉뚱한 답이 나왔기 때문이다.
   *
   * 슬래시 명령과 `!셸` 은 건드리지 않는다. 프롬프트가 아니라 명령이라 백엔드가 다른 경로로
   * 가로채기도 하고(codex 의 /compact·/review·/fork), 지난 대화를 붙일 자리도 아니다 — 예약은
   * 그대로 남아 다음 **메시지**에 얹힌다.
   */
  private takeHandoffPrefix(workspaceId: string, text: string): string | undefined {
    const store = getStore()
    const fromLabel = store
      .getState()
      .workspaces.find((w) => w.id === workspaceId)?.pendingHandoffFrom
    if (!fromLabel) return undefined
    const trimmed = text.trim()
    if (trimmed.startsWith('/') || trimmed.startsWith('!')) return undefined

    // 프롬프트를 만들지 못했더라도(그 사이 /clear 로 대화가 비었다) 예약은 지운다 — 넘길 것이 없다.
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.pendingHandoffFrom = null
    })
    return buildHandoffPrompt({ items: getTranscripts().load(workspaceId), fromLabel }) ?? undefined
  }

  interrupt(workspaceId: string): Promise<void> {
    // 중단은 "그만" 이다. 그 턴이 끝나자마자 Wooi 가 다음 턴을 시작하면 중단이 중단이 아니게 된다.
    this.cancelResume(workspaceId)
    return this.backendFor(workspaceId).interrupt(workspaceId)
  }

  stopTask(workspaceId: string, taskId: string): Promise<void> {
    const backend = this.backendFor(workspaceId)
    const stopTask = backend.stopTask
    if (!stopTask) return Promise.resolve()
    return stopTask.call(backend, workspaceId, taskId)
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
    // 맥락을 비운 대화에 옛 턴의 이어가기를 밀어 넣지 않는다 — 이어갈 대화가 이미 없다.
    this.cancelResume(workspaceId)
    resetPeerSession(workspaceId)
    this.backendFor(workspaceId).clearSession(workspaceId)
  }

  async clearGoal(workspaceId: string): Promise<void> {
    const clear = this.backendFor(workspaceId).clearGoal
    if (!clear) throw new Error('This agent does not support clearing goals from Wooi.')
    await clear.call(this.backendFor(workspaceId), workspaceId)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    // requestId 는 워크스페이스에 매이지 않으므로, 어느 백엔드가 그 요청을 띄웠는지 알 수 없다.
    // 권한 응답은 멱등(대상 백엔드만 매칭, 나머지는 무시)이라 활성 백엔드 전부에 전달한다.
    for (const backend of this.backends.values()) backend.respondPermission(requestId, decision)
  }

  dispose(workspaceId: string): void {
    this.lastUsedAt.delete(workspaceId)
    // 어떤 이유로 끊겼든 다음 전송은 어차피 새 세션이다 — 예약이 남아 있으면 그다음 전송에서
    // 이미 새것인 세션을 한 번 더 끊는다.
    this.pendingRestart.delete(workspaceId)
    // 세션이 사라졌으면 이어갈 턴도 사라진 것이다. (자동 이어가기 자신이 부르는 dispose 는
    // 이미 예약을 꺼내 간 뒤라 여기서 지울 것이 없다 — [[handleTurnEnd]])
    this.cancelResume(workspaceId)
    resetPeerSession(workspaceId)
    this.backendFor(workspaceId).dispose(workspaceId)
  }

  disposeAll(): void {
    this.lastUsedAt.clear()
    this.pendingRestart.clear()
    this.pendingResume.clear()
    resetAllPeerSessions()
    for (const backend of this.backends.values()) backend.disposeAll()
  }

  abortAll(): void {
    this.lastUsedAt.clear()
    this.pendingRestart.clear()
    this.pendingResume.clear()
    resetAllPeerSessions()
    for (const backend of this.backends.values()) backend.abortAll()
  }

  /** 계정 전환 후 모든 백엔드의 세션 프로세스를 재활용한다(대화 맥락은 유지). */
  recycleAll(): void {
    // 프로세스가 갈리므로 살아 있던 세션도 함께 사라진다 — 다음 전송이 다시 만든다.
    this.lastUsedAt.clear()
    this.pendingRestart.clear()
    this.pendingResume.clear()
    resetAllPeerSessions()
    for (const backend of this.backends.values()) backend.recycleAll()
  }

  cancelAllRateLimitResumes(): void {
    for (const backend of this.backends.values()) backend.cancelAllRateLimitResumes?.()
    // 아직 인스턴스화되지 않은 backend의 영속 예약도 함께 제거한다.
    getStore().update((state) => {
      for (const ws of state.workspaces) ws.pendingRateLimitResume = null
    })
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

  /**
   * 백엔드가 자기 설정 파일에 들고 있는 MCP 서버 목록(설정 화면용).
   *
   * 쓸 수 없는 백엔드(CLI 미설치)에는 **프로세스를 띄우지 않고** 빈 목록으로 끊는다 —
   * 설정 화면을 여는 것만으로 안 쓰는 에이전트가 뜨면 순수 비용이다.
   */
  async configuredMcpServers(id: AgentBackendId): Promise<CodexMcpServer[]> {
    const { available } = await backendAvailability(id)
    if (!available) return []
    const backend = this.get(id)
    if (!backend.listConfiguredMcpServers) return []
    return backend.listConfiguredMcpServers()
  }

  /** 그 목록의 서버 하나를 켜고 끈다. 지원하지 않는 백엔드면 에러로 알린다. */
  setMcpServerEnabled(
    id: AgentBackendId,
    serverName: string,
    enabled: boolean
  ): Promise<CodexMcpServer[]> {
    const backend = this.get(id)
    if (!backend.setMcpServerEnabled) {
      throw new Error(`${backend.meta.label} does not manage MCP servers in its own config.`)
    }
    return backend.setMcpServerEnabled(serverName, enabled)
  }

  /**
   * 백엔드 설치본에 깔린 플러그인 목록(설정 화면용).
   *
   * MCP 목록과 같은 판단으로, 쓸 수 없는 백엔드에는 프로세스를 띄우지 않고 끊는다. 다만 여기서는
   * 빈 목록이 아니라 supported=false 를 돌려준다 — 화면이 "플러그인이 없다" 와 "이 백엔드는
   * 플러그인을 모른다" 를 다르게 그려야 하기 때문이다.
   */
  async plugins(id: AgentBackendId, cwds: string[]): Promise<CodexPluginInventory> {
    const unsupported: CodexPluginInventory = { supported: false, marketplaces: [], loadErrors: [] }
    const { available } = await backendAvailability(id)
    if (!available) return unsupported
    const backend = this.get(id)
    if (!backend.listPlugins) return unsupported
    return backend.listPlugins(cwds)
  }

  /** 그 목록의 플러그인 하나가 무엇을 싣고 있는지. 지원하지 않는 백엔드면 에러로 알린다. */
  readPlugin(id: AgentBackendId, ref: CodexPluginRef): Promise<CodexPluginDetail> {
    const backend = this.get(id)
    if (!backend.readPlugin) {
      throw new Error(`${backend.meta.label} does not expose plugin details.`)
    }
    return backend.readPlugin(ref)
  }

  /** MCP OAuth 를 지원하는 백엔드에서 authorization URL 을 받는다. */
  loginMcpServer(id: AgentBackendId, serverName: string): Promise<string> {
    const backend = this.get(id)
    if (!backend.loginMcpServer) {
      throw new Error(`${backend.meta.label} does not support MCP OAuth login.`)
    }
    return backend.loginMcpServer(serverName)
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
    return backend.listCommands(workspaceId, cwd)
  }
}
