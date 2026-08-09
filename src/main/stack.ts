import type { ArchiveSuggestion, BaseMismatch, StackedBranch } from '@shared/types'

/** 열린 PR 의 head/base 브랜치 쌍(스택 감지 입력). */
export interface PrEdge {
  number: number
  head: string
  base: string
}

/**
 * 열린 PR 목록에서, anchor 브랜치가 속한 stacked PR 체인(worktree 내부 브랜치 스택)을 복원한다.
 * PR 의 base 링크(base→head)를 따라 연결 요소를 모으되, exclude(다른 워크스페이스가 소유한 브랜치)는
 * 경계로 취급해 모델 A 스택을 모델 B 로 흡수하지 않게 한다. 노드가 2개 미만이면 스택이 아니므로 null.
 * 반환은 base 가 먼저 오도록 위상 정렬된 엔트리 목록(아래→위).
 */
export function buildStackFromPrs(
  anchor: string,
  prs: PrEdge[],
  exclude: Set<string>
): StackedBranch[] | null {
  const byHead = new Map<string, PrEdge>()
  for (const p of prs) if (!exclude.has(p.head)) byHead.set(p.head, p)
  if (!byHead.has(anchor)) return null

  const inSet = new Set<string>([anchor])
  const queue = [anchor]
  while (queue.length) {
    const b = queue.shift()!
    // 아래로: 이 PR 의 base 가 또 다른 PR head 면 스택 링크.
    const base = byHead.get(b)?.base
    if (base && byHead.has(base) && !inSet.has(base)) {
      inSet.add(base)
      queue.push(base)
    }
    // 위로: base 가 이 브랜치인 PR 들.
    for (const p of byHead.values()) {
      if (p.base === b && !inSet.has(p.head)) {
        inSet.add(p.head)
        queue.push(p.head)
      }
    }
  }
  if (inSet.size < 2) return null

  const entries: StackedBranch[] = [...inSet].map((h) => {
    const p = byHead.get(h)!
    return { branch: p.head, baseBranch: p.base, prNumber: p.number }
  })
  // 위상 정렬: base 가 스택 밖(기본 브랜치 등)이거나 이미 배치된 엔트리를 먼저 놓는다.
  const branches = new Set(entries.map((e) => e.branch))
  const placed = new Set<string>()
  const out: StackedBranch[] = []
  const remaining = [...entries]
  while (remaining.length) {
    const idx = remaining.findIndex((e) => !branches.has(e.baseBranch) || placed.has(e.baseBranch))
    if (idx < 0) {
      out.push(...remaining) // 순환 방어
      break
    }
    const [e] = remaining.splice(idx, 1)
    out.push(e)
    placed.add(e.branch)
  }
  return out
}

/**
 * 현재 브랜치의 PR base 가 스택 관계와 어긋났는지 판정한다([[types]] BaseMismatch).
 * 어긋나지 않았거나 판단할 근거가 없으면 null(= 호출부는 PR 의 base 를 그대로 채택한다).
 *
 * 판단 근거를 좁게 잡는다 — 잘못 띄운 배너는 사용자가 매번 무시해야 하는 소음이 된다:
 * - 부모 워크스페이스를 특정할 수 없으면(스택이 아니거나 부모가 아카이브됨) 판정하지 않는다.
 * - 부모 병합으로 이미 캐스케이드 계획이 떠 있으면 판정하지 않는다 — 그때는 자식 PR 이
 *   조부모를 향하는 게 정상이고, 배너도 그쪽(StackSyncBanner)이 이미 떠 있다.
 * - 사용자가 "그대로 둔다"고 한 base 는 다시 묻지 않는다.
 */
