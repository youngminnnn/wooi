import type { UsageTotals, WorkspaceUsageInfo } from '@shared/types'

/**
 * 워크스페이스별 토큰 장부.
 *
 * **왜 필요한가.** 터미널 `claude` 대비 Wooi 가 토큰을 어디서 더 쓰는지 볼 방법이 없었다. 계정
 * 단위 `/usage` 는 "이번 5시간 창에서 얼마나 썼나" 만 알려 주고, 워크스페이스 하나가 세션 재시작
 * 으로 맥락을 몇 번 다시 읽었는지는 어디에도 안 나온다. 고친 것의 효과를 재려면 먼저 재는 자가
 * 있어야 한다.
 *
 * **어디에 사는가.** contextUsageCache 와 같은 수법이다 — AppState 에 넣지 않고 main 의 휘발성
 * 맵에 적어 둔다. 턴마다 바뀌는 값이라 디스크에 영속할 이유가 없고, 앱을 껐다 켜면 0부터 다시
 * 세는 것이 맞다(장부의 단위는 "이번 앱 실행"이다). 호스트가 아니라 main 이 들고 있는 것이
 * 중요하다 — 세션이 다시 열려도, 호스트 프로세스가 죽어도 장부는 살아남아야 한다.
 *
 * **누계를 어떻게 다루는가.** SDK 의 `modelUsage`·`total_cost_usd` 는 query 하나에 대한 **누계**
 * 다. 그래서 result 들을 더하면 안 되고 마지막 것을 읽어야 한다. 대신 세션이 다시 열리면 그
 * 누계가 0에서 다시 시작하므로, 워크스페이스 단위 총계를 만들려면 구간이 바뀌는 지점을 알아채
 * 이전 구간을 확정하고 더해야 한다.
 *
 * 그 지점을 **숫자로 추측하지 않는다.** "누계가 줄었으면 새 세션" 은 틀린다 — 짧게 끝난 세션
 * 다음에 열린 세션의 첫 턴은 대화를 통째로 다시 읽느라 이전 세션의 총계보다 클 수 있다. 대신
 * 세션이 query 를 열 때마다 발급하는 `runId` 를 그대로 받아 쓴다. 세션 자신이 아는 사실을
 * 추론으로 되돌릴 이유가 없고, **runId 가 바뀐 횟수가 곧 세션 재시작 횟수**다 — 세는 데 드는
 * 추가 비용이 0이라 함께 노출한다.
 */

const ZERO: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0
}

interface Entry {
  /** 이미 끝난 세션 구간들의 합. 구간이 바뀔 때마다 segment 가 여기로 넘어온다. */
  committed: UsageTotals
  /** 지금 도는 세션이 마지막으로 보고한 누계. */
  segment: UsageTotals
  /** 그 누계를 싣고 온 query 의 id. 이게 바뀌면 세션이 다시 열린 것이다. */
  runId: string | null
  /** 위임 서브런(별도 query)의 합. 한 번 끝나면 끝이라 누계 추적이 필요 없다. */
  delegated: UsageTotals
  restarts: number
}

const ledger = new Map<string, Entry>()

/**
 * 워크스페이스에 달 수 없는 실행의 앱 전체 누계.
 *
 * 코드 리뷰는 워크스페이스가 아니라 PR 에 매여 있어(ReviewRunDeps 에 workspaceId 가 없다) 어느
 * 한 워크스페이스의 장부에 넣으면 거짓말이 된다. 그렇다고 빼면 Wooi 고유 비용만 장부에서 빠지
 * 므로, 별도 칸에 모아 두고 카드에서 따로 보여 준다.
 */
let reviews: UsageTotals = ZERO

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd
  }
}

/** 토큰 총량. 0 인 스냅샷을 가려내고, 세션 중 `/clear` 로 누계가 되돌아간 것을 알아채는 데 쓴다. */
function tokens(u: UsageTotals): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
}

function entryOf(workspaceId: string): Entry {
  const existing = ledger.get(workspaceId)
  if (existing) return existing
  const fresh: Entry = {
    committed: ZERO,
    segment: ZERO,
    runId: null,
    delegated: ZERO,
    restarts: 0
  }
  ledger.set(workspaceId, fresh)
  return fresh
}

