import type { StackCascadeStep, StackedBranch, RestackResult } from '@shared/types'
import {
  getPrMeta,
  retargetPr,
  reopenPr,
  remoteRefExists,
  restoreRemoteRef,
  deleteRemoteRef
} from './github'
import {
  checkoutBranch,
  currentBranch,
  hasCommit,
  isAncestor,
  isWorktreeClean,
  remoteTipSha,
  restackOnto,
  revParse
} from './git'

/**
 * 캐스케이드가 단계를 하나 만들 때마다 밖으로 흘려보내는 통로. 캐스케이드는 브랜치를 하나씩
 * 순차로 처리하느라 수십 초가 걸리는데, 예전에는 그동안 UI 가 스피너 하나로 멈춰 있었다.
 * 결과만 모아 돌려주는 반환값과 따로 두는 이유가 그것이다 — 진행은 끝나기 전에 보여야 뜻이 있다.
 * 선택적 인자라 이 싱크를 넘기지 않는 호출부의 동작은 이전과 완전히 같다.
 */
export interface StackProgressSink {
  /** 이 브랜치의 단계를 시작한다(결과가 나오기 전에 "지금 여기"를 알리는 용도). */
  start(branch: string, kind: StackCascadeStep['kind']): void
  /** 단계 하나가 끝났다. 반환될 steps 에 담기는 값과 **같은 객체**를 흘린다. */
  step(step: StackCascadeStep): void
}

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
 *
 * ── GitHub 스택의 서버측 rebase (실측 확인) ─────────────────────────────────
 * GitHub 이 stacked pull request 의 아래층을 병합하면, 위 브랜치들의 **원격 ref 를 서버에서
 * 다시 쓴다**(체인 전체를 캐스케이딩 rebase). 로컬 worktree 는 rebase 이전 커밋을 든 채 깨끗하게
 * 남으므로 "할 일 없음"처럼 보이는데, 그대로 rebase 하면 GitHub 의 결과를 덮어써 위 레이어가
 * 자기만의 diff 를 잃는다. detectRemoteDivergence 가 그 자리를 지킨다 — 자세한 근거는 그 위
 * 주석에 있다. **force-with-lease 는 이 경우를 막지 못한다.**
 */

// ── 리모트 갈라짐 가드 ──────────────────────────────────────────────────────
//
// **`--force-with-lease` 는 여기서 아무것도 막아 주지 않는다.** 이 검사가 명시적이어야 하는
// 이유가 그것이다. 아래 실측(2026-08-12, stacked-pr-playground #46–48 / 스택 #49)을 근거로 한다.
//
// 1) GitHub 은 스택 아래층이 병합되면 **위 브랜치들의 원격 ref 를 서버에서 실제로 다시 쓴다**
//    (체인 전체를 캐스케이딩 rebase 한다). 로컬 worktree 는 rebase **이전** 커밋을 든 채,
//    미커밋 변경이 없으니 **깨끗하다** — 지금 코드에는 "할 일 없음"으로 읽힌다.
// 2) 그 상태로 restackOnto 를 부르면 lease 는 무력하다. restackOnto 가 push 직전에 스스로
//    `fetchRemote()` 를 부르므로(git.ts) lease 기준값이 GitHub 이 방금 쓴 ref 로 갱신되고,
//    force-push 가 **성공한다**. 캐스케이드는 oldBase 를 넘기니 needsRebase 도 항상 true 다.
// 3) 피해는 "충돌을 두 번 푼다" 정도가 아니다. 옛 커밋을 재생해 GitHub 의 rebase 를 덮어쓰므로
//    **위 레이어가 자기만의 diff 를 잃는다** — 아래층 변경까지 자기 PR 에 다시 끌어안는다
//    (실측: PR 이 파일 1개에서 2개로 늘었다). 스택이 스택인 이유가 그대로 무너진다.
//
// 그래서 lease 를 믿지 않고 push 이전 단계에서 직접 물어본다. 판정되면 rebase 하지 않는다.
// 자동 화해도 하지 않는다 — 대개는 GitHub 쪽이 옳지만(그쪽이 이미 제대로 rebase 했다),
// 일반적으로는 협업자의 force-push 일 수도 있어 어느 쪽을 버릴지는 사람이 정할 문제다.
//
// (리뷰 코멘트 유실은 위험이 아니다 — GitHub 자신의 rebase 와 외부 force-push 양쪽에서
// 재앵커링되는 것을 확인했다. 문제는 오로지 diff 가 뒤섞이는 것이다.)

