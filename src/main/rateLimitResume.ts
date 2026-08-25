import type { AgentBackendId, ChatItem, RateLimitSnapshot, Workspace } from '@shared/types'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { log } from './logger'

const FALLBACK_WAIT_MS = 5 * 60_000
/**
 * 재확인 간격의 상한. reset 시각을 모를 때는 시도마다 간격을 배로 늘리는데(backoffWait),
 * 한 시간에서 멈춰 "언젠가는 다시 본다" 와 "쓸데없이 계속 두드린다" 사이를 잡는다.
 */
const MAX_FALLBACK_WAIT_MS = 60 * 60_000
const RESET_GRACE_MS = 15_000
const MAX_ATTEMPTS = 5
/**
 * 타이머 하나가 한 번에 잘 수 있는 최대 시간. 예약 시각이 아무리 멀어도 이 간격마다 깨어나
 * **벽시계로** 다시 판단한다.
 *
 * 이유는 맥이 자는 동안이다 — 뚜껑을 닫으면 프로세스가 멈추고, 깨어난 뒤 타이머가 남은 시간을
 * 언제부터 다시 세는지는 플랫폼에 맡겨져 있다. 다섯 시간짜리 setTimeout 하나에 걸어 두면 잠든
 * 시간만큼 통째로 밀려 "풀렸는데 영영 안 이어가는" 상태가 된다. 짧게 여러 번 깨어나 매번
 * Date.now() 로 비교하면 잠들었든 시계가 튀었든 늦어야 1분 안에 따라잡는다.
 */
const WAKE_CHECK_MS = 60_000
/**
 * 네트워크가 없어 못 보내고 있을 때 다시 확인하는 간격. 보내 봐야 실패할 것이 뻔하므로
 * 시도 횟수(MAX_ATTEMPTS)는 쓰지 않고, 연결이 돌아오는 것만 기다린다.
 */
const OFFLINE_RECHECK_MS = 30_000
/**
 * 이어 보낸 턴이 이 시간 안에 다시 제한에 걸리면 "같은 제한이 아직 안 풀린 것" 으로 본다.
 * 그보다 오래 정상으로 돌다가 걸린 것은 새 제한이므로 시도 횟수를 처음부터 센다.
 */
const STREAK_WINDOW_MS = 10 * 60_000

export const RATE_LIMIT_CONTINUATION =
  'The previous turn stopped because the provider usage limit was reached. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'

interface Deps {
  backend: AgentBackendId
  refreshLimits: () => Promise<void>
  sendContinuation: (workspaceId: string) => void
  emitItem: (workspaceId: string, item: ChatItem) => void
  /**
   * 지금 네트워크에 닿을 수 있는지. 알 수 없는 환경(테스트 등)에서는 넘기지 않아도 되고,
   * 그때는 늘 온라인으로 본다 — 실패하면 turn 실패 경로가 받아 준다.
   */
  isOnline?: () => boolean
  /**
   * 예약이 생기거나 사라진 것을 렌더러에 알린다. 예약은 Workspace 필드라 **전체 상태 방송으로만**
   * 렌더러에 닿는다 — 이게 없으면 사이드바의 "rate limit · resumes in …" 은 다른 이유로 방송이
   * 일어날 때까지(또는 영영) 뜨지 않는다.
   */
  broadcastState: () => void
}

/**
 * 백엔드 하나의 사용량 제한 예약을 관리한다. 예약의 정본은 Workspace라 앱 재시작 뒤에도 복원되고,
 * Timer는 프로세스가 살아 있는 동안 그 시각을 깨우는 파생 상태일 뿐이다.
 */
