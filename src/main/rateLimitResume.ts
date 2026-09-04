import type { AgentBackendId, ChatItem, RateLimitSnapshot, Workspace } from '@shared/types'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { log } from './logger'
import { takeUnrequestedTurn } from './resumeBudget'

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
 * 연결이 끊겨 기다릴 때 확인 간격의 상한. 프록시 오설정처럼 영영 돌아오지 않는 환경에서
 * 30초마다 CLI 를 새로 띄우지 않도록 물러선다. 시도 **횟수**는 여전히 세지 않는다.
 */
const MAX_OFFLINE_RECHECK_MS = 5 * 60_000
/**
 * 연결 복구를 사용량 조회로만 확인하는 횟수. 조회 자체가 종종 실패하므로(라이브 세션 없이
 * 부르면 타임아웃이 잦다) 조회 성공만 고집하면 연결이 돌아왔는데도 영영 이어가지 못한다.
 * 이 횟수를 넘기면 실제 턴을 한 번 보내 확인한다.
 */
const PROBE_PATIENCE = 5
/**
 * 이어 보낸 턴이 이 시간 안에 다시 제한에 걸리면 "같은 제한이 아직 안 풀린 것" 으로 본다.
 * 그보다 오래 정상으로 돌다가 걸린 것은 새 제한이므로 시도 횟수를 처음부터 센다.
 */
const STREAK_WINDOW_MS = 10 * 60_000
/**
 * 예약 시각을 기다리는 동안 "정말 아직 제한 중인가" 를 다시 물어보는 간격.
 *
 * 백엔드 하나당 이 간격으로 **한 번만** 조회하고, 기다리는 워크스페이스들이 그 한 번을 같이 쓴다 —
 * 아홉 개가 같은 제한을 기다린다고 조회를 아홉 번 할 이유는 없다(스냅샷은 계정 단위다).
 */
const EARLY_CHECK_MS = 5 * 60_000
/**
 * "이 창에 걸린 것" 으로 볼 만한 사용률의 하한(likelyExhaustedResetAt).
 *
 * 제한 직후의 수치는 요청 한 번어치만큼 늦으므로 99% 는 100% 로 읽어야 하지만, 20% 는 그렇지 않다.
 * 넉넉하게 잡아도 "늦은 100%" 와 "그냥 모르는 스냅샷" 사이는 충분히 갈린다.
 */
const NEAR_EXHAUSTED_UTILIZATION = 90
/**
 * 예약 시각을 놓친 뒤에도 이어가 볼 수 있는 유예 창.
 *
 * Wooi 는 데스크톱 앱이라 예약 시각에 프로세스가 살아 있으리라는 보장이 없다 — 앱이 꺼져 있거나
 * 맥이 자고 있으면 그 시각은 그냥 지나간다. 늦게라도 이어가는 편이 낫지만, **아무리 늦어도**
 * 이어간다면 그것은 예약이 아니라 "언젠가 앱을 켜면 시키지 않은 턴이 하나 뜬다" 는 뜻이 된다.
 *
 * 한 시간으로 잡은 근거는 MAX_FALLBACK_WAIT_MS 다. 앱이 **돌고 있을 때조차** 예약을 그보다 오래
 * 확인 없이 두지 않으므로, 돌고 있을 때의 최대 방치 시간을 "이 예약을 아직 살아 있는 것으로 볼 수
 * 있는" 상한으로 그대로 쓴다. 그보다 오래 지났으면 예약을 걸 때 본 사용량 그림은 이미 남의 것이고
 * (5시간 창은 그새 리셋되고 다시 소진될 수 있다), 사용자도 그 작업을 손에 들고 있지 않다.
 *
 * **설정으로 만들지 않는다.** 유예 시간을 고르게 하면 사용자가 가장 모르는 때에 고르게 하는
 * 셈이고, Wooi 는 전역 토글을 늘리지 않는 것을 원칙으로 삼는다([[types]] AppSettings 주석).
 */