/**
 * 리모트 브랜치와 로컬 tip 의 관계.
 * - in-sync: 같다.
 * - local-ahead: 리모트가 로컬 tip 의 조상이다(= 아직 push 하지 않은 커밋만 있다. 정상).
 * - diverged: 조상도 아니고 같지도 않다 — 내가 하지 않은 push 가 리모트에 있다.
 * - unknown: 리모트에 브랜치가 없거나(아직 push 전) 조회하지 못했다. 판정하지 않는다.
 */
export type RemoteState = 'in-sync' | 'local-ahead' | 'diverged' | 'unknown'

/**
 * "내가 push 하지 않았는데 리모트가 움직였는가"를 판정한다.
 *
 * "내가 push 했는지"를 따로 기록해 둘 필요는 없다. Wooi 의 push 는 rebase 직후의
 * force-with-lease 뿐이라, 그게 성공했다면 리모트는 로컬 tip 과 **같다**. 즉 같지도 않고
 * 조상도 아니라는 사실 자체가 "내가 만든 상태가 아니다"의 충분한 증거다.
 */
export async function detectRemoteDivergence(
  worktreePath: string,
  branch: string
): Promise<RemoteState> {
  // `ls-remote` 로 리모트에 **직접** 묻는다. `origin/<branch>` 는 마지막 fetch 시점의 사진이라
  // "내가 모르는 사이에 움직였나"에 답할 수 없고, 하필 restackOnto 가 push 직전에 fetch 하므로
  // 추적 ref 를 믿으면 정확히 놓쳐야 할 순간에 놓친다.
  const remote = await remoteTipSha(worktreePath, branch).catch(() => null)
  // 리모트에 브랜치가 없거나(아직 push 전) 물어보지 못했다. 막을 근거가 없고, 막을 필요도 없다
  // — 전자는 restackOnto 가 push 자체를 건너뛰고, 후자(네트워크 불통)는 push 도 실패한다.
  if (!remote) return 'unknown'
  const local = await revParse(worktreePath, branch).catch(() => null)
  if (!local) return 'unknown'
  if (remote === local) return 'in-sync'
  // 리모트 sha 를 우리가 아예 모르면 fetch 한 적 없는 히스토리다 → 조상 판정 자체가 불가능하고,
  // 그 사실이 곧 갈라짐이다(merge-base 를 그냥 부르면 unknown revision 으로 실패한다).
  if (!(await hasCommit(worktreePath, remote).catch(() => false))) return 'diverged'
  return (await isAncestor(worktreePath, remote, local).catch(() => false))
    ? 'local-ahead'
    : 'diverged'
}

/**
 * 갈라짐을 사용자에게 설명하는 문구. 캐스케이드(자동)와 수동 restack 이 같은 말을 하도록 한 곳에
 * 둔다 — 같은 원인·같은 대처인데 경로에 따라 다르게 설명하면 사용자가 다른 문제로 읽는다.
 */
export function divergedMessage(branch: string): string {
  return (
    'the remote branch was rewritten by something other than Wooi — GitHub rebases the branches ' +
    'above a stacked pull request when a lower one merges. Rebasing here would replay your older ' +
    'commits over that and fold the merged layer back into this branch, so the rebase was skipped. ' +
    `Inspect it with 'git fetch origin ${branch}' and take the remote version ` +
    `('git reset --hard origin/${branch}') if GitHub is ahead.`
  )
}

