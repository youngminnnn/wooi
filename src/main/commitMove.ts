import type {
  CommitMoveBlocker,
  CommitMovePreview,
  CommitMoveResult,
  RestackResult,
  StackCascadeStep,
  StackedBranch,
  WorkspaceStatus
} from '@shared/types'
import {
  commitChangedPaths,
  commitInRange,
  isAncestor,
  isWorktreeClean,
  listCommits,
  moveCommitDownLocal,
  pushBranchForceWithLease,
  restackOnto,
  revParse
} from './git'
import {
  detectRemoteDivergence,
  divergedMessage,
  divergedStep,
  stepFromRestack,
  type StackProgressSink
} from './cascade'

/** 저장소를 읽지 않고 호출자가 건네는 모델 A 워크스페이스의 최소 계약. */
export interface CommitMoveWorkspace {
  id: string
  branch: string
  baseBranch: string
  worktreePath: string
  prNumber: number | null
  status: WorkspaceStatus
  parentWorkspaceId: string | null
  archived?: boolean
  stack?: StackedBranch[]
}

interface MoveContext {
  upper: CommitMoveWorkspace
  lower: CommitMoveWorkspace | null
  affected: CommitMoveWorkspace[]
  descendants: CommitMoveWorkspace[]
}

/** 부모가 자식보다 먼저 오게 순회한다. 그래야 각 restack 이 바로 아래층의 새 tip 위에서 출발한다. */
function resolveContext(workspaces: CommitMoveWorkspace[], upperId: string): MoveContext | null {
  const upper = workspaces.find((w) => w.id === upperId && !w.archived)
  if (!upper) return null
  const lower = upper.parentWorkspaceId
    ? (workspaces.find((w) => w.id === upper.parentWorkspaceId && !w.archived) ?? null)
    : null
  if (!lower) return { upper, lower: null, affected: [upper], descendants: [] }

  const descendants: CommitMoveWorkspace[] = []
  const visit = (parentId: string): void => {
    for (const child of workspaces.filter((w) => !w.archived && w.parentWorkspaceId === parentId)) {
      if (child.id !== upper.id) descendants.push(child)
      visit(child.id)
    }
  }
  visit(lower.id)
  return { upper, lower, descendants, affected: [lower, upper, ...descendants] }
}

async function tips(
  entries: CommitMoveWorkspace[]
): Promise<Array<{ branch: string; sha: string }>> {
  const out: Array<{ branch: string; sha: string }> = []
  for (const entry of entries) {
    const sha = await revParse(entry.worktreePath, entry.branch)
    if (sha) out.push({ branch: entry.branch, sha })
  }
  return out
}

/** 읽기만 하는 공통 사전 점검. blocker 하나를 찾았다고 뒤의 위험을 숨기지 않는다. */
async function inspect(
  workspaces: CommitMoveWorkspace[],
  upperWorkspaceId: string,
  sha: string
): Promise<{ context: MoveContext | null; blockers: CommitMoveBlocker[] }> {
  const context = resolveContext(workspaces, upperWorkspaceId)
  const blockers: CommitMoveBlocker[] = []
  if (!context) {
    return {
      context,
      blockers: [{ kind: 'no-lower', branch: '', message: 'The upper workspace was not found.' }]
    }
  }
  const { upper, lower, affected } = context
  if (!lower) {
    blockers.push({
      kind: 'no-lower',
      branch: upper.branch,
      message: 'This workspace has no lower layer.'
    })
  }
  for (const entry of affected) {
    if (entry.stack && entry.stack.length > 1) {
      blockers.push({
        kind: 'model-b',
        branch: entry.branch,
        message: 'Moving commits is only supported for stacks made of separate workspaces.'
      })
    }
    if (entry.status === 'running') {
      blockers.push({
        kind: 'running',
        branch: entry.branch,
        message: 'Stop the running workspace before moving a commit.'
      })
    }
    if (!(await isWorktreeClean(entry.worktreePath))) {
      blockers.push({
        kind: 'dirty',
        branch: entry.branch,
        message: 'Commit or stash your changes before moving a commit.'
      })
    }
    if ((await detectRemoteDivergence(entry.worktreePath, entry.branch)) === 'diverged') {
      blockers.push({
        kind: 'diverged',
        branch: entry.branch,
        message: divergedMessage(entry.branch)
      })
    }
  }
  if (lower && !(await commitInRange(upper.worktreePath, upper.baseBranch, sha))) {
    const upperTip = await revParse(upper.worktreePath, upper.branch)
    const lowerTip = await revParse(lower.worktreePath, lower.branch)
    const inLayer =
      !!upperTip &&
      !!lowerTip &&
      (await isAncestor(upper.worktreePath, sha, upperTip)) &&
      !(await isAncestor(upper.worktreePath, sha, lowerTip))
    blockers.push({
      kind: inLayer ? 'merge-commit' : 'not-in-range',
      branch: upper.branch,
      message: inLayer
        ? 'Merge commits cannot be moved between stack layers.'
        : 'The commit is not in the upper layer.'
    })
  }
  return { context, blockers }
}

