import { useMemo, useSyncExternalStore } from 'react'
import type { AgentBackendId, Workspace } from '@shared/types'

/**
 * 프롬프트 캐시가 식기까지 남은 시간.
 *
 * 왜 보여 주는가: 지금 답하면 직전 턴의 프롬프트가 캐시 값으로 재사용되고, 캐시가 만료된 뒤에
 * 답하면 같은 대화를 제값 주고 다시 넣는다. 사용량 숫자를 보여 주는 것과 달리 이 표시는
 * **행동을 바꾼다** — "이 세션 먼저 처리하고 저건 나중에" 같은 판단의 근거가 된다.
 *
 * ⚠️ TTL 은 사용자가 고를 값이 **아니다**. Wooi 는 백엔드의 모델·effort·권한·rate limit 을
 * 이미 백엔드가 아는 값 그대로 노출하는 제품이고, 캐시 수명도 같은 부류다. 설정으로 만들면
 * 사용자에게 "당신 백엔드가 몇 분짜리 캐시를 쓰는지 알아맞혀 보라" 고 묻는 셈이 된다.
 */

/**
 * 백엔드별 프롬프트 캐시 수명(ms).
 *
 * **레포는 이 값을 모른다.** 조사해 보면 Wooi 가 캐시에 대해 아는 것은 *토큰 수*뿐이고
 * (`usageLedger.cacheReadTokens` / `cacheCreationTokens`, `claude/resultUsage.ts`), 수명은
 * 어디에도 없다 — 백엔드 CLI 가 자기 요청에 붙이는 값이라 Wooi 를 거쳐 오지 않는다.
 * 그래서 상수로 두되, 출처와 고른 이유를 여기 남긴다.
 *
 * - **claude** — Anthropic prompt caching 의 `cache_control: {type: 'ephemeral'}` 기본 TTL 이
 *   5분이다(`ttl: '1h'` 는 명시적으로 요청해야 하는 옵션이며, 쓰기 비용이 1.25× → 2× 로 오른다).
 * - **codex** — OpenAI 의 프롬프트 캐시는 비활성 상태가 5~10분 이어지면 만료된다고 문서화돼 있다.
 *
 * 둘 다 **짧은 쪽(5분)** 을 택했다. 실제가 더 길 때 5분을 보여 주면 배지가 일찍 사라질 뿐이지만,
 * 실제가 5분인데 1시간을 약속하면 "아직 캐시가 살아 있다" 는 거짓말을 하게 된다 — 이 표시의
 * 목적이 행동 유도인 이상 틀린 방향으로 유도하는 쪽이 훨씬 나쁘다.
 */
const TTL_MS: Record<AgentBackendId, number> = {
  claude: 5 * 60_000,
  codex: 5 * 60_000
}

/**
 * 이 워크스페이스의 캐시가 식는 시각(epoch ms). 표시할 것이 없으면 null.
 *
 * 기준점은 `lastActiveAt` 이다 — 턴이 끝나는 순간 main 이 찍는 값이라(claude/codex manager)
 * "마지막으로 모델에 요청이 나간 시각" 에 가장 가깝다. 그리고 이 값은 이미 렌더러까지 와 있어
 * main 에 폴링을 새로 만들지 않아도 된다(카운트다운의 토큰 비용은 0이어야 한다).
 */
export function promptCacheExpiresAt(workspace: Workspace): number | null {
  // 세션이 아직 없으면 캐시에 들어간 프롬프트도 없다. 갓 만든 워크스페이스는 `lastActiveAt` 이
  // 생성 시각이라(workspaces.ts) 이 가드가 없으면 대화 한 번 없이 타이머가 뜬다.
  if (!workspace.sessionId) return null
  // 도는 중에는 요청이 계속 나가며 캐시가 새로 쓰이는 중이다 — 그때의 카운트다운은 셀 것이
  // 정해지지 않은 숫자라 거짓말이 된다. 멈춰 있을 때만, 즉 결정이 필요한 때만 보여 준다.
  if (workspace.status === 'running') return null
  return workspace.lastActiveAt + TTL_MS[workspace.agentBackend]
}

/** `4:07` 꼴. 5분짜리 창을 분 단위로만 보여 주면 "1분 미만" 에 절반이 몰려 쓸모가 없다. */
export function formatCacheRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── 공용 1초 시계 ─────────────────────────────────────────────────────────
//
// 카드마다 setInterval 을 돌리면 워크스페이스 20개에 타이머 20개가 각각 다른 위상으로 뛴다.
// 여기 하나만 돌리고 구독자 전원을 같은 틱에 깨운다.
//
// 구독자는 자기 만료 시각을 함께 등록한다. 살아 있는 시한이 하나도 남지 않으면 시계는 멈춘다 —
// 유휴 워크스페이스 카드가 화면에 잔뜩 떠 있어도, 셀 것이 없으면 초당 리렌더가 돌지 않는다.
// (만료 판정을 시계가 맡아 준 덕에 컴포넌트 쪽에는 setState 도 effect 도 필요 없다.)
//
// `useNow` 를 쓰지 않는 이유: 그건 컴포넌트마다 자기 인터벌을 만드는 훅이고, 사이드바·현황판이
// 이미 쓰는 인스턴스는 "도는 세션이 있을 때만" 켜지도록 게이트돼 있다. 캐시 타이머가 필요한
// 시점은 정확히 그 반대(아무것도 안 도는 유휴 상태)라 그 시계를 빌려 쓸 수 없다.

type Listener = () => void

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
/** 구독자 → 그 구독자가 기다리는 만료 시각. 등록부이자 리스너 목록이다. */
const deadlines = new Map<Listener, number>()

function anyLive(): boolean {
  for (const at of deadlines.values()) if (at > now) return true
  return false
}

function stop(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function tick(): void {
  now = Date.now()
  for (const listener of deadlines.keys()) listener()
  // 마지막 시한까지 지났다. 한 번 더 알린 뒤(그 렌더에서 표시가 지워진다) 시계를 멈춘다.
  if (!anyLive()) stop()
}

function getSnapshot(): number {
  return now
}

// 셀 것이 없는 카드는 아예 구독하지 않는다(훅은 조건부로 못 부르므로 빈 스토어로 갈아 끼운다).
const subscribeIdle = (): (() => void) => () => {}
const getIdleSnapshot = (): number => 0

function subscribeUntil(expiresAt: number) {
  return (listener: Listener): (() => void) => {
    // 오래 유휴였다가 카드가 막 붙었으면 모듈 로드 시각이 한참 전이다 — 첫 1초를 낡은 값으로
    // 그리지 않도록 즉시 한 번 맞춘다.
    now = Date.now()
    deadlines.set(listener, expiresAt)
    if (timer === null && anyLive()) timer = setInterval(tick, 1000)
    return () => {
      deadlines.delete(listener)
      if (deadlines.size === 0) stop()
    }
  }
}

/**
 * 모든 캐시 타이머가 공유하는 현재 시각(epoch ms).
 * @param expiresAt 이 구독자가 기다리는 만료 시각. null 이면 구독하지 않는다.
 */
export function usePromptCacheNow(expiresAt: number | null): number {
  const subscribe = useMemo(
    () => (expiresAt === null ? subscribeIdle : subscribeUntil(expiresAt)),
    [expiresAt]
  )
  return useSyncExternalStore(
    subscribe,
    expiresAt === null ? getIdleSnapshot : getSnapshot,
    expiresAt === null ? getIdleSnapshot : getSnapshot
  )
}
