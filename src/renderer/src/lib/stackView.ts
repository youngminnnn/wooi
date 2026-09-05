import {
  isBranchStack,
  orderByStack,
  workspaceDisplayName,
  workspaceStack,
  workspaceStackMembers
} from '@shared/types'
import type {
  BaseMismatch,
  CommitEntry,
  GitStatus,
  PrStatus,
  StackCascadeStep,
  StackCascadeStepKind,
  StackOpProgress,
  StackTrainPlan,
  StackedBranch,
  Workspace,
  WorkspaceDiff
} from '@shared/types'

/**
 * 스택 화면이 그리는 한 층. 두 스택 모델을 같은 모양으로 담는다 —
 * 모델 A(부모-자식 워크스페이스 체인)와 모델 B(한 워크트리 안 브랜치 스택).
 *
 * 화면은 이 배열만 보고 그린다. 어느 모델에서 나왔는지는 `live` 로만 새어 나온다.
 */
export interface StackLayer {
  /** React key 이자 층별 상태 맵의 키. 모델 A 는 워크스페이스 id, 모델 B 는 브랜치 이름. */
  key: string
  /** 이 층의 git·PR·커밋을 조회할 때 쓰는 워크스페이스. 모델 B 는 모든 층이 같다. */
  workspaceId: string
  /** 사람이 읽는 이름. 모델 A 는 워크스페이스 이름, 모델 B 는 브랜치 이름. */
  label: string
  branch: string
  baseBranch: string
  /** 스택 트리에서의 깊이(바닥=0). 사이드바·팝오버와 같은 규칙. */
  depth: number
  prNumber: number | null
  /** 아래 층의 key. 바닥이면 null. */
  parentKey: string | null
  /** 이 화면을 연 층인가. */
  isAnchor: boolean
  /**
   * 이 층의 워크트리가 지금 이 브랜치를 체크아웃하고 있는가.
   *
   * 모델 A 는 층마다 제 워크트리가 있으므로 언제나 참이다. 모델 B 는 워크트리가 하나뿐이라
   * 체크아웃되지 않은 층의 커밋·변경 요약·behind 를 읽을 방법이 없다 — 그런 층에 숫자를
   * 지어내지 않기 위해 이 값을 들고 다닌다.
   */
  live: boolean
  /**
   * 이 층이 base 로 기록한 브랜치가 아래 층의 브랜치와 다를 때 그 내용.
   *
   * 스택은 "아래 층 위에 서 있다"는 약속이고, 어긋나면 이 층의 PR diff 가 아래 층 변경까지
   * 삼켜 층이 층을 나누지 못한다. 모델 B 는 base 링크가 곧 부모라 구조적으로 어긋날 수 없다.
   */
  baseDrift: StackBaseDrift | null
  /** PR 의 base 가 스택 부모가 아닐 때(GitHub 쪽 어긋남). 배너가 되돌리기를 제안한다. */
  prBaseMismatch: BaseMismatch | null
}

export interface StackBaseDrift {
  /** 아래 층이 실제로 서 있는 브랜치. */
  expected: string
  /** 이 층이 base 로 기록해 둔 브랜치. */
  actual: string
}

/**
 * 모델 B 스택의 브랜치별 깊이. base 링크를 따라 바닥까지 내려가며 센다.
 * 스택 팝오버와 스택 화면이 **같은 함수**를 봐야 두 화면의 들여쓰기가 갈라지지 않는다.
 */
export function branchStackDepths(entries: StackedBranch[]): Map<string, number> {
  const byBranch = new Map(entries.map((e) => [e.branch, e]))
  const out = new Map<string, number>()
  for (const entry of entries) {
    let depth = 0
    let cur: StackedBranch | undefined = entry
    const seen = new Set<string>()
    while (cur && byBranch.has(cur.baseBranch) && !seen.has(cur.branch)) {
      seen.add(cur.branch)
      depth++
      cur = byBranch.get(cur.baseBranch)
    }
    out.set(entry.branch, depth)
  }
  return out
}

/**
 * 앵커 워크스페이스가 속한 스택을 바닥→꼭대기 순의 층 목록으로 편다.
 * 스택이 아니면 한 층짜리 목록이 되고, 화면은 그때 열리지 않는다.
 */
export function buildStackLayers(workspaces: Workspace[], anchorId: string): StackLayer[] {
  const anchor = workspaces.find((w) => w.id === anchorId)
  if (!anchor) return []

  if (isBranchStack(anchor)) {
    const entries = workspaceStack(anchor)
    const depths = branchStackDepths(entries)
    const byBranch = new Map(entries.map((e) => [e.branch, e]))
    return entries.map((entry) => {
      const live = entry.branch === anchor.branch
      return {
        key: entry.branch,
        workspaceId: anchor.id,
        label: entry.branch,
        branch: entry.branch,
        baseBranch: entry.baseBranch,
        depth: depths.get(entry.branch) ?? 0,
        prNumber: entry.prNumber,
        parentKey: byBranch.has(entry.baseBranch) ? entry.baseBranch : null,
        isAnchor: live,
        live,
        baseDrift: null,
        // 어긋남은 체크아웃된 브랜치에 대해서만 기록돼 있다 — 나머지 층에 옮겨 붙이지 않는다.
        prBaseMismatch: live ? (anchor.baseMismatch ?? null) : null
      }
    })
  }

  const active = workspaces.filter((w) => w.repoId === anchor.repoId && !w.archived)
  const members = workspaceStackMembers(active, anchorId)
  const byId = new Map(members.map((m) => [m.id, m]))
  return orderByStack(members).map(({ workspace: member, depth }) => {
    const parent = member.parentWorkspaceId ? byId.get(member.parentWorkspaceId) : undefined
    return {
      key: member.id,
      workspaceId: member.id,
      label: workspaceDisplayName(member),
      branch: member.branch,
      baseBranch: member.baseBranch,
      depth,
      prNumber: member.prNumber,
      parentKey: parent?.id ?? null,
      isAnchor: member.id === anchorId,
      live: true,
      baseDrift:
        parent && parent.branch !== member.baseBranch
          ? { expected: parent.branch, actual: member.baseBranch }
          : null,
      prBaseMismatch: member.baseMismatch ?? null
    }
  })
}

