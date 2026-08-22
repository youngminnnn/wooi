import type {
  PrMergeMethod,
  PrState,
  PrStatus,
  StackCascadeResult,
  StackCascadeStep,
  StackTrainPlan,
  StackTrainResult
} from '@shared/types'
import type { PrMeta } from './github'
import type { RemoteState, StackProgressSink } from './cascade'
import { divergedMessage } from './cascade'

/** 트레인이 훑을 층 하나(토폴로지는 호출부가 이미 풀어서 넘긴다). */
export interface TrainLayer {
  /** 모델 A 는 층마다 다른 워크스페이스, 모델 B 는 모든 층이 같은 워크스페이스다. */
  workspaceId: string
  /** 모델 A 는 층마다 worktree 가 다르다 — 이 값이 층마다 달라진다. */
  worktreePath: string
  branch: string
  prNumber: number | null
}

export interface MergeTrainDeps {
  getPrStatus(worktreePath: string, branch: string): Promise<PrStatus | null>
  getPrMeta(worktreePath: string, selector: string | number): Promise<PrMeta | null>
  getPrHeadSha(worktreePath: string, prNumber: number): Promise<string | null>
  isWorktreeClean(worktreePath: string): Promise<boolean>
  detectRemoteDivergence(worktreePath: string, branch: string): Promise<RemoteState>
  mergePr(
    worktreePath: string,
    method: PrMergeMethod,
    selector: string | number
  ): Promise<{ error?: string }>
  /** ipc.ts 의 runMergeCascade 를 그대로 꽂는다. */
  runCascade(
    workspaceId: string,
    mergedBranch: string,
    newBase: string,
    sink?: StackProgressSink
  ): Promise<StackCascadeResult>
  sleep(ms: number): Promise<void>
}

export interface PlannedMergeTrain extends StackTrainPlan {
  headShas: Record<string, string | null>
}

export interface PlanMergeTrainInput {
  layers: TrainLayer[]
  forcePushBranches: string[]
}

export interface RunMergeTrainInput {
  layers: TrainLayer[]
  method: PrMergeMethod
  expectedHeadShas: Record<string, string | null>
  /** GitHub 병합 반영을 기다릴 최대 시간. 테스트에서는 짧게 줄인다. */
  mergeWaitMs?: number
}

function statusBlock(state: PrState): string | null {
  switch (state) {
    case 'closed':
      return 'The pull request is closed.'
    case 'draft':
      return 'Still a draft.'
    case 'conflict':
      return 'Conflicts with its base.'
    case 'ci_failed':
      return 'Checks failed.'
    case 'ci_pending':
      return 'Checks are still running.'
    case 'review_required':
      return 'Review required.'
    case 'changes_requested':
      return 'Changes requested.'
    default:
      return null
  }
}

async function layerBlock(
  layer: TrainLayer,
  status: PrStatus | null,
  deps: MergeTrainDeps,
  includeGitChecks: boolean
): Promise<string | null> {
  if (!status || layer.prNumber === null) return 'No pull request.'
  // 이미 병합된 층은 트레인의 길을 막지 않는다. 실행 때 GitHub 를 다시 읽고 skipped 로 남긴다.
  if (status.state === 'merged') return null
  const blocked = statusBlock(status.state)
  if (blocked || !includeGitChecks) return blocked
  if (!(await deps.isWorktreeClean(layer.worktreePath))) {
    return 'Uncommitted changes in the worktree.'
  }
  if ((await deps.detectRemoteDivergence(layer.worktreePath, layer.branch)) === 'diverged') {
    return 'The remote branch was rewritten outside Wooi.'
  }
  return null
}

export async function planMergeTrain(
  input: PlanMergeTrainInput,
  deps: MergeTrainDeps
): Promise<PlannedMergeTrain> {
  const layers: PlannedMergeTrain['layers'] = []
  const headShas: Record<string, string | null> = {}
  let prefixOpen = true
  let mergeableCount = 0

  for (const layer of input.layers) {
    const status = await deps.getPrStatus(layer.worktreePath, layer.branch)
    const blockedReason = await layerBlock(layer, status, deps, prefixOpen)
    layers.push({
      branch: layer.branch,
      prNumber: status?.number ?? layer.prNumber,
      state: status?.state ?? null,
      blockedReason
    })
    const prNumber = status?.number ?? layer.prNumber
    headShas[layer.branch] =
      prNumber === null ? null : await deps.getPrHeadSha(layer.worktreePath, prNumber)
    if (prefixOpen && blockedReason) prefixOpen = false
    if (prefixOpen && status?.state !== 'merged') mergeableCount++
  }

  const forcePushBranches = [...new Set(input.forcePushBranches)]
  return {
    layers,
    mergeableCount,
    forcePushCount: forcePushBranches.length,
    forcePushBranches,
    headShas
  }
}

function pushStep(
  steps: StackCascadeStep[],
  step: StackCascadeStep,
  sink?: StackProgressSink
): void {
  steps.push(step)
  sink?.step(step)
}

