import { powerMonitor, powerSaveBlocker } from 'electron'
import { IPC } from '@shared/types'
import type { AppState, ChatEvent } from '@shared/types'
import { log } from './logger'

/**
 * 에이전트가 도는 동안 맥이 잠들지 않게 붙잡는다.
 *
 * Wooi 의 사용법은 긴 턴을 걸어두고 자리를 뜨는 것인데, 그 사이 맥이 잠들면 턴이 멈추고
 * 예약 재개([[main/rateLimitResume]])도 깨어나지 못한다. 그래서 "도는 동안만" 붙잡는다 —
 * 늘 붙잡으면 아무 일도 하지 않는 밤에 배터리를 태운다.
 *
 * '돌고 있음' 의 판정은 새로 만들지 않는다. 사이드바 배지와 같은 `Workspace.status ===
 * 'running'` 하나만 본다 — 두 판정이 갈리면 화면과 실제 동작이 어긋난다. rate limit 으로
 * 예약 대기 중인 워크스페이스는 그 판정에서 이미 'idle' 이므로(rateLimitResume 이 그렇게
 * 적는다) 몇 시간 뒤의 재개를 기다리며 맥을 깨워 두지는 않는다.
 */

/**
 * `prevent-display-sleep` 이 아니라 `prevent-app-suspension` 을 쓴다. 우리가 필요한 것은
 * 시스템이 계속 도는 것뿐이고, 화면까지 켜 두면 자리를 뜬 사용자의 맥이 밤새 밝아 있게 된다.
 */
const BLOCKER_TYPE = 'prevent-app-suspension'

/**
 * 이 시간 동안 아무 신호도 없는 'running' 은 굳은 것으로 보고 놓아준다.
 *
 * 상태 이벤트만 믿으면 위험하다 — 어떤 경로로든 'idle' 전이를 한 번 놓치면 그 워크스페이스는
 * 영원히 도는 것으로 남고, 맥은 영원히 잠들지 못한다. 살아 있는 턴은 도구 로그·델타를 계속
 * 흘리므로, 워크스페이스가 마지막으로 무엇이든 말한 시각을 갱신해 두고 그것으로 판단한다.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000

/** 마지막으로 신호를 준 시각(ms). 'running' 으로 관측된 워크스페이스만 들어 있다. */
const lastSeen = new Map<string, number>()

let enabled = false
let blockerId: number | null = null
let staleTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeResume: (() => void) | null = null

/** 앱 기동 시 한 번. 잠에서 깬 직후에는 우리가 붙잡은 것이 살아 있는지 알 수 없으므로 다시 맞춘다. */
export function initSleepBlocker(initialEnabled: boolean): void {
  enabled = initialEnabled
  if (!unsubscribeResume) {
    const onResume = (): void => refreshSleepBlocker('power-resume')
    powerMonitor.on('resume', onResume)
    unsubscribeResume = () => powerMonitor.off('resume', onResume)
  }
  refreshSleepBlocker('init')
}

/** 설정 토글. 끄면 즉시 놓아준다. */
export function setSleepBlockerEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  refreshSleepBlocker('settings-change')
}

/**
 * 렌더러로 나가는 방송이 지나가는 길에 '돌고 있음' 을 읽는다([[main/runningAgentsCache]] 와 같은 수법).
 *
 * 두 채널을 모두 본다. `evt:chat` 은 전이를 즉시 알려 주고, `evt:state` 는 상태 파일의 진실
 * 전체를 실어 오므로 아카이브·세션 정리처럼 상태 이벤트 없이 'idle' 이 되는 경로까지 맞춘다.
 * 채팅 델타는 초당 수십 개가 지나가므로 이 경로는 Map 쓰기 하나로 끝나야 한다.
 */
export function noteSleepBlockerEvent(channel: string, payload: unknown): void {
  try {
    if (channel === IPC.evtChat) noteChat(payload)
    else if (channel === IPC.evtState) reconcile(payload as AppState)
  } catch (err) {
    // 여기서 던지면 방송 자체가 끊긴다 — 수면 방지는 부가 기능이므로 삼킨다.
    log.error('sleepBlocker: failed to read broadcast', err)
  }
}