export function detectBaseMismatch(opts: {
  /** 현재 브랜치의 열린 PR. 없으면(PR 미생성) 판정할 대상 자체가 없다. */
  headPr: { number: number; base: string } | null
  /** 부모 워크스페이스의 브랜치. 스택이 아니거나 부모를 못 찾으면 null. */
  parentBranch: string | null
  /** 대기 중인 머지 캐스케이드 계획이 있는지. */
  pendingSync: boolean
  /** 사용자가 그대로 두기로 한 base 브랜치. */
  dismissed: string | null
}): BaseMismatch | null {
  const { headPr, parentBranch, pendingSync, dismissed } = opts
  if (!headPr || !parentBranch || pendingSync) return null
  if (headPr.base === parentBranch || headPr.base === dismissed) return null
  return { prNumber: headPr.number, prBase: headPr.base, expectedBase: parentBranch }
}

/**
 * PR 이 병합돼 워크스페이스를 정리해도 되는 상태인지 판정한다([[types]] ArchiveSuggestion).
 *
 * 조건을 좁게 잡는 이유는 이 배너를 누른 결과가 **파괴적**이기 때문이다 — 아카이브는 worktree 를
 * `git worktree remove --force` 로 지운다. 잘못 띄운 제안 하나가 남의 작업을 통째로 날린다:
 *
 * - worktree 안에 브랜치 스택을 들고 있으면(모델 B) 띄우지 않는다. 그 안의 PR 하나가 병합돼도
 *   위에 남은 브랜치들은 계속 살아 있어서, 아카이브하면 나머지 작업이 함께 사라진다. 캐스케이드가
 *   병합된 엔트리를 스택에서 빼 스택이 소진되면 그때 자연히 이 조건을 만족한다.
 * - 살아 있는 자식 워크스페이스가 있으면 띄우지 않는다. 모델 A 로 PR 을 여러 개 다루는 중이라는
 *   뜻이기도 하지만, 더 나쁜 이유가 있다 — 재동기화는 `archived` 면 즉시 return 하므로, 자식이
 *   남은 부모를 아카이브하면 자식들의 캐스케이드 감지가 영영 돌지 않아 조용히 유실된다.
 * - 대기 중인 캐스케이드가 있으면 그쪽이 먼저다. 사용자가 그걸 처리해야 스택이 정리된다.
 * - 사용자가 해제한 병합은 다시 묻지 않는다.
 *
 * 병합 조회(gh)를 thunk 로 받는 이유: 이 판정은 PR 상태 갱신마다 도는데, 위 조건이 이미 어긋난
 * 워크스페이스에서까지 매번 gh 를 띄우면 안 된다. 조건을 전부 통과했을 때만 호출된다.
 */
export async function detectArchiveSuggestion(opts: {
  /** 워크스페이스의 현재 브랜치(=제안이 걸리는 대상). */
  branch: string
  /** 이미 떠 있는 제안. 같은 브랜치의 제안이면 그대로 유지하고 재조회하지 않는다. */
  existing: ArchiveSuggestion | null | undefined
  /** worktree 안에 브랜치 스택(모델 B)을 보유하는지 — `isBranchStack(ws)`. */
  branchStack: boolean
  /** 아카이브되지 않은 자식 워크스페이스가 있는지. */
  hasLiveChildren: boolean
  /** 대기 중인 머지 캐스케이드 계획(stackSync)이 있는지. */
  pendingSync: boolean
  /** 사용자가 해제한 병합 브랜치. */
  dismissed: string | null | undefined
  /** 이 브랜치의 PR 이 병합됐으면 그 PR, 아니면 null. */
  lookupMerged: () => Promise<{ number: number | null } | null>
  now: number
}): Promise<ArchiveSuggestion | null> {
  const { branch, existing, branchStack, hasLiveChildren, pendingSync, dismissed } = opts
  // 차단 조건을 먼저 본다 — 제안이 떠 있는 동안 자식이 생기거나 캐스케이드가 잡히면 거둬야 한다.
  if (branchStack || hasLiveChildren || pendingSync) return null
  if (branch === dismissed) return null
  // 브랜치가 그대로면 이미 뜬 제안을 그대로 쓴다(에이전트가 브랜치를 옮겼으면 다시 판정한다).
  if (existing && existing.mergedBranch === branch) return existing
  const merged = await opts.lookupMerged()
  if (!merged) return null
  return { mergedBranch: branch, prNumber: merged.number, detectedAt: opts.now }
}