export async function runMergeTrain(
  input: RunMergeTrainInput,
  deps: MergeTrainDeps,
  sink?: StackProgressSink
): Promise<StackTrainResult> {
  const result: StackTrainResult = { mergedPrs: [], steps: [], stoppedAt: null }
  // 이 실행이 스스로 rebase 해 force-push 한 브랜치들. 아래층을 머지하면 캐스케이드가 위층을
  // 새 base 위로 밀어 올리므로, 위층의 head SHA 가 계획 시점과 달라지는 것은 **정상**이다.
  // 그 층까지 계획 대조로 막으면 트레인은 항상 첫 층 다음에서 멈춘다. 대조를 건너뛰어도
  // "내가 만들지 않은 push" 는 layerBlock 의 detectRemoteDivergence 가 그대로 잡는다.
  const rebasedHere = new Set<string>()

  for (const layer of input.layers) {
    const selector = layer.prNumber ?? layer.branch
    const initialMeta = await deps.getPrMeta(layer.worktreePath, selector)
    if (initialMeta?.state === 'MERGED') {
      const step: StackCascadeStep = {
        branch: layer.branch,
        prNumber: initialMeta.number,
        kind: 'merge',
        status: 'skipped',
        message: 'already merged'
      }
      sink?.start(layer.branch, 'merge')
      pushStep(result.steps, step, sink)
      continue
    }
    if (!initialMeta || layer.prNumber === null) {
      result.stoppedAt = { branch: layer.branch, reason: 'No pull request.' }
      return result
    }

    const status = await deps.getPrStatus(layer.worktreePath, layer.branch)
    const blocked = await layerBlock(layer, status, deps, true)
    if (blocked) {
      result.stoppedAt = { branch: layer.branch, reason: blocked }
      return result
    }
    const actualHead = await deps.getPrHeadSha(layer.worktreePath, initialMeta.number)
    if (!rebasedHere.has(layer.branch) && actualHead !== input.expectedHeadShas[layer.branch]) {
      const short = actualHead?.slice(0, 7) ?? 'unknown'
      result.stoppedAt = {
        branch: layer.branch,
        reason: `The pull request changed after the plan was made — head is now ${short}.`
      }
      return result
    }

    sink?.start(layer.branch, 'merge')
    const merged = await deps.mergePr(layer.worktreePath, input.method, initialMeta.number)
    if (merged.error) {
      pushStep(
        result.steps,
        {
          branch: layer.branch,
          prNumber: initialMeta.number,
          kind: 'merge',
          status: 'failed',
          message: merged.error
        },
        sink
      )
      result.stoppedAt = { branch: layer.branch, reason: merged.error }
      return result
    }

    const waitLimit = input.mergeWaitMs ?? 60_000
    const delays = [1_000, 2_000, 3_000, 5_000]
    let waited = 0
    let mergedMeta: PrMeta | null = null
    while (waited <= waitLimit) {
      const meta = await deps.getPrMeta(layer.worktreePath, initialMeta.number)
      if (meta?.state === 'MERGED') {
        mergedMeta = meta
        break
      }
      const delay = Math.min(
        delays[Math.min(delays.length - 1, Math.floor(waited / 5_000))],
        waitLimit - waited
      )
      if (delay <= 0) break
      await deps.sleep(delay)
      waited += delay
    }
    if (!mergedMeta) {
      const reason = 'GitHub did not report the pull request as merged before the wait timed out.'
      pushStep(
        result.steps,
        {
          branch: layer.branch,
          prNumber: initialMeta.number,
          kind: 'merge',
          status: 'failed',
          message: reason
        },
        sink
      )
      result.stoppedAt = { branch: layer.branch, reason }
      return result
    }
    if (!mergedMeta.baseRefName) {
      const reason = 'GitHub did not report the merged pull request base branch.'
      pushStep(
        result.steps,
        {
          branch: layer.branch,
          prNumber: initialMeta.number,
          kind: 'merge',
          status: 'failed',
          message: reason
        },
        sink
      )
      result.stoppedAt = { branch: layer.branch, reason }
      return result
    }
    pushStep(
      result.steps,
      {
        branch: layer.branch,
        prNumber: initialMeta.number,
        kind: 'merge',
        status: 'ok',
        message: 'merged'
      },
      sink
    )
    result.mergedPrs.push(initialMeta.number)

    const cascade = await deps.runCascade(
      layer.workspaceId,
      layer.branch,
      mergedMeta.baseRefName,
      sink
    )
    result.steps.push(...cascade.steps)
    for (const step of cascade.steps) {
      if (step.kind === 'restack' && step.status === 'ok') rebasedHere.add(step.branch)
    }
    const problem = cascade.steps.find(
      (step) => step.status === 'conflict' || step.status === 'diverged' || step.status === 'failed'
    )
    if (problem) {
      const reason =
        problem.status === 'diverged'
          ? (problem.message ?? divergedMessage(problem.branch))
          : (problem.message ??
            (problem.status === 'conflict' ? 'The cascade has conflicts.' : 'The cascade failed.'))
      result.stoppedAt = { branch: problem.branch, reason }
      return result
    }
  }
  return result
}
