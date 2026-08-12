import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrMeta } from './github'
import type { RestackResult, StackedBranch } from '@shared/types'

vi.mock('./github', () => ({
  getPrMeta: vi.fn(),
  retargetPr: vi.fn(),
  reopenPr: vi.fn(),
  remoteRefExists: vi.fn(),
  restoreRemoteRef: vi.fn(),
  deleteRemoteRef: vi.fn()
}))

vi.mock('./git', () => ({
  checkoutBranch: vi.fn(),
  currentBranch: vi.fn(),
  hasCommit: vi.fn(),
  isAncestor: vi.fn(),
  isWorktreeClean: vi.fn(),
  remoteTipSha: vi.fn(),
  restackOnto: vi.fn(),
  revParse: vi.fn()
}))

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
import { cascadeRetarget, cascadeRestackBranchStack, detectRemoteDivergence } from './cascade'

const WT = '/tmp/wt'

function meta(over: Partial<PrMeta>): PrMeta {
  return {
    number: 2,
    state: 'OPEN',
    headRefName: 'b',
    baseRefName: 'a',
    baseRefOid: 'sha-a',
    ...over
  }
}

const entry = (branch: string, baseBranch: string, prNumber: number | null): StackedBranch => ({
  branch,
  baseBranch,
  prNumber
})

beforeEach(() => {
  vi.clearAllMocks()
  // 기본값은 "리모트에 브랜치가 없다" = 갈라짐 판정 안 함. 갈라짐을 다루지 않는 테스트가
  // 그 가드를 통과하도록, 각 테스트가 필요할 때만 덮어쓴다.
  vi.mocked(remoteTipSha).mockResolvedValue(null)
  vi.mocked(hasCommit).mockResolvedValue(true)
  vi.mocked(isAncestor).mockResolvedValue(true)
})