export async function previewCommitMove(opts: {
  workspaces: CommitMoveWorkspace[]
  upperWorkspaceId: string
  sha: string
}): Promise<CommitMovePreview> {
  const checked = await inspect(opts.workspaces, opts.upperWorkspaceId, opts.sha)
  if (!checked.context) throw new Error('The upper workspace was not found.')
  const { upper, lower, descendants, affected } = checked.context
  const commit = (await listCommits(upper.worktreePath, upper.baseBranch)).find(
    (entry) => entry.sha === opts.sha
  ) ?? {
    sha: opts.sha,
    shortSha: opts.sha.slice(0, 12),
    subject: '',
    authorName: '',
    authoredAt: 0
  }
  const files = await commitChangedPaths(upper.worktreePath, opts.sha).catch(() => [])
  return {
    commit,
    lower: {
      branch: lower?.branch ?? '',
      prNumber: lower?.prNumber ?? null,
      filesGained: files
    },
    upper: { branch: upper.branch, prNumber: upper.prNumber, filesLost: files },
    alsoForcePushed: descendants.map(({ branch, prNumber }) => ({ branch, prNumber })),
    before: await tips(affected),
    blockers: checked.blockers
  }
}

/**
 * 로컬 이동까지는 원자적으로 되돌리지만, 첫 push 뒤에는 되감지 않는다. 원격을 한 번 더 rewrite 하면
 * 실패 원인을 고치는 대신 협업자의 새 tip 을 다시 덮을 수 있으므로, 그 경계부터는 before sha 와
 * 어느 push까지 나갔는지를 정확히 반환해 사람이 복구 방향을 고르게 한다.
 */
