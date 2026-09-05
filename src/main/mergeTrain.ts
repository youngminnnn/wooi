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
import { divergedMessage, isDiverged } from './cascade'

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
  /** signal 이 끊기면 남은 시간을 버리고 즉시 깨어난다 — 취소가 30 초씩 늦으면 취소가 아니다. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
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
  /**
   * force-push 직후 GitHub 가 새 head 의 체크를 등록하기까지 봐 줄 시간. 이 창 안에서는
   * review_required/open 을 "아직 계산 중" 으로 읽는다(아래 awaitLayerReady 주석 참고).
   */
  settleMs?: number
  /** CI 를 기다릴 때 다시 물어보기까지의 간격(테스트에서 0 으로 줄인다). */
  pollDelaysMs?: number[]
  /** 사용자가 트레인을 멈추면 끊긴다. 되쓰기 중간이 아닌 안전한 지점에서만 본다. */
  signal?: AbortSignal
}

/** 기다리면 스스로 풀리는 상태인가. 사람이 손대야 하는 차단과 갈라 놓는 유일한 기준이다. */
function isWaitable(state: PrState | undefined): boolean {
  return state === 'ci_pending'
}

const CANCELED = 'Canceled.'
const SETTLING_NOTE = 'Waiting for GitHub to register the new checks.'
/** CI 를 다시 물어보는 간격. 20 초마다 한 단씩 올라가고 30 초에서 멈춘다. */
const POLL_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

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
  const remote = await deps.detectRemoteDivergence(layer.worktreePath, layer.branch)
  // 계획 화면에 들어가는 한 줄이라 짧게 쓰되, 사유는 갈라 둔다 — "남이 다시 썼다" 를 잘못 읽으면
  // 리모트를 취하려 들고, 그건 rebase 결과를 버리는 길이다(cascade.ts 의 divergedMessage 참고).
  if (remote === 'diverged-stale-push') {
    return 'An earlier push was rejected — the remote branch is behind the local one.'
  }
  if (isDiverged(remote)) {
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
    const reason = await layerBlock(layer, status, deps, prefixOpen)
    // CI 가 도는 층은 막힌 것이 아니라 기다릴 층이다. 실행은 기다렸다 머지하는데 계획이 여기서
    // 끊으면, 정작 사용자가 트레인을 걸고 싶은 순간(= 방금 push 해 CI 가 도는 때)에 버튼이 없다.
    const waiting = reason !== null && isWaitable(status?.state)
    layers.push({
      branch: layer.branch,
      prNumber: status?.number ?? layer.prNumber,
      state: status?.state ?? null,
      blockedReason: waiting ? null : reason,
      waitReason: waiting ? reason : null
    })
    const prNumber = status?.number ?? layer.prNumber
    headShas[layer.branch] =
      prNumber === null ? null : await deps.getPrHeadSha(layer.worktreePath, prNumber)
    if (prefixOpen && reason && !waiting) prefixOpen = false
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

/**
 * CI 가 도는 동안은 기다린다. 트레인이 아래층을 머지하면 캐스케이드가 위층을 force-push 하고,
 * 그러면 그 층의 CI 는 **처음부터 다시** 돈다. 이걸 차단으로 읽으면 트레인은 사실상 항상 두 번째
 * 층에서 멈춘다 — 기다리는 것이 트레인의 일이다.
 *
 * 정착(settle) 창이 따로 있는 이유: force-push 직후에는 새 head 의 statusCheckRollup 이 아직
 * 비어 있고, 필수 체크가 걸린 리포는 그 상태를 mergeStateStatus: BLOCKED 로 돌려준다. github.ts
 * 의 stateFor 는 그걸 review_required 로 옮기므로, 그대로 믿으면 "Review required." 로 헛되이
 * 멈춘다. 그래서 **이번 실행이 직접 force-push 한 층**에 한해, 짧은 창 동안은 그 판정을 유보한다.
 * 우리가 밀지 않은 층의 review_required 는 진짜 리뷰 요구이므로 그대로 멈춘다.
 */
async function awaitLayerReady(
  layer: TrainLayer,
  deps: MergeTrainDeps,
  ctx: {
    settleMs: number
    delays: number[]
    justPushed: boolean
    signal?: AbortSignal
    sink?: StackProgressSink
  }
): Promise<{ ok: true } | { ok: false; canceled?: boolean; reason: string }> {
  let waited = 0
  for (;;) {
    if (ctx.signal?.aborted) return { ok: false, canceled: true, reason: CANCELED }
    const status = await deps.getPrStatus(layer.worktreePath, layer.branch)
    const blocked = await layerBlock(layer, status, deps, true)
    if (!blocked) return { ok: true }

    const state = status?.state
    const settling = ctx.justPushed && (state === 'review_required' || state === 'open')
    const waitable = isWaitable(state) || (settling && waited < ctx.settleMs)
    if (!waitable) return { ok: false, reason: blocked }

    ctx.sink?.waiting?.(layer.branch, isWaitable(state) ? blocked : SETTLING_NOTE)
    const delay = ctx.delays[Math.min(ctx.delays.length - 1, Math.floor(waited / 20_000))]
    // 간격이 0 인 테스트에서도 정착 창은 반드시 끝나야 한다 — 최소 1 은 흐르게 둔다.
    await deps.sleep(delay, ctx.signal)
    waited += Math.max(delay, 1)
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
  const settleMs = input.settleMs ?? 60_000
  const pollDelays = input.pollDelaysMs ?? POLL_DELAYS_MS
  const stopCanceled = (branch: string): StackTrainResult => {
    result.canceled = true
    result.stoppedAt = { branch, reason: CANCELED }
    return result
  }

  for (const layer of input.layers) {
    if (input.signal?.aborted) return stopCanceled(layer.branch)
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

    const ready = await awaitLayerReady(layer, deps, {
      settleMs,
      delays: pollDelays,
      justPushed: rebasedHere.has(layer.branch),
      signal: input.signal,
      sink
    })
    if (!ready.ok) {
      if (ready.canceled) return stopCanceled(layer.branch)
      result.stoppedAt = { branch: layer.branch, reason: ready.reason }
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
    // 여기서는 취소를 보지 않는다. 머지는 이미 GitHub 로 나갔고, 남은 일(반영 확인 →
    // 캐스케이드)을 건너뛰면 아래층은 병합됐는데 위층은 옛 base 를 가리킨 채 남는다.
    // 이 창은 60 초로 묶여 있으니 취소는 늦어도 그만큼만 늦다.
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