describe('cascadeRetarget', () => {
  it('streams starts in branch order and every returned step exactly once', async () => {
    vi.mocked(getPrMeta)
      .mockResolvedValueOnce(meta({ number: 2, baseRefName: 'a' }))
      .mockResolvedValueOnce(null)
    vi.mocked(retargetPr).mockResolvedValue({})
    const starts: Array<[string, string]> = []
    const streamed: unknown[] = []

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2), entry('c', 'a', 3)],
      progress: {
        start: (branch, kind) => starts.push([branch, kind]),
        step: (step) => streamed.push(step)
      }
    })

    expect(starts).toEqual([
      ['b', 'retarget'],
      ['c', 'retarget']
    ])
    expect(streamed).toEqual(steps)
  })

  it('retargets a child whose base is the merged branch', async () => {
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 2, baseRefName: 'a' }))
    vi.mocked(retargetPr).mockResolvedValue({})

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)]
    })

    expect(retargetPr).toHaveBeenCalledWith(WT, 'main', '2')
    expect(steps).toEqual([
      { branch: 'b', prNumber: 2, kind: 'retarget', status: 'ok', message: 'retargeted onto main' }
    ])
  })

  it('skips when GitHub already auto-retargeted (branch deleted at merge time)', async () => {
    // delete_branch_on_merge=true 면 GitHub 이 자식을 조부모로 옮기고 열어 둔다 — 할 일이 없다.
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 2, baseRefName: 'main' }))

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)]
    })

    expect(retargetPr).not.toHaveBeenCalled()
    expect(steps[0]).toMatchObject({ status: 'skipped', message: 'already based on main' })
  })

  it('leaves entries above the direct child alone', async () => {
    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('c', 'b', 3)] // base 가 병합 브랜치가 아니다
    })
    expect(getPrMeta).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('reports a retarget failure instead of swallowing it', async () => {
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 2, baseRefName: 'a' }))
    vi.mocked(retargetPr).mockResolvedValue({ error: 'gh: permission denied' })

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)]
    })

    expect(steps[0]).toMatchObject({ status: 'failed', message: 'gh: permission denied' })
  })

  it('recovers a child GitHub closed when the base branch was deleted', async () => {
    // 실측: base 브랜치를 (병합과 별개로) 지우면 GitHub 이 자식 PR 을 닫는다.
    // 닫힌 PR 은 base 변경도 reopen 도 거부되므로, base 를 되살린 뒤 reopen → retarget 해야 한다.
    vi.mocked(getPrMeta).mockResolvedValue(
      meta({ number: 30, state: 'CLOSED', baseRefName: 'a', baseRefOid: 'sha-a' })
    )
    vi.mocked(remoteRefExists).mockResolvedValue(false)
    vi.mocked(restoreRemoteRef).mockResolvedValue({})
    vi.mocked(reopenPr).mockResolvedValue({})
    vi.mocked(retargetPr).mockResolvedValue({})

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 30)]
    })

    // 순서가 핵심이다: 복원 → reopen → retarget → 발판 정리.
    expect(restoreRemoteRef).toHaveBeenCalledWith(WT, 'a', 'sha-a')
    expect(reopenPr).toHaveBeenCalledWith(WT, 30)
    expect(retargetPr).toHaveBeenCalledWith(WT, 'main', '30')
    expect(deleteRemoteRef).toHaveBeenCalledWith(WT, 'a')

    const order = [
      vi.mocked(restoreRemoteRef).mock.invocationCallOrder[0],
      vi.mocked(reopenPr).mock.invocationCallOrder[0],
      vi.mocked(retargetPr).mock.invocationCallOrder[0],
      vi.mocked(deleteRemoteRef).mock.invocationCallOrder[0]
    ]
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(steps[0]).toMatchObject({ kind: 'recover', status: 'ok' })
  })

  it('does not restore a base branch that still exists', async () => {
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 30, state: 'CLOSED', baseRefName: 'a' }))
    vi.mocked(remoteRefExists).mockResolvedValue(true)
    vi.mocked(reopenPr).mockResolvedValue({})
    vi.mocked(retargetPr).mockResolvedValue({})

    await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 30)]
    })

    expect(restoreRemoteRef).not.toHaveBeenCalled()
    // 우리가 만들지 않은 브랜치는 지우지 않는다.
    expect(deleteRemoteRef).not.toHaveBeenCalled()
  })

  it('rolls back the scaffold branch when reopen fails', async () => {
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 30, state: 'CLOSED', baseRefName: 'a' }))
    vi.mocked(remoteRefExists).mockResolvedValue(false)
    vi.mocked(restoreRemoteRef).mockResolvedValue({})
    vi.mocked(reopenPr).mockResolvedValue({ error: 'Could not open the pull request' })

    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 30)]
    })

    expect(deleteRemoteRef).toHaveBeenCalledWith(WT, 'a')
    expect(retargetPr).not.toHaveBeenCalled()
    expect(steps[0]).toMatchObject({ kind: 'recover', status: 'failed' })
  })

  it('skips an already merged child', async () => {
    vi.mocked(getPrMeta).mockResolvedValue(meta({ number: 2, state: 'MERGED' }))
    const steps = await cascadeRetarget({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)]
    })
    expect(steps[0]).toMatchObject({ status: 'skipped', message: 'already merged' })
    expect(retargetPr).not.toHaveBeenCalled()
  })
})

