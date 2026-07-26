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
  isWorktreeClean: vi.fn(),
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
import { checkoutBranch, currentBranch, isWorktreeClean, restackOnto, revParse } from './git'
import { cascadeRetarget, cascadeRestackBranchStack } from './cascade'

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
})

describe('cascadeRetarget', () => {
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