export interface StackDiffTotals {
  files: number
  additions: number
  deletions: number
}

/** 층의 변경 요약(+/-). base 대비 diff 를 합산한다. */
export function diffTotals(diff: WorkspaceDiff | null | undefined): StackDiffTotals | null {
  if (!diff) return null
  let additions = 0
  let deletions = 0
  for (const file of diff.files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { files: diff.files.length, additions, deletions }
}

/** 머지 트레인에서 이 층이 지금 어디에 있는가. */
export type StackTrainCell =
  | { state: 'none' }
  | { state: 'ready' }
  | { state: 'blocked'; reason: string }
  | { state: 'running'; kind: StackCascadeStepKind }
  | { state: 'waiting'; note: string }
  | { state: 'done'; status: StackCascadeStep['status']; message?: string }

/**
 * 계획(무엇을 할 것인가)과 진행 스트림(무엇을 했는가)을 한 칸으로 합친다.
 * 이미 벌어진 일이 계획을 이긴다 — 끝난 층에 "머지 예정" 이라고 남아 있으면 안 된다.
 */
export function trainCellFor(
  branch: string,
  plan: StackTrainPlan | null | undefined,
  progress: StackOpProgress | null | undefined
): StackTrainCell {
  if (progress && !progress.finished && progress.current?.branch === branch) {
    return { state: 'running', kind: progress.current.kind }
  }
  // CI 를 기다리는 동안은 단계가 늘지 않는다. 이걸 "아직 안 왔음" 으로 그리면 트레인이
  // 멎은 것처럼 보인다 — 기다리는 중임을 그 층에서 바로 읽혀야 한다.
  if (progress && !progress.finished && progress.waiting?.branch === branch) {
    return { state: 'waiting', note: progress.waiting.note }
  }
  const done = progress?.done.filter((step) => step.branch === branch).at(-1)
  if (done) {
    return done.message
      ? { state: 'done', status: done.status, message: done.message }
      : { state: 'done', status: done.status }
  }
  const planned = plan?.layers.find((layer) => layer.branch === branch)
  if (!planned) return { state: 'none' }
  return planned.blockedReason
    ? { state: 'blocked', reason: planned.blockedReason }
    : { state: 'ready' }
}

/** 층 하나에 대해 화면이 모아 둔 실시간 상태. */
export interface StackLayerState {
  pr: PrStatus | null
  git: GitStatus | null
  commits: CommitEntry[] | null
  diff: StackDiffTotals | null
  train: StackTrainCell
}

export interface StackSummary {
  layers: number
  /** 병합·닫힘이 아닌 PR 수. */
  openPrs: number
  /** 아직 PR 이 없는 층 수. */
  missingPrs: number
  /** base 가 어긋난 층 수(로컬 기록 또는 GitHub 쪽). */
  drifted: number
  /** base 보다 뒤처진 층 수. */
  behind: number
  /** 머지 트레인이 막힌 층 수. */
  blocked: number
  additions: number
  deletions: number
}

/** 머리글이 한 줄로 말할 수 있는 스택 전체의 상태. */
export function stackSummary(
  layers: StackLayer[],
  states: Record<string, StackLayerState | undefined>
): StackSummary {
  const out: StackSummary = {
    layers: layers.length,
    openPrs: 0,
    missingPrs: 0,
    drifted: 0,
    behind: 0,
    blocked: 0,
    additions: 0,
    deletions: 0
  }
  for (const layer of layers) {
    const state = states[layer.key]
    const pr = state?.pr ?? null
    if (!pr) out.missingPrs++
    else if (pr.state !== 'merged' && pr.state !== 'closed') out.openPrs++
    if (layer.baseDrift || layer.prBaseMismatch) out.drifted++
    if ((state?.git?.behind ?? 0) > 0) out.behind++
    if (state?.train.state === 'blocked') out.blocked++
    out.additions += state?.diff?.additions ?? 0
    out.deletions += state?.diff?.deletions ?? 0
  }
  return out
}

/**
 * 스택 리뷰가 볼 PR 들. **층 순서 그대로**(아래→위) 뽑아, 화면이 보여 준 스택과 리뷰가
 * 읽는 스택이 어긋나지 않게 한다. 병합·닫힘은 리뷰할 것이 없으므로 뺀다.
 */
export function reviewablePrNumbers(
  layers: StackLayer[],
  states: Record<string, StackLayerState | undefined>
): number[] {
  const out: number[] = []
  for (const layer of layers) {
    const pr = states[layer.key]?.pr
    if (pr && pr.state !== 'merged' && pr.state !== 'closed') out.push(pr.number)
  }
  return out
}