export class RateLimitResumeCoordinator {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 이어 보낸 턴이 곧바로 다시 제한에 걸린 횟수와 그 시각.
   *
   * 예약 레코드는 이어 보내기 **직전에** 지우므로, 이걸 따로 들고 있지 않으면 다시 걸렸을 때
   * attempt 가 0 으로 되돌아간다 — 그러면 MAX_ATTEMPTS 가 영영 차지 않아 "제한이 안 풀렸는데
   * 몇 분마다 계속 보내고 계속 실패하는" 무한 루프가 된다.
   */
  private streak = new Map<string, { attempt: number; at: number }>()
  /**
   * 우리가 이어 보낸 턴이 아직 끝나지 않은 워크스페이스. 그 턴이 실패로 끝나면(네트워크가 도중에
   * 끊겼거나 호스트가 죽었거나) 그대로 포기하지 않고 다시 예약하기 위해 들고 있는다
   * ([[rateLimitResume]] noteTurnEnd).
   */
  private continuing = new Set<string>()
  /**
   * 이어 보낸 턴이 제한이 아닌 이유로 잇따라 실패한 횟수. streak 과 따로 세는 이유는 시간 창이다 —
   * streak 은 10분(STREAK_WINDOW_MS)이 지나면 "새 제한" 으로 보고 0 으로 되돌리는데, 15분 돌다가
   * 실패하는 턴에 그 규칙을 쓰면 예산이 영영 차지 않아 같은 실패를 무한히 반복한다.
   */
  private failures = new Map<string, number>()

  constructor(private deps: Deps) {}

  restore(): void {
    for (const ws of getStore().getState().workspaces) {
      if (ws.pendingRateLimitResume?.backend === this.deps.backend && !ws.archived) {
        this.arm(ws.id, ws.pendingRateLimitResume.retryAt)
      }
    }
  }

  /**
   * 워크스페이스의 턴이 사용량 제한으로 멈췄다.
   *
   * **표시는 설정과 무관하게 남긴다** — 자동 이어가기가 꺼져 있어도 사용자는 "왜 멈췄고 언제
   * 풀리는지" 를 사이드바에서 알아야 한다. 이어가기 예약은 설정이 켜져 있을 때만 건다.
   *
   * 표시는 **동기적으로** 기록하고 방송한다. 사용량 조회를 기다린 뒤 방송하면, 그 사이에 지나간
   * 턴 종료(status) 이벤트보다 늦게 도착해 사이드바가 옛 상태로 되돌아갈 수 있다.
   */
  async noteRateLimit(workspaceId: string, resetAt?: number): Promise<void> {
    const state = getStore().getState()
    const ws = state.workspaces.find((item) => item.id === workspaceId)
    if (!ws || ws.archived || ws.agentBackend !== this.deps.backend) return

    // async 함수는 첫 await 전까지 동기로 돈다 — 표시와 방송은 반드시 그 앞에 둔다.
    this.mark(workspaceId, resetAt ?? null)
    if (state.settings.autoResumeAfterRateLimit) {
      await this.schedule(workspaceId, resetAt)
      return
    }
    // 이어가기를 걸지 않아도 "언제 풀리는지" 는 알려 주고 싶다 — 오류가 시각을 안 줬을 때만
    // 사용량을 한 번 더 물어본다(예약 경로는 schedule 이 이미 조회한다).
    if (resetAt === undefined) await this.learnResetTime(workspaceId)
  }