const MISSED_RESUME_GRACE_MS = 60 * 60_000

export const RATE_LIMIT_CONTINUATION =
  'The previous turn stopped because the provider usage limit was reached. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'

export const CONNECTION_CONTINUATION =
  'The previous turn stopped because Wooi could not reach the API. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'

/**
 * 이어가기 턴이 대화에서 접힐 때 한 줄에 남는 이름([[shared/types]] WooiTurnOrigin).
 *
 * 사용자가 치지 않은 턴이므로 감추지는 않는다 — 다만 지시문 자체는 세 줄짜리 상용구라, 펼쳐 둔 채로는
 * 정작 읽어야 할 앞뒤 대화를 밀어낸다.
 */
export const RATE_LIMIT_CONTINUATION_LABEL = 'Continuing after the usage limit'
export const CONNECTION_CONTINUATION_LABEL = 'Continuing after the connection came back'

/** 예약이 걸린 이유. 저장된 옛 레코드에는 없으므로 사용량 제한으로 읽는다. */
function causeOf(pending: Workspace['pendingRateLimitResume']): 'rateLimit' | 'connection' {
  return pending?.cause ?? 'rateLimit'
}

interface Deps {
  backend: AgentBackendId
  refreshLimits: () => Promise<void>
  sendContinuation: (workspaceId: string, text: string, label: string) => void
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
  private continuing = new Map<string, 'rateLimit' | 'connection'>()
  /**
   * 이어 보낸 턴이 제한이 아닌 이유로 잇따라 실패한 횟수. streak 과 따로 세는 이유는 시간 창이다 —
   * streak 은 10분(STREAK_WINDOW_MS)이 지나면 "새 제한" 으로 보고 0 으로 되돌리는데, 15분 돌다가
   * 실패하는 턴에 그 규칙을 쓰면 예산이 영영 차지 않아 같은 실패를 무한히 반복한다.
   */
  private failures = new Map<string, number>()
  /**
   * 연결이 끊겨 다시 확인한 횟수. 포기의 근거가 아니라 **간격을 늘리는** 근거로만 쓴다
   * (noteConnectionLost). 턴이 끝까지 가면 0 으로 되돌린다.
   */
  private offlineRetries = new Map<string, number>()
  /**
   * 기다리는 중에 사용량을 마지막으로 다시 물어본 시각. 백엔드 하나당 하나다 — 스냅샷은 계정
   * 단위이므로, 같은 제한을 기다리는 워크스페이스가 몇 개든 조회는 EARLY_CHECK_MS 에 한 번이면 된다.
   */
  private earlyCheckAt = 0

  constructor(private deps: Deps) {}