/** 갈라짐을 캐스케이드 단계 결과로 옮긴다(모델 A·B 가 같은 문구를 쓴다). */
export function divergedStep(branch: string, prNumber: number | null): StackCascadeStep {
  return {
    branch,
    prNumber,
    kind: 'restack',
    status: 'diverged',
    message: divergedMessage(branch)
  }
}

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
  progress?: StackProgressSink
}): Promise<StackCascadeStep[]> {
  const { worktreePath, mergedBranch, newBase, entries } = opts
  const steps: StackCascadeStep[] = []
  const push = (step: StackCascadeStep): void => {
    steps.push(step)
    opts.progress?.step(step)
  }

  for (const e of entries) {
    // 병합된 브랜치를 직속 base 로 삼던 PR 만 옮긴다. 그 위는 base 가 그대로다.
    if (e.baseBranch !== mergedBranch) continue
    opts.progress?.start(e.branch, 'retarget')

    const selector = e.prNumber ?? e.branch
    const meta = await getPrMeta(worktreePath, selector).catch(() => null)
    if (!meta) {
      push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'retarget',
        status: e.prNumber ? 'failed' : 'skipped',
        message: e.prNumber ? `pull request #${e.prNumber} could not be read` : 'no pull request'
      })
      continue
    }

    if (meta.state === 'MERGED') {
      push({
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
      push(
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
      push({
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
    push({
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
  progress?: StackProgressSink
}): Promise<StackCascadeStep[]> {
  const { worktreePath, mergedBranch, newBase, entries, allEntries } = opts
  if (!entries.length) return []

  const clean = await isWorktreeClean(worktreePath).catch(() => false)
  if (!clean) {
    return entries.map((e) => {
      opts.progress?.start(e.branch, 'restack')
      const step: StackCascadeStep = {
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'restack',
        status: 'skipped',
        message: 'uncommitted changes in the worktree — rebase skipped, restack manually'
      }
      opts.progress?.step(step)
      return step
    })
  }

  const original = await currentBranch(worktreePath).catch(() => '')

  // rebase 로 각 브랜치 tip 이 바뀌므로, 그 전에 원래 tip 을 잡아 둔다(상위 브랜치의 oldBase 계산용).
  const oldTip = new Map<string, string>()
  for (const e of allEntries) {
    const sha = await revParse(worktreePath, e.branch)
    if (sha) oldTip.set(e.branch, sha)
  }

  const steps: StackCascadeStep[] = []
  const push = (step: StackCascadeStep): void => {
    steps.push(step)
    opts.progress?.step(step)
  }
  let halted: string | null = null
  // halted 와 따로 두는 이유: 충돌·에러는 워킹트리를 rebase 진행 상태로 남겨 원래 브랜치로
  // 되돌릴 수 없지만, 갈라짐은 아무것도 건드리지 않고 멈춘 것이라 되돌려 놓는 편이 낫다.
  let leftMidRebase = false

  for (const e of entries) {
    opts.progress?.start(e.branch, 'restack')
    if (halted) {
      push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'restack',
        status: 'skipped',
        message: `skipped after ${halted}`
      })
      continue
    }

    // 체크아웃보다 먼저 본다 — 갈라진 브랜치는 아예 건드리지 않는 것이 요점이라, 워킹트리를
    // 그 브랜치로 옮겨 놓지도 않는다. 위 브랜치들은 이 브랜치 tip 을 기준으로 쌓이므로,
    // 하나가 갈라졌으면 그 위도 전부 판단 근거를 잃는다 → 멈춘다.
    if ((await detectRemoteDivergence(worktreePath, e.branch)) === 'diverged') {
      push(divergedStep(e.branch, e.prNumber))
      halted = `${e.branch} diverged from its remote`
      continue
    }

    const directChild = e.baseBranch === mergedBranch
    const base = directChild ? newBase : e.baseBranch
    // oldBase: 직속 자식은 병합된 브랜치, 그 위는 자기 base 의 rebase 이전 tip.
    const oldBase = directChild ? mergedBranch : oldTip.get(e.baseBranch)

    const co = await checkoutBranch(worktreePath, e.branch)
    if (co.error) {
      push({
        branch: e.branch,
        prNumber: e.prNumber,
        kind: 'restack',
        status: 'failed',
        message: co.error
      })
      halted = `checkout of ${e.branch} failed`
      leftMidRebase = true
      continue
    }

    const r = await restackOnto(worktreePath, base, oldBase).catch((err): RestackResult => ({
      status: 'error',
      baseBranch: base,
      message: err instanceof Error ? err.message : String(err)
    }))
    push(stepFromRestack(e.branch, e.prNumber, r))

    // 충돌은 워킹트리를 rebase 진행 상태로 남긴다 — 이후 브랜치는 체크아웃조차 불가하므로 멈춘다.
    if (r.status === 'conflict') {
      halted = `rebase conflict on ${e.branch}`
      leftMidRebase = true
    } else if (r.status === 'error' || r.status === 'dirty') {
      halted = `rebase of ${e.branch} failed`
      leftMidRebase = true
    }
  }

  // 원래 브랜치로 되돌린다(병합돼 스택에서 빠질 브랜치였다면 그대로 둔다 — 호출부가 HEAD 를 보고 맞춘다).
  if (!leftMidRebase && original && original !== mergedBranch) {
    await checkoutBranch(worktreePath, original).catch(() => ({}))
  }

  return steps
}