  /** 제한 표시를 기록·갱신하고 방송한다. 이미 아는 해제 시각은 덮어쓰지 않는다. */
  private mark(workspaceId: string, resetsAt: number | null): void {
    getStore().update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)
      if (!target) return
      target.rateLimited = {
        backend: this.deps.backend,
        detectedAt: target.rateLimited?.detectedAt ?? Date.now(),
        resetsAt: resetsAt ?? target.rateLimited?.resetsAt ?? null
      }
    })
    this.deps.broadcastState()
  }

  /** 제한 표시를 지운다(사용자가 다시 보냈거나, 제한이 풀린 것을 확인했을 때). */
  private unmark(workspaceId: string): void {
    let had = false
    getStore().update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)
      had = Boolean(target?.rateLimited)
      if (target) target.rateLimited = null
    })
    if (had) this.deps.broadcastState()
  }

  /** 사용량 스냅샷으로 해제 시각을 채운다. 알아내지 못하면 표시는 시각 없이 그대로 둔다. */
  private async learnResetTime(workspaceId: string): Promise<void> {
    await this.deps
      .refreshLimits()
      .catch((err) => log.info(`rate-limit: usage refresh failed (${String(err)})`))
    const snapshot = getStore().getState().rateLimitsByAgent?.[this.deps.backend]
    const resets = exhaustedResetTimes(snapshot, Date.now())
    if (!resets.length) return
    // 그새 사용자가 다시 보냈다면(표시가 사라졌다면) 되살리지 않는다.
    const still = getStore()
      .getState()
      .workspaces.find((w) => w.id === workspaceId)?.rateLimited
    if (!still) return
    this.mark(workspaceId, Math.max(...resets))
  }

  /**
   * 제한에 걸린 워크스페이스의 이어가기를 예약한다.
   *
   * resetAt 은 제한 오류 자체가 알려 준 해제 시각이다(있으면). 사용량 스냅샷은 라이브 세션이
   * 없으면 비거나 옛 값을 물려받아, 그것만 믿으면 "아직 안 풀렸는데 5분 뒤 재시도" 가 된다.
   */
  private async schedule(workspaceId: string, resetAt?: number): Promise<void> {
    const state = getStore().getState()
    const ws = state.workspaces.find((item) => item.id === workspaceId)
    if (!ws || ws.archived || ws.agentBackend !== this.deps.backend || !ws.sessionId) return
    if (!state.settings.autoResumeAfterRateLimit) return

    await this.deps
      .refreshLimits()
      .catch((err) => log.info(`rate-limit resume: usage refresh failed (${String(err)})`))
    const latest = getStore().getState()
    const previous = latest.workspaces.find(
      (item) => item.id === workspaceId
    )?.pendingRateLimitResume
    const attempt = previous?.attempt ?? this.recentAttempts(workspaceId)
    // 이어 보낼 때마다 곧바로 다시 걸린다면 우리가 아는 해제 시각이 틀린 것이다. 예산을 다 쓰면
    // 조용히 계속 두드리지 않고 사용자에게 넘긴다.
    if (attempt >= MAX_ATTEMPTS) {
      this.clearPending(workspaceId)
      this.streak.delete(workspaceId)
      this.notice(
        workspaceId,
        'The usage limit was still active on every retry, so automatic continuation stopped. Send a message to try again.'
      )
      return
    }
    const snapshot = latest.rateLimitsByAgent?.[this.deps.backend]
    // 조회로 해제 시각을 알아냈다면 표시도 같이 채운다(오류가 시각을 주지 않았을 때의 경로).
    const known = knownResetAt(snapshot, Date.now(), resetAt)
    if (known) this.mark(workspaceId, known)
    const retryAt = retryTime(snapshot, Date.now(), attempt, resetAt)
    getStore().update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)
      if (!target || !target.sessionId) return
      target.status = 'idle'
      target.pendingRateLimitResume = {
        backend: this.deps.backend,
        sessionId: target.sessionId,
        detectedAt: previous?.detectedAt ?? Date.now(),
        retryAt,
        attempt
      }
    })
    this.deps.broadcastState()
    this.notice(
      workspaceId,
      `Usage limit reached. Wooi will continue this task ${formatWhen(retryAt)}.`
    )
    this.arm(workspaceId, retryAt)
  }

  /**
   * 예약과 제한 표시를 모두 접는다. 사용자가 다시 보냈거나(=제한을 스스로 확인했다는 뜻),
   * 중단·/clear 로 이 대화의 진행을 직접 정리한 경우에 부른다.
   */
  cancel(workspaceId: string, announce = false): void {
    this.streak.delete(workspaceId)
    this.continuing.delete(workspaceId)
    this.failures.delete(workspaceId)
    const hadPending = this.clearPending(workspaceId)
    this.unmark(workspaceId)
    if (announce && hadPending) this.notice(workspaceId, 'Automatic continuation was cancelled.')
  }

  /** 자동 이어가기 예약만 일괄 취소한다(설정 끄기·계정 전환). 제한 표시는 사실이므로 남긴다. */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.streak.clear()
    this.continuing.clear()
    this.failures.clear()
    getStore().update((draft) => {
      for (const ws of draft.workspaces) {
        if (ws.pendingRateLimitResume?.backend === this.deps.backend)
          ws.pendingRateLimitResume = null
      }
    })
    this.deps.broadcastState()
  }

  /** 예약(타이머 + 영속 레코드)만 지운다. 연속 실패 기록은 남긴다 — cancel 과 다른 점이다. */
  private clearPending(workspaceId: string): boolean {
    const timer = this.timers.get(workspaceId)
    if (timer) clearTimeout(timer)
    this.timers.delete(workspaceId)
    let hadPending = false
    getStore().update((draft) => {
      const ws = draft.workspaces.find((item) => item.id === workspaceId)
      hadPending = Boolean(ws?.pendingRateLimitResume)
      if (ws) ws.pendingRateLimitResume = null
    })
    if (hadPending) this.deps.broadcastState()
    return hadPending
  }

  /** 방금 이어 보낸 턴이 다시 제한에 걸린 것이라면 그때까지의 시도 횟수를 이어받는다. */
  private recentAttempts(workspaceId: string): number {
    const last = this.streak.get(workspaceId)
    if (!last) return 0
    if (Date.now() - last.at > STREAK_WINDOW_MS) {
      this.streak.delete(workspaceId)
      return 0
    }
    return last.attempt
  }

  /**
   * 다음 확인을 예약한다. 예약 시각이 멀어도 타이머는 WAKE_CHECK_MS 를 넘겨 잡지 않는다 —
   * 깨어난 resume 이 벽시계로 다시 재고 아직 이르면 스스로 다시 건다. 맥이 자거나 시계가 튀어도
   * 예약이 통째로 밀리지 않게 하는 장치다.
   */
  private arm(workspaceId: string, retryAt: number): void {
    const old = this.timers.get(workspaceId)
    if (old) clearTimeout(old)
    const delay = Math.max(0, Math.min(retryAt - Date.now(), WAKE_CHECK_MS))
    this.timers.set(
      workspaceId,
      setTimeout(() => {
        this.timers.delete(workspaceId)
        void this.resume(workspaceId)
      }, delay)
    )
  }

  private async resume(workspaceId: string): Promise<void> {
    const before = this.pendingWorkspace(workspaceId)
    if (!before) return this.cancel(workspaceId)
    // 기다리는 사이 설정이 꺼졌다 — 예약만 접는다. 제한에 걸렸다는 사실은 그대로이므로 표시는 남긴다.
    if (!getStore().getState().settings.autoResumeAfterRateLimit) {
      this.streak.delete(workspaceId)
      this.clearPending(workspaceId)
      return
    }
    if (before.pendingRateLimitResume!.retryAt - Date.now() > 1_000) {
      this.arm(workspaceId, before.pendingRateLimitResume!.retryAt)
      return
    }

    // 네트워크가 없으면 아무것도 보내지 않는다 — 사용량 조회도 턴도 실패할 뿐이고, 그 실패가
    // 시도 예산을 태워 "연결이 돌아왔을 땐 이미 포기한 뒤" 가 된다. 예약은 그대로 두고 기다린다.
    if (this.deps.isOnline && !this.deps.isOnline()) {
      this.holdOffline(workspaceId)
      return
    }
    this.setBlocked(workspaceId, null)

    const previousFetchedAt =
      getStore().getState().rateLimitsByAgent?.[this.deps.backend]?.fetchedAt
    await this.deps.refreshLimits().catch(() => {})
    const current = this.pendingWorkspace(workspaceId)
    if (!current) return
    const pending = current.pendingRateLimitResume!
    const snapshot = getStore().getState().rateLimitsByAgent?.[this.deps.backend]
    // 새 usage 응답을 얻지 못하면 예약해 둔 백오프 시각에 실제 턴으로 확인한다. Claude SDK 의
    // `Assistant error: rate_limit` 은 해제 시각을 주지 않고 usage 조회도 종종 타임아웃되므로,
    // 조회 성공만 고집하면 제한이 풀린 뒤에도 영원히 이어가지 못한다. 실제 턴이 다시 제한되면
    // noteRateLimit 이 더 긴 백오프로 재예약하고 MAX_ATTEMPTS 가 무한 전송을 막는다.
    if (!snapshot || snapshot.fetchedAt === previousFetchedAt) {
      this.continueNow(workspaceId, current, pending)
      return
    }
    // reset 시각이 이미 지났더라도 사용률이 100% 면 아직 제한이다 — 지난 시각만 보고 풀린 것으로
    // 단정하면, 다시 걸릴 게 뻔한 턴을 보내 오류 카드만 쌓는다.
    if (isRateLimited(snapshot)) {
      this.waitLonger(
        workspaceId,
        pending.attempt,
        retryTime(snapshot, Date.now(), pending.attempt + 1),
        'The usage limit is still active, so automatic continuation stopped.',
        (next) => `The usage limit is still active. Wooi will check again ${next}.`
      )
      return
    }

    // 예약 당시의 세션이 그대로일 때만 이어 간다. /clear·계정 전환 등으로 바뀌었다면 과거 작업을
    // 새 맥락에 주입하지 않는다.
    this.continueNow(workspaceId, current, pending)
  }

  private continueNow(
    workspaceId: string,
    current: Workspace,
    pending: NonNullable<Workspace['pendingRateLimitResume']>
  ): void {
    if (current.sessionId !== pending.sessionId) return this.cancel(workspaceId)
    // 이어 보낸 턴이 곧바로 또 걸리면 이 횟수를 물려받아 무한 재시도를 막는다(streak 주석 참고).
    this.streak.set(workspaceId, { attempt: pending.attempt + 1, at: Date.now() })
    this.continuing.add(workspaceId)
    this.clearPending(workspaceId)
    this.unmark(workspaceId)
    this.notice(workspaceId, 'Usage limit reset. Continuing the unfinished task…')
    this.deps.sendContinuation(workspaceId)
  }

  /** 아직 풀리지 않았다 — 시도 예산이 남았으면 다시 예약하고, 아니면 예약을 접는다. */
  private waitLonger(
    workspaceId: string,
    attempt: number,
    next: number,
    exhaustedNote: string,
    waitNote: (when: string) => string
  ): void {
    if (attempt + 1 >= MAX_ATTEMPTS) {
      // 예약만 접는다 — 제한은 아직 살아 있으니 사이드바의 표시는 남겨 둔다.
      this.streak.delete(workspaceId)
      this.clearPending(workspaceId)
      this.notice(workspaceId, exhaustedNote)
      return
    }
    getStore().update((draft) => {
      const ws = draft.workspaces.find((item) => item.id === workspaceId)
      if (ws?.pendingRateLimitResume) {
        ws.pendingRateLimitResume.retryAt = next
        ws.pendingRateLimitResume.attempt += 1
      }
    })
    this.deps.broadcastState()
    this.notice(workspaceId, waitNote(formatWhen(next)))
    this.arm(workspaceId, next)
  }

  /**
   * 턴 하나가 끝났다. **우리가 이어 보낸 턴**일 때만 의미가 있다.
   *
   * 제한이 아닌 이유로 실패한 경우(네트워크가 도중에 끊겼다, 호스트가 죽었다)를 받는 자리다.
   * 예약 레코드는 이어 보내기 직전에 지우므로, 여기서 다시 걸어 주지 않으면 오류 카드 한 장만
   * 남고 그대로 끝난다 — 사용자가 원한 것은 "가능해지면 이어간다" 이지 "한 번 해 보고 만다" 가
   * 아니다.
   */
  noteTurnEnd(workspaceId: string, status: 'idle' | 'error'): void {
    if (!this.continuing.delete(workspaceId)) return
    if (status !== 'error') {
      // 끝까지 갔다 — 다음에 또 실패하더라도 예산은 처음부터 센다.
      this.failures.delete(workspaceId)
      return
    }
    this.retryAfterFailure(workspaceId)
  }

  /** 이어 보낸 턴이 실패했다 — 네트워크가 없으면 연결을 기다리고, 아니면 물러섰다가 다시 보낸다. */
  private retryAfterFailure(workspaceId: string): void {
    const state = getStore().getState()
    const ws = state.workspaces.find((item) => item.id === workspaceId)
    if (!ws || ws.archived || ws.agentBackend !== this.deps.backend || !ws.sessionId) return
    if (!state.settings.autoResumeAfterRateLimit) return
    // 다시 제한에 걸린 것이라면 noteRateLimit 이 이미 예약을 새로 걸었다 — 덮어쓰지 않는다.
    if (ws.pendingRateLimitResume) return

    // 네트워크가 없어서 실패한 것은 우리가 어쩔 수 있는 일이 아니다 — 예산을 쓰지 않고
    // 연결이 돌아올 때까지 기다리기만 한다. 그래야 오프라인이 길어도 포기하지 않는다.
    const offline = Boolean(this.deps.isOnline && !this.deps.isOnline())
    const failures = offline
      ? (this.failures.get(workspaceId) ?? 0)
      : this.bumpFailures(workspaceId)
    if (failures >= MAX_ATTEMPTS) {
      this.failures.delete(workspaceId)
      this.notice(
        workspaceId,
        'The task could not be continued after several attempts, so automatic continuation stopped. Send a message to try again.'
      )
      return
    }
    const retryAt =
      Date.now() + (offline ? OFFLINE_RECHECK_MS : backoffWait(Math.max(0, failures - 1)))
    this.writePending(workspaceId, {
      retryAt,
      attempt: this.recentAttempts(workspaceId),
      blocked: offline ? 'offline' : 'error'
    })
    this.notice(
      workspaceId,
      offline
        ? 'No network connection, so the task could not be continued. Wooi will continue once the connection is back.'
        : `Continuing the task failed. Wooi will try again ${formatWhen(retryAt)}.`
    )
    this.arm(workspaceId, retryAt)
  }

  /** 연속 실패 횟수를 하나 올리고 그 값을 준다. */
  private bumpFailures(workspaceId: string): number {
    const next = (this.failures.get(workspaceId) ?? 0) + 1
    this.failures.set(workspaceId, next)
    return next
  }

  /**
   * 네트워크가 없다 — 예약은 그대로 두고 연결이 돌아오는지만 주기적으로 본다.
   *
   * 영속된 retryAt 은 건드리지 않는다. 30초마다 그 값을 밀면 앱 상태를 그만큼 자주 방송하게 되고,
   * 사이드바 카운트다운도 영영 "곧" 에 머문다. 대신 blocked 표시를 한 번만 바꿔 "연결을 기다리는
   * 중" 이라고 말한다.
   */
  private holdOffline(workspaceId: string): void {
    if (this.setBlocked(workspaceId, 'offline')) {
      this.notice(
        workspaceId,
        'No network connection. Wooi will continue this task once the connection is back.'
      )
    }
    this.arm(workspaceId, Date.now() + OFFLINE_RECHECK_MS)
  }

  /** 예약 레코드를 새로 쓴다(detectedAt 은 있으면 물려받는다). */
  private writePending(
    workspaceId: string,
    fields: { retryAt: number; attempt: number; blocked: 'offline' | 'error' | null }
  ): void {
    getStore().update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)
      if (!target || !target.sessionId) return
      // status 는 건드리지 않는다 — 실패한 턴의 error 를 이 뒤에 매니저가 쓴다. 사이드바는 예약이
      // 있으면 그쪽을 우선해 "다시 시도 예정" 으로 보여 주므로, 여기서 idle 로 덮을 이유가 없다.
      target.pendingRateLimitResume = {
        backend: this.deps.backend,
        sessionId: target.sessionId,
        detectedAt: target.pendingRateLimitResume?.detectedAt ?? Date.now(),
        ...fields
      }
    })
    this.deps.broadcastState()
  }

  /** 예약의 blocked 표시를 바꾼다. 실제로 바뀌었을 때만 방송하고 true 를 준다. */
  private setBlocked(workspaceId: string, blocked: 'offline' | 'error' | null): boolean {
    let changed = false
    getStore().update((draft) => {
      const pending = draft.workspaces.find(
        (item) => item.id === workspaceId
      )?.pendingRateLimitResume
      if (!pending || (pending.blocked ?? null) === blocked) return
      pending.blocked = blocked
      changed = true
    })
    if (changed) this.deps.broadcastState()
    return changed
  }

  private pendingWorkspace(workspaceId: string): Workspace | undefined {
    return getStore()
      .getState()
      .workspaces.find(
        (ws) =>
          ws.id === workspaceId &&
          !ws.archived &&
          ws.agentBackend === this.deps.backend &&
          ws.pendingRateLimitResume?.backend === this.deps.backend
      )
  }

  private notice(workspaceId: string, text: string): void {
    const item: ChatItem = {
      id: `system:rate-limit-resume:${Date.now()}`,
      type: 'system',
      text,
      ts: Date.now()
    }
    getTranscripts().upsert(workspaceId, item)
    this.deps.emitItem(workspaceId, item)
  }
}