describe('cascadeRestackBranchStack', () => {
  it('reports dirty worktrees instead of silently skipping the rebase', async () => {
    vi.mocked(isWorktreeClean).mockResolvedValue(false)

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2)]
    })

    expect(steps[0]).toMatchObject({ status: 'skipped' })
    expect(steps[0].message).toMatch(/uncommitted changes/)
  })

  it('rebases the direct child onto the new base, dropping merged commits', async () => {
    vi.mocked(isWorktreeClean).mockResolvedValue(true)
    vi.mocked(currentBranch).mockResolvedValue('b')
    vi.mocked(revParse).mockResolvedValue('sha')
    vi.mocked(checkoutBranch).mockResolvedValue({})
    vi.mocked(restackOnto).mockResolvedValue({
      status: 'restacked',
      baseBranch: 'main',
      pushed: true
    } as RestackResult)

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2)]
    })

    // 직속 자식은 --onto main a 로 병합된 부모 커밋을 떨군다.
    expect(restackOnto).toHaveBeenCalledWith(WT, 'main', 'a')
    expect(steps[0]).toMatchObject({ status: 'ok' })
  })

  it('surfaces a rebase conflict and halts the rest of the stack', async () => {
    vi.mocked(isWorktreeClean).mockResolvedValue(true)
    vi.mocked(currentBranch).mockResolvedValue('b')
    vi.mocked(revParse).mockResolvedValue('sha')
    vi.mocked(checkoutBranch).mockResolvedValue({})
    vi.mocked(restackOnto).mockResolvedValue({
      status: 'conflict',
      baseBranch: 'main',
      conflictedFiles: ['src/x.ts']
    } as RestackResult)

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2), entry('c', 'b', 3)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)]
    })

    expect(steps[0]).toMatchObject({ status: 'conflict', conflictedFiles: ['src/x.ts'] })
    // 충돌은 워킹트리를 rebase 진행 상태로 남기므로 위쪽은 건드리지 않는다.
    expect(steps[1]).toMatchObject({ branch: 'c', status: 'skipped' })
    expect(restackOnto).toHaveBeenCalledTimes(1)
  })

  it('restores the original branch after a clean cascade', async () => {
    vi.mocked(isWorktreeClean).mockResolvedValue(true)
    vi.mocked(currentBranch).mockResolvedValue('c')
    vi.mocked(revParse).mockResolvedValue('sha')
    vi.mocked(checkoutBranch).mockResolvedValue({})
    vi.mocked(restackOnto).mockResolvedValue({ status: 'up-to-date', baseBranch: 'main' })

    await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)]
    })

    expect(vi.mocked(checkoutBranch).mock.calls.at(-1)).toEqual([WT, 'c'])
  })
})

describe('detectRemoteDivergence', () => {
  it('does not judge a branch that was never pushed', async () => {
    vi.mocked(remoteTipSha).mockResolvedValue(null)
    expect(await detectRemoteDivergence(WT, 'b')).toBe('unknown')
    // 리모트를 모르면 로컬을 읽어 볼 이유도 없다.
    expect(revParse).not.toHaveBeenCalled()
  })

  it('reads an identical remote as in sync', async () => {
    vi.mocked(remoteTipSha).mockResolvedValue('sha1')
    vi.mocked(revParse).mockResolvedValue('sha1')
    expect(await detectRemoteDivergence(WT, 'b')).toBe('in-sync')
  })

  it('reads unpushed local commits as local-ahead, not divergence', async () => {
    vi.mocked(remoteTipSha).mockResolvedValue('old')
    vi.mocked(revParse).mockResolvedValue('new')
    vi.mocked(hasCommit).mockResolvedValue(true)
    vi.mocked(isAncestor).mockResolvedValue(true)
    expect(await detectRemoteDivergence(WT, 'b')).toBe('local-ahead')
  })

  it('reads a remote that is not an ancestor as diverged', async () => {
    vi.mocked(remoteTipSha).mockResolvedValue('rewritten')
    vi.mocked(revParse).mockResolvedValue('local')
    vi.mocked(hasCommit).mockResolvedValue(true)
    vi.mocked(isAncestor).mockResolvedValue(false)
    expect(await detectRemoteDivergence(WT, 'b')).toBe('diverged')
  })

  it('treats a remote commit we have never seen as diverged without asking merge-base', async () => {
    // 우리가 모르는 객체로 merge-base 를 부르면 unknown revision 으로 실패한다 — 그 전에 끊는다.
    vi.mocked(remoteTipSha).mockResolvedValue('rewritten')
    vi.mocked(revParse).mockResolvedValue('local')
    vi.mocked(hasCommit).mockResolvedValue(false)
    expect(await detectRemoteDivergence(WT, 'b')).toBe('diverged')
    expect(isAncestor).not.toHaveBeenCalled()
  })
})

