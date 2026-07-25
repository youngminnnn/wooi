import type { StackedBranch } from '@shared/types'

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