/**
 * 라이브 세션이 보고한 **누계** 스냅샷을 반영한다(result 하나당 한 번).
 *
 * `runId` 는 그 누계를 싣고 온 query 의 id다. 바뀌었으면 세션이 다시 열린 것이므로 이전 구간을
 * 확정해 더하고 재시작을 하나 센다. 처음 보는 워크스페이스의 첫 구간은 재시작이 아니다.
 *
 * 같은 runId 인데 누계가 줄어드는 경우도 있다 — 세션 중 `/clear` 는 query 를 그대로 둔 채 누계만
 * 되돌린다. 그때도 이전 구간을 확정해 토큰을 잃지 않게 하되, **재시작으로 세지는 않는다**:
 * 사용자가 맥락을 비운 것이지 우리가 세션을 버린 게 아니다.
 *
 * 통째로 0인 스냅샷은 무시한다. 크래시·기동 오류 result 가 0을 실어 오는데, 그대로 반영하면
 * 지금 구간에 쌓아 둔 값이 0으로 덮인다.
 */
export function recordSessionUsage(
  workspaceId: string,
  runId: string,
  snapshot: UsageTotals
): void {
  if (tokens(snapshot) === 0 && snapshot.costUsd === 0) return
  const entry = entryOf(workspaceId)
  if (entry.runId === null) {
    entry.runId = runId
  } else if (entry.runId !== runId) {
    entry.committed = add(entry.committed, entry.segment)
    entry.runId = runId
    entry.restarts += 1
  } else if (tokens(snapshot) < tokens(entry.segment)) {
    entry.committed = add(entry.committed, entry.segment)
  }
  entry.segment = snapshot
}

/**
 * 위임 서브런 1회분을 이 워크스페이스 앞으로 단다.
 *
 * 서브런은 부모와 **별도 query** 라 부모 result 의 modelUsage 에 절대 나타나지 않는다(터미널
 * Claude Code 의 네이티브 Task 서브에이전트와 다른 점이다 — 그쪽은 부모 회계에 포함된다).
 * 여기서 세지 않으면 정작 Wooi 고유 비용만 장부에서 빠진다.
 */
export function recordDelegatedUsage(workspaceId: string, totals: UsageTotals): void {
  const entry = entryOf(workspaceId)
  entry.delegated = add(entry.delegated, totals)
}

/** 코드 리뷰 실행 1회분을 앱 전체 칸에 더한다(위 `reviews` 주석 참고). */
export function recordReviewUsage(totals: UsageTotals): void {
  reviews = add(reviews, totals)
}

/** 아직 한 턴도 돌지 않았으면 undefined — 카드가 빈 0 을 보여 주지 않도록 구분한다. */
export function getWorkspaceUsage(workspaceId: string): WorkspaceUsageInfo | undefined {
  const entry = ledger.get(workspaceId)
  if (!entry && tokens(reviews) === 0) return undefined
  const base = entry ?? { committed: ZERO, segment: ZERO, delegated: ZERO, restarts: 0 }
  return {
    total: add(add(base.committed, base.segment), base.delegated),
    delegated: base.delegated,
    reviews,
    sessionRestarts: base.restarts
  }
}

/**
 * 맥락이 처음부터 다시 시작할 때 지운다(`/clear`·에이전트 교체). 장부의 단위는 "지금 이 대화"
 * 이므로, 대화를 비웠는데 옛 대화의 토큰이 남아 있으면 읽는 사람을 속인다. 재시작 카운트도 함께
 * 0이 되는 것이 맞다 — 곧 이어질 누계 리셋은 사용자가 시킨 것이지 우리가 세션을 버린 게 아니다.
 */
export function forgetWorkspaceUsage(workspaceId: string): void {
  ledger.delete(workspaceId)
}

/** 테스트 전용 — 모듈 수준 상태를 초기 상태로 되돌린다. */
export function resetUsageLedgerForTests(): void {
  ledger.clear()
  reviews = ZERO
}