  /**
   * 앱이 다시 떴다 — 살아 있는 예약을 타이머에 다시 건다.
   *
   * 아직 시각이 오지 않은 예약은 그대로 걸면 된다. 문제는 **이미 지나간** 예약이다. 그냥 다시
   * 걸면 arm 이 곧바로 깨어나므로, 밀려 있던 예약이 켜자마자 한꺼번에 터진다 — 사용자가 치지도
   * 않은 턴이 워크스페이스 수만큼 동시에 시작된다. 깨움 하나가 곧 사용자 토큰 하나이므로 이것이
   * 여기서 막아야 할 최악이다.
   *
   * 그래서 놓친 예약에는 세 규칙을 둔다.
   * 1. 유예 창(MISSED_RESUME_GRACE_MS) 안에 복귀했으면 이어간다.
   * 2. 이어가는 것은 **복귀당 하나뿐이다.** 밀린 것이 여럿이어도 몰아서 보내지 않는다.
   * 3. 나머지는 버리고 그렇게 말한다. 자동으로 돌리지 않는다 — 사용자가 한 줄 보내면 이어진다.
   */
  restore(): void {
    const now = Date.now()
    const mine = getStore()
      .getState()
      .workspaces.filter(
        (ws) => ws.pendingRateLimitResume?.backend === this.deps.backend && !ws.archived
      )
    const missed: Workspace[] = []
    for (const ws of mine) {
      const { retryAt } = ws.pendingRateLimitResume!
      if (retryAt > now) this.arm(ws.id, retryAt)
      else missed.push(ws)
    }
    // 놓친 것은 최신 예약부터 본다. 이어갈 하나를 고를 때 가장 덜 상한 것을 고르게 되고, 오래된
    // 것일수록 사용자 손을 떠난 지 오래라 버려도 덜 아깝다.
    missed.sort((a, b) => b.pendingRateLimitResume!.retryAt - a.pendingRateLimitResume!.retryAt)
    for (const ws of missed) {
      const { retryAt } = ws.pendingRateLimitResume!
      if (now - retryAt > MISSED_RESUME_GRACE_MS) {
        this.dropMissed(
          ws.id,
          `Wooi was not running when this task was due to continue (${formatWhen(retryAt)}), so it was not resumed. Send a message to pick it up.`
        )
        continue
      }
      if (!takeUnrequestedTurn()) {
        this.dropMissed(
          ws.id,
          `This task was due to continue at ${formatWhen(retryAt)}, but Wooi had already continued another one on this launch and never starts more than one unrequested turn at a time. Send a message to pick it up.`
        )
        continue
      }
      // 시각은 이미 지났으므로 arm 은 곧바로 깨어난다. 그 뒤 판단은 평소 경로 그대로다 —
      // 오프라인이면 기다리고, 아직 제한 중이면 물러서고, 세션이 바뀌었으면 접는다.
      this.arm(ws.id, retryAt)
    }
  }