function noteChat(payload: unknown): void {
  const message = payload as { workspaceId?: string; event?: ChatEvent }
  const workspaceId = message?.workspaceId
  const event = message?.event
  if (typeof workspaceId !== 'string' || event === undefined) return
  if (event.type === 'status') {
    if (event.status === 'running') lastSeen.set(workspaceId, Date.now())
    else lastSeen.delete(workspaceId)
    refreshSleepBlocker('status-change')
    return
  }
  // 도는 중인 워크스페이스가 낸 소리 — 살아 있다는 증거이므로 시각만 갱신한다(재평가 불필요).
  if (lastSeen.has(workspaceId)) lastSeen.set(workspaceId, Date.now())
}

function reconcile(state: AppState): void {
  const workspaces = state?.workspaces
  if (!Array.isArray(workspaces)) return
  const now = Date.now()
  const running = new Set<string>()
  for (const w of workspaces) {
    if (w.archived || w.status !== 'running') continue
    running.add(w.id)
    // 이미 알고 있던 워크스페이스의 시각은 유지한다 — 여기서 갱신하면 stale 방어가 무력해진다.
    if (!lastSeen.has(w.id)) lastSeen.set(w.id, now)
  }
  for (const id of lastSeen.keys()) if (!running.has(id)) lastSeen.delete(id)
  refreshSleepBlocker('state-broadcast')
}

/** 지금 붙잡아야 하는지 다시 계산하고, 굳은 항목을 놓아준다. */
export function refreshSleepBlocker(reason: string): void {
  const now = Date.now()
  for (const [id, seen] of lastSeen) {
    if (now - seen <= STALE_AFTER_MS) continue
    lastSeen.delete(id)
    log.warn(`sleepBlocker: releasing stale workspace ${id} (no signal for ${STALE_AFTER_MS}ms)`)
  }
  if (enabled && lastSeen.size > 0) start(reason)
  else stop(reason)
  scheduleStaleCheck(now)
}

function start(reason: string): void {
  // 이미 시작한 블로커가 살아 있으면 그대로 둔다. 죽어 있으면(외부 요인) 다시 잡는다.
  if (blockerId !== null && isStarted(blockerId)) return
  try {
    blockerId = powerSaveBlocker.start(BLOCKER_TYPE)
    log.info(`sleepBlocker: holding system awake (${reason}, ${lastSeen.size} running)`)
  } catch (err) {
    blockerId = null
    log.error(`sleepBlocker: failed to start (${reason})`, err)
  }
}

function stop(reason: string): void {
  if (blockerId === null) return
  const id = blockerId
  blockerId = null
  try {
    if (isStarted(id)) powerSaveBlocker.stop(id)
    log.info(`sleepBlocker: releasing system (${reason})`)
  } catch (err) {
    log.error(`sleepBlocker: failed to stop (${reason})`, err)
  }
}

function isStarted(id: number): boolean {
  try {
    return powerSaveBlocker.isStarted(id)
  } catch {
    // 알 수 없으면 살아 있다고 본다 — stop 을 한 번 더 시도하는 편이 영원히 붙잡는 것보다 낫다.
    return true
  }
}

/**
 * 가장 이른 만료 시각에 한 번 깨어나 다시 판단한다.
 *
 * 이 타이머는 마지막 방어선일 뿐이다 — 정상 경로에서는 상태·상태방송 이벤트가 훨씬 먼저
 * 재평가를 부른다. 절전이 길게 걸려 타이머가 밀려도 벽시계로 다시 재므로 판단은 어긋나지 않는다.
 */
function scheduleStaleCheck(now: number): void {
  if (staleTimer) {
    clearTimeout(staleTimer)
    staleTimer = null
  }
  let earliest: number | null = null
  for (const seen of lastSeen.values()) {
    const expiry = seen + STALE_AFTER_MS
    earliest = earliest === null ? expiry : Math.min(earliest, expiry)
  }
  if (earliest === null) return
  staleTimer = setTimeout(
    () => {
      staleTimer = null
      refreshSleepBlocker('stale-check')
    },
    Math.max(0, earliest - now)
  )
  staleTimer.unref?.()
}

export function disposeSleepBlocker(): void {
  if (staleTimer) {
    clearTimeout(staleTimer)
    staleTimer = null
  }
  unsubscribeResume?.()
  unsubscribeResume = null
  lastSeen.clear()
  stop('dispose')
}
