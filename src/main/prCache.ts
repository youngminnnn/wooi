import type { PrStatus, Workspace } from '@shared/types'
import { findOpenPrStatus, getPrStatus, isGithubConnected } from './github'

/**
 * 워크스페이스별 PR 상태 조회에서 `gh` 프로세스를 걷어내는 얇은 층.
 *
 * `pr:status` IPC 는 앱 시작 시 전체 워크스페이스에 대해 한꺼번에(store.ts), 턴이 끝날 때마다,
 * 워크스페이스를 고를 때마다 들어온다. 예전에는 그때마다 곧장 `gh pr view` 를 띄웠으므로
 * (1건당 ~0.6초, 로그인 셸 + 네트워크 왕복) 워크스페이스가 10개를 넘으면 시작 직후 그만큼의
 * 셸이 동시에 뜨면서 CPU 가 튀고 메인이 붙잡혔다.
 *
 * 이제 대부분은 리포 단위로 캐시되는 열린 PR 목록([[github]] 의 openPrsCache)에서 답한다.
 * 여기 남는 일은 그 목록이 못 덮는 경우, 즉 **병합·닫힘 PR** 뿐이다:
 * - 종결 상태는 다시 바뀌지 않으므로 브랜치가 그대로인 한 영구 캐시한다.
 * - "PR 없음"도 한동안 캐시한다 — 앱 안에서 PR 을 만들면 어차피 invalidate 된다.
 * - 그래도 남는 개별 조회는 동시 실행 수를 묶어, 전체 훑기가 다시 폭주하지 않게 한다.
 */

/** 배치에 없어 개별 조회로 확인한 "PR 없음"을 다시 확인하기까지의 간격. */
const NO_PR_TTL_MS = 10 * 60_000

/** 한 번에 띄울 개별 폴백 조회 수. */
const FALLBACK_CONCURRENCY = 2

interface Entry {
  /** 개별 조회로 확인한 값. 종결(merged/closed) 이거나 null(PR 없음) 이다. */
  status: PrStatus | null
  at: number
  /** 이 값을 얻었을 때의 브랜치. 브랜치가 바뀌면 무효다. */
  branch: string
}

const fallbackCache = new Map<string, Entry>()

/** 병합·닫힘은 종결 상태다 — 한 번 확인하면 브랜치가 바뀌기 전까지 답이 같다. */
function isTerminal(status: PrStatus | null): boolean {
  return status?.state === 'merged' || status?.state === 'closed'
}

function isFresh(entry: Entry, branch: string, now: number): boolean {
  if (entry.branch !== branch) return false
  return isTerminal(entry.status) || now - entry.at < NO_PR_TTL_MS
}

// 동시에 도는 개별 폴백 수를 제한하기 위한 아주 작은 세마포어.
//
// 자리는 **넘겨준다** — 놓는 쪽이 active 를 줄이지 않고 대기자를 깨운다. 예전에는 대기자가
// 깨어난 뒤에 스스로 active++ 했는데, 그러면 "자리를 줄인 순간 ~ 대기자가 깨어나기 전" 이라는
// 창이 열린다. 그 사이에 도착한 호출은 줄어든 active 를 보고 그냥 통과하므로, 깨어난 대기자와
// 합쳐 상한 + 1 이 동시에 돈다(마이크로태스크 단위로 재현된다).
//
// 지금은 유일한 호출부가 withSlot 앞에서 findOpenPrStatus 를 await 하는 덕에 그 창을 지나쳐
// 도착해 실제로 새지는 않았다 — 즉 **호출부의 우연에 기대고 있었다.** 상한을 두는 이유가 전체
// 훑기에서 로그인 셸이 한꺼번에 뜨는 것을 막기 위한 것이라, 그 보장은 여기서 지는 편이 맞다.
let active = 0
const queue: (() => void)[] = []

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active < FALLBACK_CONCURRENCY) active++
  else await new Promise<void>((resolve) => queue.push(resolve))
  try {
    return await run()
  } finally {
    const next = queue.shift()
    // 대기자가 있으면 내 자리를 그대로 물려준다(active 는 그대로).
    if (next) next()
    else active--
  }
}

/**
 * 워크스페이스 현재 브랜치의 PR 상태. 열린 PR 이면 리포 배치에서 곧바로 답하고, 아니면
 * (병합·닫힘·없음) 캐시를 보고, 그래도 모를 때만 그 워크스페이스 하나를 개별 조회한다.
 */
export async function getWorkspacePrStatus(
  workspace: Workspace,
  branch: string
): Promise<PrStatus | null> {
  if (!branch) return null

  const open = await findOpenPrStatus(workspace.worktreePath, workspace.repoId, branch).catch(
    () => null
  )
  if (open) {
    // 열린 PR 을 찾았다면 예전에 기록해 둔 종결 상태는 낡은 것이다(브랜치를 재사용해 PR 을 다시
    // 열었을 수 있다). 다음 조회가 배치를 믿도록 버린다.
    fallbackCache.delete(workspace.id)
    return open
  }

  const cached = fallbackCache.get(workspace.id)
  if (cached && isFresh(cached, branch, Date.now())) return cached.status

  const status = await withSlot(() => getPrStatus(workspace.worktreePath, branch).catch(() => null))
  // gh 가 미연결이면 조회 자체가 없었던 것이라 "PR 없음"이 아니다. 이걸 캐시하면 사용자가 gh 를
  // 연결한 뒤에도 한동안 PR 칩이 비어 있게 된다 — 연결 직후 전체 갱신이 이 캐시에 막히기 때문이다.
  if (status !== null || isGithubConnected()) {
    fallbackCache.set(workspace.id, { status, at: Date.now(), branch })
  }
  return status
}

/**
 * 폴백 캐시를 버린다. PR 을 만들거나 닫는 등 앱 안에서 상태를 바꾼 직후에 부른다
 * (열린 PR 목록 자체는 [[github]] 의 invalidateOpenPrs 가 맡는다).
 */
export function invalidateWorkspacePr(workspaceId?: string): void {
  if (workspaceId === undefined) fallbackCache.clear()
  else fallbackCache.delete(workspaceId)
}