  /** 놓친 예약을 버린다. 제한 표시(rateLimited)는 사실이므로 남긴다 — 스스로 만료된다. */
  private dropMissed(workspaceId: string, text: string): void {
    if (this.clearPending(workspaceId)) this.notice(workspaceId, text)
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

  /**
   * 워크스페이스의 턴이 **API 에 닿지 못해** 멈췄다(DNS 실패·연결 거부·소켓 끊김).
   *
   * 사용량 제한과 같은 예약 장치를 쓰되 세 가지가 다르다.
   *
   * 1. **누가 보낸 턴이든 받는다.** noteTurnEnd 는 우리가 이어 보낸 턴만 보므로, 사용자가 직접
   *    보낸 턴이 ENOTFOUND 로 죽으면 오류 카드 한 장만 남고 그대로 끝났다 — 사용자가 원한 것은
   *    "연결이 돌아오면 이어간다" 이지 "한 번 해 보고 만다" 가 아니다.
   * 2. **시도 예산을 쓰지 않는다.** 연결이 돌아오는 데 걸리는 시간은 우리가 정할 수 없고,
   *    다섯 번 만에 포기하면 자다 깬 맥이나 잠깐 끊긴 와이파이에서는 늘 진다.
   * 3. **rateLimited 표시는 남기지 않는다.** 제한에 걸린 것이 아니기 때문이다 — 사이드바가
   *    "rate limit" 이라고 말하면 사용자는 없는 제한을 기다리게 된다.
   *
   * 대신 확인 간격을 30초에서 5분까지 늘려, 영영 돌아오지 않는 환경에서 CLI 를 계속 띄우지 않는다.
   */
  noteConnectionLost(workspaceId: string): void {
    const state = getStore().getState()
    const ws = state.workspaces.find((item) => item.id === workspaceId)
    if (!ws || ws.archived || ws.agentBackend !== this.deps.backend || !ws.sessionId) return
    if (!state.settings.autoResumeAfterRateLimit) return
    // 사용량 제한 예약이 이미 걸려 있으면 그쪽이 우선이다 — 해제 시각을 아는 예약을, 그것을
    // 모르는 예약으로 덮지 않는다.
    if (ws.pendingRateLimitResume && causeOf(ws.pendingRateLimitResume) === 'rateLimit') return

    // 안내는 기다리기 **시작할 때** 한 번만 남긴다 — 확인할 때마다 같은 말을 쌓으면 대화가
    // 오류 로그가 된다. 이어 보내기 직전에 예약 레코드를 지우므로(continueNow), "처음인가" 는
    // 예약의 유무가 아니라 이 카운터로 판단해야 한다.
    if ((this.offlineRetries.get(workspaceId) ?? 0) === 0) {
      this.notice(
        workspaceId,
        'Wooi could not reach the API, so the task stopped. It will continue once the connection is back.'
      )
    }
    this.holdConnection(workspaceId)
  }

  /**
   * 연결이 돌아오기를 기다린다 — 확인 간격을 늘려 가며 다시 깨어날 시각을 예약한다.
   *
   * 간격을 늘리는 이유는 조회·턴 하나하나가 공짜가 아니어서다. 대신 **횟수는 세지 않는다** —
   * 연결이 언제 돌아올지는 우리가 정할 수 없고, 다섯 번 만에 포기하면 자다 깬 맥에서는 늘 진다.
   */
  private holdConnection(workspaceId: string): void {
    const tries = (this.offlineRetries.get(workspaceId) ?? 0) + 1
    this.offlineRetries.set(workspaceId, tries)
    const wait = Math.min(OFFLINE_RECHECK_MS * 2 ** (tries - 1), MAX_OFFLINE_RECHECK_MS)
    const retryAt = Date.now() + wait
    this.writePending(workspaceId, {
      retryAt,
      attempt: 0,
      blocked: 'offline',
      cause: 'connection'
    })
    this.arm(workspaceId, retryAt)
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
        cause: 'rateLimit',
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
    this.offlineRetries.delete(workspaceId)
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
    this.offlineRetries.clear()
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
      await this.checkLiftedEarly(workspaceId, before)
      return
    }

    // 네트워크가 없으면 아무것도 보내지 않는다 — 사용량 조회도 턴도 실패할 뿐이고, 그 실패가
    // 시도 예산을 태워 "연결이 돌아왔을 땐 이미 포기한 뒤" 가 된다. 예약은 그대로 두고 기다린다.
    if (this.deps.isOnline && !this.deps.isOnline()) {
      this.holdOffline(workspaceId)
      return
    }
    // 연결이 끊겨 기다리던 예약은 **보내기 전에 닿는지부터 확인한다.** 사용량 조회는 대화를
    // 건드리지 않으므로, 아직 못 닿는 동안 이어가기 지시가 트랜스크립트에 계속 쌓이는 것을 막는다
    // (사용량 제한과 달리 여기서는 시도 횟수를 세지 않아, 그대로 두면 몇 시간이고 쌓인다).
    if (causeOf(before.pendingRateLimitResume!) === 'connection') {
      await this.probeConnection(workspaceId)
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

  /**
   * 예약 시각이 아직 오지 않았다 — 다시 재우기 전에 **정말 아직 제한 중인지** 한 번 확인한다.
   *
   * 우리가 아는 해제 시각은 틀릴 수 있다. 5시간 창이 막 굴러간 직후의 usage 응답이 그렇다 —
   * 사용률은 옛 창의 100% 를 잠시 물고 있으면서 resetsAt 은 **새 창의 것**을 싣는다. 그 둘을 그대로
   * 믿으면 십 분 뒤면 풀릴 제한을 다섯 시간 뒤로 예약하고, 그 사이 제한이 풀려도 아무 일도 일어나지
   * 않는다. 실제로 그렇게 됐다 — 예약 하나가 22:50 으로 밀리면 18:10 에 풀린 제한을 사용자가
   * 돌아와 손으로 이어가는 수밖에 없다.
   *
   * 그래서 기다리는 동안에도 사용량을 다시 보고, 스냅샷이 **적극적으로** "제한이 아니다" 라고 말하면
   * 예약 시각을 앞당겨 곧바로 이어간다. 모르겠다는 대답(조회 실패·창 없음·available=false)은 근거로
   * 쓰지 않는다 — 그때는 원래 예약대로 기다린다. 이 판정은 예약 시각에 쓰는 것과 같은 것이라
   * (isRateLimited), 신뢰 수준을 새로 만들지 않고 **시점만 앞당긴다.**
   *
   * 다만 **해제 시각을 안다고 믿고 기다리는 예약에만** 쓴다(rateLimited.resetsAt). 시각을 모른 채
   * 백오프로 물러선 예약에는 앞당길 근거가 없다 — 거기서는 조회가 "괜찮다" 고 말하는데도 실제 턴이
   * 제한에 걸린 것이므로, 그 조회를 근거로 다시 보내면 물러선 의미가 사라지고 시도 예산만 몇 분 만에
   * 태운다. 백오프 자체가 그 경우의 확인 절차다.
   */
  private async checkLiftedEarly(workspaceId: string, ws: Workspace): Promise<void> {
    const pending = ws.pendingRateLimitResume!
    const remaining = pending.retryAt - Date.now()
    // 곧 깨어날 예약은 그냥 기다린다. 연결 대기(cause)나 턴 실패 백오프(blocked)는 제한과 무관한
    // 이유로 물러선 것이므로, 제한이 풀렸다고 앞당길 자리가 아니다.
    const eligible =
      remaining > EARLY_CHECK_MS &&
      causeOf(pending) === 'rateLimit' &&
      !pending.blocked &&
      Boolean(ws.rateLimited?.resetsAt)
    if (!eligible || (this.deps.isOnline && !this.deps.isOnline())) {
      this.arm(workspaceId, pending.retryAt)
      return
    }
    if (Date.now() - this.earlyCheckAt >= EARLY_CHECK_MS) {
      this.earlyCheckAt = Date.now()
      await this.deps
        .refreshLimits()
        .catch((err) => log.info(`rate-limit resume: early usage check failed (${String(err)})`))
    }
    // 조회를 기다리는 사이 예약이 바뀌었을 수 있다(사용자가 보냈다·다시 걸렸다) — 다시 읽는다.
    const current = this.pendingWorkspace(workspaceId)
    if (!current) return
    const now = Date.now()
    const latest = current.pendingRateLimitResume!
    if (latest.retryAt - now <= 1_000) return this.arm(workspaceId, latest.retryAt)
    const snapshot = getStore().getState().rateLimitsByAgent?.[this.deps.backend]
    if (!limitLifted(snapshot, now)) {
      this.arm(workspaceId, latest.retryAt)
      return
    }
    log.info(
      `rate-limit resume: 예약(${new Date(latest.retryAt).toISOString()}) 보다 먼저 제한이 풀렸다 — 바로 이어간다 (${workspaceId})`
    )
    this.continueNow(workspaceId, current, latest)
  }

  /**
   * 아직 API 에 닿는지 확인하고, 닿으면 이어 보낸다.
   *
   * 확인은 사용량 조회로 한다 — 대화를 건드리지 않는 유일한 왕복이다. `fetchedAt` 이 새로
   * 찍혔다면 요청이 서버까지 갔다 온 것이므로 연결이 돌아왔다는 뜻이다. 조회가 계속 실패해도
   * PROBE_PATIENCE 를 넘기면 실제 턴으로 한 번 확인한다(조회 쪽이 고장 난 경우 대비).
   */
  private async probeConnection(workspaceId: string): Promise<void> {
    const previousFetchedAt =
      getStore().getState().rateLimitsByAgent?.[this.deps.backend]?.fetchedAt
    await this.deps.refreshLimits().catch(() => {})
    const current = this.pendingWorkspace(workspaceId)
    if (!current) return
    const snapshot = getStore().getState().rateLimitsByAgent?.[this.deps.backend]
    const reachable = Boolean(snapshot && snapshot.fetchedAt !== previousFetchedAt)
    // 카운터는 되돌리지 않는다 — PROBE_PATIENCE 번마다 한 번씩 실제 턴을 끼워 넣고, 나머지는
    // 조회로만 확인한다. 되돌리면 "처음인가" 판정(noteConnectionLost 의 안내)도 함께 무너진다.
    const tries = this.offlineRetries.get(workspaceId) ?? 0
    if (!reachable && tries % PROBE_PATIENCE !== 0) {
      this.holdConnection(workspaceId)
      return
    }
    this.setBlocked(workspaceId, null)
    this.continueNow(workspaceId, current, current.pendingRateLimitResume!)
  }

  private continueNow(
    workspaceId: string,
    current: Workspace,
    pending: NonNullable<Workspace['pendingRateLimitResume']>
  ): void {
    if (current.sessionId !== pending.sessionId) return this.cancel(workspaceId)
    const connection = causeOf(pending) === 'connection'
    // 이어 보낸 턴이 곧바로 또 걸리면 이 횟수를 물려받아 무한 재시도를 막는다(streak 주석 참고).
    this.streak.set(workspaceId, { attempt: pending.attempt + 1, at: Date.now() })
    this.continuing.set(workspaceId, connection ? 'connection' : 'rateLimit')
    this.clearPending(workspaceId)
    this.unmark(workspaceId)
    // 연결이 돌아왔는지는 보내 봐야 안다 — 그래서 "돌아왔다" 가 아니라 "다시 해 본다" 라고 쓴다.
    this.notice(
      workspaceId,
      connection
        ? 'Retrying the connection. Continuing the unfinished task…'
        : 'Usage limit reset. Continuing the unfinished task…'
    )
    this.deps.sendContinuation(
      workspaceId,
      connection ? CONNECTION_CONTINUATION : RATE_LIMIT_CONTINUATION,
      connection ? CONNECTION_CONTINUATION_LABEL : RATE_LIMIT_CONTINUATION_LABEL
    )
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
    const cause = this.continuing.get(workspaceId)
    if (!this.continuing.delete(workspaceId)) return
    if (status !== 'error') {
      // 끝까지 갔다 — 다음에 또 실패하더라도 예산과 대기 간격은 처음부터 센다.
      this.failures.delete(workspaceId)
      this.offlineRetries.delete(workspaceId)
      return
    }
    this.retryAfterFailure(workspaceId, cause ?? 'rateLimit')
  }

  /** 이어 보낸 턴이 실패했다 — 네트워크가 없으면 연결을 기다리고, 아니면 물러섰다가 다시 보낸다. */
  private retryAfterFailure(workspaceId: string, cause: 'rateLimit' | 'connection'): void {
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
      blocked: offline ? 'offline' : 'error',
      cause
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
    fields: {
      retryAt: number
      attempt: number
      blocked: 'offline' | 'error' | null
      cause?: 'rateLimit' | 'connection'
    }
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
        cause: causeOf(target.pendingRateLimitResume),
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

/**
 * 스냅샷이 "이제 제한이 아니다" 라고 **적극적으로** 말하는지.
 *
 * isRateLimited 의 반대가 아니다 — 그쪽은 "제한이라는 근거가 있는가" 를 묻고, 근거가 없으면(조회
 * 실패로 available=false, 창을 못 받아 windows 가 빈 응답) false 를 준다. 그 false 를 "풀렸다" 로
 * 읽으면 아무것도 모르는 상태에서 턴을 보내게 되므로, 여기서는 **최근에 성공한 조회**만 근거로 삼는다.
 */
export function limitLifted(snapshot: RateLimitSnapshot | undefined, now = Date.now()): boolean {
  if (!snapshot?.available || !snapshot.windows.length) return false
  // 조회에 실패하면 fetchedAt 은 그대로다(마지막 성공 시각). 낡은 스냅샷은 지금을 말해 주지 않는다.
  if (now - snapshot.fetchedAt > EARLY_CHECK_MS) return false
  return !isRateLimited(snapshot, now)
}

/** reset 시각을 모를 때 다음 확인까지 기다릴 시간. 시도마다 배로 늘려 한 시간에서 멈춘다. */
export function backoffWait(attempt: number): number {
  return Math.min(FALLBACK_WAIT_MS * 2 ** Math.max(0, attempt), MAX_FALLBACK_WAIT_MS)
}

/**
 * 제한에 걸린 것이 확실한데 100% 를 가리키는 창이 하나도 없을 때, **어느 창에 걸렸는지** 추정한다.
 *
 * 제한에 막 걸린 순간의 사용률은 늦다 — CLI 가 주는 수치는 마지막으로 **성공한** 응답이 실어 준
 * 값이고, 지금 거절당한 요청은 그 수치를 올려 주지 않았기 때문이다. 그래서 걸린 바로 그때 조회하면
 * 5시간 창이 99% 로 보이고, 몇 분 뒤에야 100% 로 올라온다. exhaustedResetTimes 만 보면 하필 예약을
 * 거는 그 순간에만 해제 시각을 모르게 되어, 네 시간 뒤에 풀릴 제한을 **5분 뒤**로 예약했다
 * (관측: 22:42 에 걸려 22:47 로 예약 → 22:47 에 다시 물어보고서야 03:20 으로 정정).
 *
 * 추정은 **사용률이 가장 높은 창**이 범인이라는 것이다. 수치가 늦을 뿐 창 사이의 순서까지 틀리지는
 * 않으므로, 5시간 창을 막 소진했으면 그쪽이, 주간 창을 소진했으면 그쪽이 골라진다.
 *
 * 다만 **거의 다 쓴 창**만 근거로 삼는다(NEAR_EXHAUSTED_UTILIZATION). 늦는 폭은 요청 한 번어치이지
 * 수십 %가 아니다 — 20% 라고 말하는 스냅샷은 늦은 것이 아니라 그냥 우리에게 아무것도 말해 주지 못하는
 * 것이고, 그때는 지금까지처럼 눈먼 백오프로 물러서는 편이 맞다.
 *
 * 틀려도 손해가 작은 쪽으로 틀린다. 너무 늦게 잡았으면 기다리는 동안의 재확인(checkLiftedEarly)이
 * 풀리자마자 앞당겨 주고, 너무 이르게 잡았으면 그 시각의 조회가 100% 를 보고 다시 물러선다
 * (resume → isRateLimited → waitLonger). 최악이라야 지금의 5분 백오프와 같은 자리로 돌아온다.
 */
export function likelyExhaustedResetAt(
  snapshot: RateLimitSnapshot | undefined,
  now: number
): number | null {
  if (!snapshot?.available) return null
  let best: { utilization: number; at: number } | null = null
  for (const window of snapshot.windows) {
    const utilization = window.utilization ?? 0
    if (utilization < NEAR_EXHAUSTED_UTILIZATION) continue
    const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(at) || at <= now) continue
    if (!best || utilization > best.utilization) best = { utilization, at }
  }
  return best?.at ?? null
}

/**
 * 우리가 아는 해제 시각 — 스냅샷의 소진된 창과 오류가 알려 준 resetAt 중 가장 늦은 것.
 *
 * 둘 다 없으면 사용률이 가장 높은 창을 범인으로 보고 그 창의 해제 시각을 쓴다
 * (likelyExhaustedResetAt). 이 함수를 부르는 자리는 모두 "제한에 걸렸다" 를 이미 아는 곳이므로
 * (schedule — 제한 오류를 받았다, resume — isRateLimited 가 참이다), 추정의 전제가 깨지지 않는다.
 * 그리고도 모르면 null(그때는 백오프로 다시 확인한다).
 */
export function knownResetAt(
  snapshot: RateLimitSnapshot | undefined,
  now: number,
  resetAt?: number
): number | null {
  const resets = exhaustedResetTimes(snapshot, now)
  if (resetAt && Number.isFinite(resetAt) && resetAt > now) resets.push(resetAt)
  if (resets.length) return Math.max(...resets)
  return likelyExhaustedResetAt(snapshot, now)
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

export function formatWhen(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}