describe('cascadeRestackBranchStack — remote divergence guard', () => {
  /** 깨끗한 worktree 에서 리모트만 갈라진 상태를 만든다(서버가 브랜치를 다시 쓴 경우). */
  function divergedRemote(): void {
    vi.mocked(isWorktreeClean).mockResolvedValue(true)
    vi.mocked(currentBranch).mockResolvedValue('c')
    vi.mocked(revParse).mockResolvedValue('local')
    vi.mocked(checkoutBranch).mockResolvedValue({})
    vi.mocked(remoteTipSha).mockResolvedValue('rewritten')
    vi.mocked(hasCommit).mockResolvedValue(true)
    vi.mocked(isAncestor).mockResolvedValue(false)
  }

  // 이 케이스가 회귀하면 조용히 데이터가 상한다. restackOnto 는 push 직전에 스스로 fetch 하므로
  // --force-with-lease 가 GitHub 의 서버측 rebase 를 **막지 못한다**(실측). 즉 이 가드가 유일한
  // 방어선이고, "lease 가 알아서 거부할 것"이라는 이유로 걷어내면 안 된다.
  it('records diverged and skips the rebase on a clean worktree', async () => {
    divergedRemote()

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2)]
    })

    expect(steps[0]).toMatchObject({ branch: 'b', kind: 'restack', status: 'diverged' })
    // 깨끗해도 "할 일 없음"이 아니다 — rebase 도 체크아웃도 하지 않는다.
    expect(restackOnto).not.toHaveBeenCalled()
    expect(vi.mocked(checkoutBranch).mock.calls).not.toContainEqual([WT, 'b'])
  })

  it('halts the branches above it — their base is no longer trustworthy', async () => {
    divergedRemote()

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2), entry('c', 'b', 3)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)]
    })

    expect(steps[0]).toMatchObject({ branch: 'b', status: 'diverged' })
    expect(steps[1]).toMatchObject({ branch: 'c', status: 'skipped' })
    expect(steps[1].message).toMatch(/diverged/)
  })

  it('streams diverged and all following skipped steps in returned order', async () => {
    divergedRemote()
    const starts: Array<[string, string]> = []
    const streamed: unknown[] = []

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2), entry('c', 'b', 3)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)],
      progress: {
        start: (branch, kind) => starts.push([branch, kind]),
        step: (step) => streamed.push(step)
      }
    })

    expect(starts).toEqual([
      ['b', 'restack'],
      ['c', 'restack']
    ])
    expect(streamed).toEqual(steps)
    expect(streamed).toHaveLength(2)
  })

  it('still returns the worktree to its original branch — nothing was left mid-rebase', async () => {
    divergedRemote()

    await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)]
    })

    // 충돌과 달리 rebase 를 시작조차 하지 않았으므로 원래 브랜치로 되돌릴 수 있다.
    expect(vi.mocked(checkoutBranch).mock.calls.at(-1)).toEqual([WT, 'c'])
  })

  it('fires on the exact shape GitHub leaves behind: clean worktree, unknown remote commits', async () => {
    // 아래층이 병합되면 GitHub 이 위 브랜치를 서버에서 rebase 해 우리가 가진 적 없는 sha 를
    // 남긴다. 워킹트리는 깨끗하고 로컬 tip 은 그대로다 — 검사가 없으면 정상 rebase 로 읽힌다.
    vi.mocked(isWorktreeClean).mockResolvedValue(true)
    vi.mocked(currentBranch).mockResolvedValue('b')
    vi.mocked(revParse).mockResolvedValue('504d24f') // rebase 이전 로컬 tip
    vi.mocked(checkoutBranch).mockResolvedValue({})
    vi.mocked(remoteTipSha).mockResolvedValue('8ed4598') // GitHub 이 서버에서 다시 쓴 tip
    vi.mocked(hasCommit).mockResolvedValue(false) // fetch 한 적 없으니 로컬에 그 객체가 없다

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2)]
    })

    expect(steps[0]).toMatchObject({ status: 'diverged' })
    expect(restackOnto).not.toHaveBeenCalled()
  })

  it('rebases as usual when the remote is merely behind the local tip', async () => {
    divergedRemote()
    vi.mocked(isAncestor).mockResolvedValue(true) // local-ahead — 내가 아직 push 하지 않았을 뿐.
    vi.mocked(restackOnto).mockResolvedValue({
      status: 'restacked',
      baseBranch: 'main',
      pushed: true
    } as RestackResult)

    const steps = await cascadeRestackBranchStack({
      worktreePath: WT,
      mergedBranch: 'a',
      newBase: 'main',
      entries: [entry('b', 'a', 2)],
      allEntries: [entry('a', 'main', 1), entry('b', 'a', 2)]
    })

    expect(steps[0]).toMatchObject({ status: 'ok' })
    expect(restackOnto).toHaveBeenCalledWith(WT, 'main', 'a')
  })
})