export function exhaustedResetTimes(
  snapshot: RateLimitSnapshot | undefined,
  now: number
): number[] {
  if (!snapshot?.available) return []
  return snapshot.windows
    .filter((window) => (window.utilization ?? 0) >= 100)
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((at) => Number.isFinite(at) && at > now)
}

/**
 * 스냅샷이 "아직 제한 중" 이라고 말하는지.
 *
 * Claude usage 응답은 창이 reset 된 직후에도 utilization=100 을 잠시 유지할 수 있다. 새로 조회한
 * 스냅샷의 resetsAt 이 이미 지났다면 서버가 알려 준 해제 시각을 우선해 풀린 것으로 본다. 시각이
 * 없거나 해석할 수 없을 때만 100% 자체를 제한의 근거로 남긴다.
 */
export function isRateLimited(snapshot: RateLimitSnapshot | undefined, now = Date.now()): boolean {
  if (!snapshot?.available) return false
  return snapshot.windows.some((window) => {
    if ((window.utilization ?? 0) < 100) return false
    if (!window.resetsAt) return true
    const resetsAt = Date.parse(window.resetsAt)
    return !Number.isFinite(resetsAt) || resetsAt > now
  })
}

/** reset 시각을 모를 때 다음 확인까지 기다릴 시간. 시도마다 배로 늘려 한 시간에서 멈춘다. */
export function backoffWait(attempt: number): number {
  return Math.min(FALLBACK_WAIT_MS * 2 ** Math.max(0, attempt), MAX_FALLBACK_WAIT_MS)
}

/**
 * 우리가 아는 해제 시각 — 스냅샷의 소진된 창과 오류가 알려 준 resetAt 중 가장 늦은 것.
 * 하나도 모르면 null(그때는 백오프로 다시 확인한다).
 */
export function knownResetAt(
  snapshot: RateLimitSnapshot | undefined,
  now: number,
  resetAt?: number
): number | null {
  const resets = exhaustedResetTimes(snapshot, now)
  if (resetAt && Number.isFinite(resetAt) && resetAt > now) resets.push(resetAt)
  return resets.length ? Math.max(...resets) : null
}

/**
 * 다음 확인 시각. 아는 해제 시각이 있으면 그때까지 기다리고, 모르면 시도 횟수에 따라 물러선다.
 */
export function retryTime(
  snapshot: RateLimitSnapshot | undefined,
  now: number,
  attempt = 0,
  resetAt?: number
): number {
  const known = knownResetAt(snapshot, now, resetAt)
  return (known ?? now + backoffWait(attempt)) + RESET_GRACE_MS
}

function formatWhen(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}
