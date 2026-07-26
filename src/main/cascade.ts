import type { StackCascadeStep, StackedBranch, RestackResult } from '@shared/types'
import {
  getPrMeta,
  retargetPr,
  reopenPr,
  remoteRefExists,
  restoreRemoteRef,
  deleteRemoteRef
} from './github'
import { checkoutBranch, currentBranch, isWorktreeClean, restackOnto, revParse } from './git'

/**
 * 부모 PR 병합 후 자식 PR 들을 조부모로 옮기는 캐스케이드.
 *
 * 이 모듈의 존재 이유는 두 가지다.
 * 1) 캐스케이드는 병합 경로(UI 병합)와 동기화 경로(외부 병합 감지 후 사용자 승인) 양쪽에서
 *    똑같이 돌아야 한다 — 로직을 한 곳에 둔다.
 * 2) 모든 단계의 성공/실패를 구조화해 돌려준다. 예전에는 `.catch(() => {})` 로 전부 삼켜서,
 *    리타겟이나 리베이스가 실패해도 사용자는 스택이 깨진 걸 알 수 없었다.
 *
 * ── base 브랜치 삭제와 자식 PR (실측 확인) ──────────────────────────────────
 * GitHub 은 base 브랜치가 사라지는 "시점"에 따라 자식 PR 을 다르게 처리한다.
 *  - 병합과 동시에 삭제(delete_branch_on_merge=true 또는 `gh pr merge --delete-branch`):
 *    자식 PR 을 조부모로 **자동 retarget** 하고 열린 상태로 둔다. 이 경우 우리가 할 일은 없다
 *    (그래서 아래에서 base 가 이미 목표값이면 'skipped' 로 기록한다).
 *  - 병합과 무관한 별도 삭제(사용자가 나중에 브랜치를 지움): 자식 PR 을 **닫아 버린다**.
 *    닫힌 PR 은 base 변경이 거부되고(`Cannot change the base branch of a closed pull request`),
 *    base 브랜치가 없으면 reopen 도 거부된다(`Could not open the pull request`) — 교착이다.
 *    유일한 탈출로는 base 브랜치를 되살린 뒤 reopen → retarget 하는 것이다. recoverClosedPr 가 그 경로다.
 */

/** RestackResult 를 캐스케이드 단계 결과로 옮긴다. */
export function stepFromRestack(
  branch: string,
  prNumber: number | null,
  r: RestackResult
): StackCascadeStep {
  const base = { branch, prNumber, kind: 'restack' as const }
  switch (r.status) {
    case 'restacked':
      return { ...base, status: 'ok', message: r.pushed ? 'rebased and pushed' : 'rebased' }
    case 'up-to-date':
      return { ...base, status: 'skipped', message: 'already up to date' }
    case 'conflict':
      return { ...base, status: 'conflict', conflictedFiles: r.conflictedFiles }
    default:
      return { ...base, status: 'failed', message: r.message ?? 'rebase failed' }
  }
}

/**
 * base 브랜치가 삭제돼 GitHub 이 닫아 버린 자식 PR 을 되살린다.
 * base 복원 → reopen → 새 base 로 retarget → 복원했던 발판 브랜치 정리.
 * 발판 삭제는 retarget 이 끝난 뒤라 더 이상 base 가 아니므로 PR 을 다시 닫지 않는다(실측 확인).
 */
async function recoverClosedPr(
  worktreePath: string,
  selector: string | number,
  branch: string,
  prNumber: number | null,
  deletedBase: string,
  deletedBaseOid: string,
  desiredBase: string
): Promise<StackCascadeStep> {
  const step = { branch, prNumber, kind: 'recover' as const }

  // 1) 삭제된 base 브랜치를 PR 이 기억하는 sha 로 되살린다(이미 있으면 건너뛴다).
  let scaffolded = false
  if (!(await remoteRefExists(worktreePath, deletedBase))) {
    if (!deletedBaseOid) {
      return {
        ...step,
        status: 'failed',
        message: `base '${deletedBase}' is gone and its commit is unknown`
      }
    }
    const restored = await restoreRemoteRef(worktreePath, deletedBase, deletedBaseOid)
    if (restored.error) return { ...step, status: 'failed', message: restored.error }
    scaffolded = true
  }

  // 2) 되살린 base 위에서 PR 을 다시 연다.
  const reopened = await reopenPr(worktreePath, selector)
  if (reopened.error) {
    if (scaffolded) await deleteRemoteRef(worktreePath, deletedBase)
    return { ...step, status: 'failed', message: reopened.error }
  }

  // 3) 열린 상태가 됐으니 진짜 base 로 옮긴다.
  const retargeted = await retargetPr(worktreePath, desiredBase, String(selector))
  if (retargeted.error) {
    return {
      ...step,
      status: 'failed',
      message: `reopened but retarget failed: ${retargeted.error}`
    }
  }

  // 4) 발판으로 되살린 브랜치는 다시 지운다(원래 없던 브랜치를 남기지 않는다).
  if (scaffolded && deletedBase !== desiredBase) await deleteRemoteRef(worktreePath, deletedBase)

  return { ...step, status: 'ok', message: `reopened and retargeted onto ${desiredBase}` }
}

/**
 * 자식 PR 들의 base 를 새 base 로 옮긴다(PR 쪽만 — git 히스토리는 건드리지 않는다).
 * entries 는 병합된 브랜치 위의 엔트리들(아래→위). 한 건이 실패해도 나머지는 계속 시도한다.
 */
