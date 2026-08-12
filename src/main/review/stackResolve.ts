import { buildStackFromGhStack, buildStackFromPrs, type GhStackEdge, type PrEdge } from '../stack'
import { orderByStack, workspaceStack, workspaceStackMembers } from '@shared/types'
import type { Workspace } from '@shared/types'

/**
 * 스택 멤버십을 읽는 **유일한 자리**.
 *
 * Wooi 에는 스택 모델이 둘 있고(워크스페이스 체인 / worktree 안 브랜치 스택), 화면은 이미
 * 둘을 같은 모양으로 그린다. 리뷰도 같아야 하는데, 그 방법은 각 모델을 따로 아는 것이 아니라
 * **기존 추상을 통해서만 묻는 것**이다 — `workspaceStack()`, `workspaceStackMembers()`,
 * `buildStackFromPrs()`. 아래 함수들이 그것을 부르는 유일한 곳이고, 리뷰의 나머지 부분은
 * "아래→위로 정렬된 PR 번호 목록" 하나만 안다.
 *
 * 스택 멤버십의 진실 원천은 나중에 바뀔 수 있다(GitHub 의 네이티브 스택을 채택할지 별도로
 * 검토 중이다). 그때 바뀌는 것은 이 파일 하나여야 한다.
 */

/** 리뷰가 볼 스택. 아래(base 쪽)가 먼저 온다. */
export interface ResolvedStack {
  prNumbers: number[]
  /** 스택 관계는 있지만 아직 PR 이 없는 브랜치들. 화면이 "이건 못 본다" 고 말해 줄 근거. */
  branchesWithoutPr: string[]
}

/** 스택이라고 부를 수 있는 최대 크기. 이보다 크면 스택 자체가 문제다. */
export const MAX_STACK_LAYERS = 10

/** GitHub 이 서버에 들고 있는 스택 객체(ghStack.ts 의 `GhStackInfo` 가 이 모양을 만족한다). */
export interface GhStackShape {
  baseRef: string
  entries: GhStackEdge[]
}

/**
 * PR 번호 하나에서 그 PR 이 속한 스택을 복원한다.
 *
 * **GitHub 이 스택 객체를 들고 있으면 그 순서가 이긴다** — 앱의 흡수 경로(ipc 의
 * `reconcileWorkspaceStack`)와 같은 우선순위다. position 이 명시적이라 리타겟이 밀려 base 체인이
 * 잠시 끊겨도 살아남기 때문인데, 리뷰에서는 그게 더 중요하다: 체인이 끊긴 순간에 스택을 놓치면
 * 사용자는 스택을 리뷰하려다 PR 하나만 리뷰하게 된다. 없으면 base→head 링크 복원으로 떨어진다.
 *
 * Wooi 밖에서 만든 스택도 두 경로 모두로 잡힌다 — 리뷰는 남의 스택을 보는 일이 더 많다.
 * 스택이 아니면 그 PR 하나만 담아 돌려준다(= 레이어가 하나인 스택).
 */
export function resolveStackForPr(
  prNumber: number,
  openPrs: PrEdge[],
  ghStack?: GhStackShape | null
): ResolvedStack {
  const fromGh = ghStack ? stackFromGh(prNumber, ghStack) : null
  if (fromGh) return fromGh

  const anchor = openPrs.find((p) => p.number === prNumber)
  if (!anchor) return { prNumbers: [prNumber], branchesWithoutPr: [] }

  const chain = buildStackFromPrs(anchor.head, openPrs, new Set())
  if (!chain) return { prNumbers: [prNumber], branchesWithoutPr: [] }

  const prNumbers = chain
    .map((e) => e.prNumber)
    .filter((n): n is number => typeof n === 'number' && n > 0)
  // anchor 가 빠지는 경우는 없어야 하지만, 빠졌다면 사용자가 고른 PR 을 잃는 것보다
  // 스택을 포기하는 편이 낫다.
  if (!prNumbers.includes(prNumber)) return { prNumbers: [prNumber], branchesWithoutPr: [] }
  return { prNumbers, branchesWithoutPr: [] }
}

/**
 * 워크스페이스에서 그 워크스페이스가 속한 스택의 PR 들을 복원한다.
 *
 * 두 모델을 모두 받는다:
 * - worktree 안 브랜치 스택(모델 B) → `workspaceStack(ws)` 의 엔트리들
 * - 워크스페이스 체인(모델 A) → 같은 리포의 살아 있는 멤버들을 스택 순서로
 *
 * 어느 쪽이든 PR 이 없는 엔트리는 리뷰할 수 없으므로 따로 모아 돌려준다. 조용히 빼면 사용자는
 * 스택 전체를 봤다고 생각하는데 실제로는 일부만 본 것이 된다.
 */
export function resolveStackForWorkspace(ws: Workspace, all: Workspace[]): ResolvedStack {
  const entries = workspaceStack(ws)
  if (entries.length > 1) {
    // 모델 B: 엔트리 목록이 이미 아래→위로 정렬돼 있다.
    return split(entries.map((e) => ({ prNumber: e.prNumber, branch: e.branch })))
  }

  // 모델 A: 부모-자식 체인. orderByStack 이 부모 바로 뒤에 자식을 놓으므로 그 순서가 아래→위다.
  const active = all.filter((w) => w.repoId === ws.repoId && !w.archived)
  const members = workspaceStackMembers(active, ws.id)
  if (members.length > 1) {
    return split(
      orderByStack(members).map(({ workspace: m }) => ({
        prNumber: m.prNumber,
        branch: m.branch
      }))
    )
  }

  return split([{ prNumber: ws.prNumber, branch: ws.branch }])
}

/**
 * GitHub 스택에서 이 PR 이 속한 체인을 뽑는다. anchor 브랜치는 엔트리에서 직접 찾으므로
 * 열린 PR 목록에 의존하지 않는다 — 목록이 낡았거나 그 PR 이 빠져 있어도 서버의 답이 이긴다.
 */
function stackFromGh(prNumber: number, info: GhStackShape): ResolvedStack | null {
  const anchor = info.entries.find((e) => e.prNumber === prNumber)
  if (!anchor) return null
  // 경계(exclude)는 비운다. 리뷰는 워크스페이스에 흡수하는 것이 아니라 읽기만 하므로,
  // 다른 워크스페이스가 그 브랜치를 들고 있다는 이유로 스택에서 뺄 근거가 없다.
  const chain = buildStackFromGhStack(anchor.headRef, info, new Set())
  if (!chain) return null
  const prNumbers = chain
    .map((e) => e.prNumber)
    .filter((n): n is number => typeof n === 'number' && n > 0)
  if (!prNumbers.includes(prNumber)) return null
  return { prNumbers, branchesWithoutPr: [] }
}

function split(rows: Array<{ prNumber: number | null; branch: string }>): ResolvedStack {
  const prNumbers: number[] = []
  const branchesWithoutPr: string[] = []
  for (const r of rows) {
    if (typeof r.prNumber === 'number' && r.prNumber > 0) prNumbers.push(r.prNumber)
    else branchesWithoutPr.push(r.branch)
  }
  return { prNumbers, branchesWithoutPr }
}