export async function moveCommitDown(opts: {
  workspaces: CommitMoveWorkspace[]
  upperWorkspaceId: string
  sha: string
  progress?: StackProgressSink
}): Promise<CommitMoveResult> {
  const checked = await inspect(opts.workspaces, opts.upperWorkspaceId, opts.sha)
  const before = checked.context ? await tips(checked.context.affected) : []
  const blocked = (message?: string): CommitMoveResult => ({
    status: 'blocked',
    failedStep: 'preflight',
    message,
    blockers: checked.blockers,
    before,
    after: before,
    rolledBack: true,
    steps: []
  })
  if (!checked.context || !checked.context.lower || checked.blockers.length) return blocked()
  const { upper, lower, descendants, affected } = checked.context
  if (before.length !== affected.length) return blocked('Could not record every branch tip.')

  opts.progress?.start(lower.branch, 'cherry-pick')
  const local = await moveCommitDownLocal({
    lowerWorktree: lower.worktreePath,
    lowerBranch: lower.branch,
    upperWorktree: upper.worktreePath,
    upperBranch: upper.branch,
    sha: opts.sha
  })
  if (!local.ok) {
    const step: StackCascadeStep = {
      branch: local.step === 'cherry-pick' ? lower.branch : upper.branch,
      prNumber: local.step === 'cherry-pick' ? lower.prNumber : upper.prNumber,
      kind: local.step === 'cherry-pick' ? 'cherry-pick' : 'drop',
      status: local.conflictedFiles.length ? 'conflict' : 'failed',
      conflictedFiles: local.conflictedFiles,
      message: local.message
    }
    opts.progress?.step(step)
    return {
      status: local.conflictedFiles.length ? 'conflict' : 'error',
      failedStep: local.step,
      conflictedFiles: local.conflictedFiles,
      message: local.message,
      before,
      after: local.rolledBack ? before : await tips(affected),
      rolledBack: local.rolledBack,
      steps: [step]
    }
  }
  const picked: StackCascadeStep = {
    branch: lower.branch,
    prNumber: lower.prNumber,
    kind: 'cherry-pick',
    status: 'ok'
  }
  opts.progress?.step(picked)
  opts.progress?.start(upper.branch, 'drop')
  const dropped: StackCascadeStep = {
    branch: upper.branch,
    prNumber: upper.prNumber,
    kind: 'drop',
    status: 'ok'
  }
  opts.progress?.step(dropped)
  const steps = [picked, dropped]

  if (!(await pushBranchForceWithLease(lower.worktreePath, lower.branch))) {
    return {
      status: 'error',
      failedStep: 'push-lower',
      message: 'The local move succeeded, but the lower branch could not be force-pushed.',
      before,
      after: await tips(affected),
      rolledBack: false,
      steps
    }
  }
  if (!(await pushBranchForceWithLease(upper.worktreePath, upper.branch))) {
    return {
      status: 'error',
      failedStep: 'push-upper',
      message:
        'The lower branch was pushed, but the upper branch was not. The upper pull request temporarily shows the moved commit twice.',
      before,
      after: await tips(affected),
      rolledBack: false,
      steps
    }
  }

  const oldTips = new Map(before.map((entry) => [entry.branch, entry.sha]))
  let halted: string | null = null
  for (const child of descendants) {
    opts.progress?.start(child.branch, 'restack')
    let step: StackCascadeStep
    if (halted) {
      step = {
        branch: child.branch,
        prNumber: child.prNumber,
        kind: 'restack',
        status: 'skipped',
        message: `skipped after ${halted}`
      }
    } else if ((await detectRemoteDivergence(child.worktreePath, child.branch)) === 'diverged') {
      step = divergedStep(child.branch, child.prNumber)
      halted = `${child.branch} diverged from its remote`
    } else {
      const result = await restackOnto(
        child.worktreePath,
        child.baseBranch,
        oldTips.get(child.baseBranch)
      ).catch((error): RestackResult => ({
        status: 'error',
        baseBranch: child.baseBranch,
        message: error instanceof Error ? error.message : String(error)
      }))
      step = stepFromRestack(child.branch, child.prNumber, result)
      if (result.status === 'conflict') halted = `rebase conflict on ${child.branch}`
      else if (result.status === 'error' || result.status === 'dirty') {
        halted = `rebase of ${child.branch} failed`
      }
    }
    steps.push(step)
    opts.progress?.step(step)
  }
  const failed = steps.find(
    (step) =>
      step.kind === 'restack' &&
      (step.status === 'conflict' || step.status === 'failed' || step.status === 'diverged')
  )
  return {
    status: failed?.status === 'conflict' ? 'conflict' : failed ? 'error' : 'moved',
    failedStep: failed ? 'restack' : undefined,
    conflictedFiles: failed?.conflictedFiles,
    message: failed?.message,
    before,
    after: await tips(affected),
    rolledBack: false,
    steps
  }
}