export async function cascadeRetarget(opts: {
  worktreePath: string
  mergedBranch: string
  newBase: string
  entries: StackedBranch[]
}): Promise<StackCascadeStep[]> {
  const { worktreePath, mergedBranch, newBase, entries } = opts
  const steps: StackCascadeStep[] = []

  for (const e of entries) {
    // 병합된 브랜치를 직속 base 로 삼던 PR 만 옮긴다. 그 위는 base 가 그대로다.
    if (e.baseBranch !== mergedBranch) continue

    const selector = e.prNumber ?? e.branch
    const meta = await getPrMeta(worktreePath, selector).catch(() => null)
    if (!meta) {
      steps.push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'retarget',
        status: e.prNumber ? 'failed' : 'skipped',
        message: e.prNumber ? `pull request #${e.prNumber} could not be read` : 'no pull request'
      })
      continue
    }

    if (meta.state === 'MERGED') {
      steps.push({
        branch: e.branch,
        prNumber: meta.number,
        kind: 'retarget',
        status: 'skipped',
        message: 'already merged'
      })
      continue
    }

    if (meta.state === 'CLOSED') {
      // base 브랜치 삭제로 GitHub 이 닫아 버린 경우 — 복구 경로로 되살린다.
      steps.push(
        await recoverClosedPr(
          worktreePath,
          selector,
          e.branch,
          meta.number,
          meta.baseRefName,
          meta.baseRefOid,
          newBase
        ).catch((err) => ({
          branch: e.branch,
          prNumber: meta.number,
          kind: 'recover' as const,
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err)
        }))
      )
      continue
    }

    // 열려 있는데 base 가 이미 목표값이면 GitHub 이 병합 시점에 자동 retarget 한 것이다.
    if (meta.baseRefName === newBase) {
      steps.push({
        branch: e.branch,
        prNumber: meta.number,
        kind: 'retarget',
        status: 'skipped',
        message: `already based on ${newBase}`
      })
      continue
    }

    const res = await retargetPr(worktreePath, newBase, String(selector)).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
    steps.push({
      branch: e.branch,
      prNumber: meta.number,
      kind: 'retarget',
      status: res.error ? 'failed' : 'ok',
      message: res.error ?? `retargeted onto ${newBase}`
    })
  }

  return steps
}

/**
 * 모델 B(단일 worktree 안 브랜치 스택)의 git 히스토리를 새 base 위로 옮긴다.
 * 브랜치를 하나씩 체크아웃하며 `rebase --onto` 로 병합된 부모 커밋을 떨군다.
 * 워킹트리가 dirty 하면 아무것도 하지 않고 그 사실을 단계 결과로 남긴다(조용히 건너뛰지 않는다).
 */
export async function cascadeRestackBranchStack(opts: {
  worktreePath: string
  mergedBranch: string
  newBase: string
  /** 병합 브랜치 위 엔트리들(아래→위). */
  entries: StackedBranch[]
  /** oldTip 계산용 스택 전체. */
  allEntries: StackedBranch[]
}): Promise<StackCascadeStep[]> {
  const { worktreePath, mergedBranch, newBase, entries, allEntries } = opts
  if (!entries.length) return []

  const clean = await isWorktreeClean(worktreePath).catch(() => false)
  if (!clean) {
    return entries.map((e) => ({
      branch: e.branch,
      prNumber: e.prNumber,
      kind: 'restack' as const,
      status: 'skipped' as const,
      message: 'uncommitted changes in the worktree — rebase skipped, restack manually'
    }))
  }

  const original = await currentBranch(worktreePath).catch(() => '')

  // rebase 로 각 브랜치 tip 이 바뀌므로, 그 전에 원래 tip 을 잡아 둔다(상위 브랜치의 oldBase 계산용).
  const oldTip = new Map<string, string>()
  for (const e of allEntries) {
    const sha = await revParse(worktreePath, e.branch)
    if (sha) oldTip.set(e.branch, sha)
  }

  const steps: StackCascadeStep[] = []
  let halted: string | null = null

  for (const e of entries) {
    if (halted) {
      steps.push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'restack',
        status: 'skipped',
        message: `skipped after ${halted}`
      })
      continue
    }

    const directChild = e.baseBranch === mergedBranch
    const base = directChild ? newBase : e.baseBranch
    // oldBase: 직속 자식은 병합된 브랜치, 그 위는 자기 base 의 rebase 이전 tip.
    const oldBase = directChild ? mergedBranch : oldTip.get(e.baseBranch)

    const co = await checkoutBranch(worktreePath, e.branch)
    if (co.error) {
      steps.push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'restack',
        status: 'failed',
        message: co.error
      })
      halted = `checkout of ${e.branch} failed`
      continue
    }

    const r = await restackOnto(worktreePath, base, oldBase).catch((err): RestackResult => ({
      status: 'error',
      baseBranch: base,
      message: err instanceof Error ? err.message : String(err)
    }))
    steps.push(stepFromRestack(e.branch, e.prNumber, r))

    // 충돌은 워킹트리를 rebase 진행 상태로 남긴다 — 이후 브랜치는 체크아웃조차 불가하므로 멈춘다.
    if (r.status === 'conflict') halted = `rebase conflict on ${e.branch}`
    else if (r.status === 'error' || r.status === 'dirty') halted = `rebase of ${e.branch} failed`
  }

  // 원래 브랜치로 되돌린다(병합돼 스택에서 빠질 브랜치였다면 그대로 둔다 — 호출부가 HEAD 를 보고 맞춘다).
  if (!halted && original && original !== mergedBranch) {
    await checkoutBranch(worktreePath, original).catch(() => ({}))
  }

  return steps
}
