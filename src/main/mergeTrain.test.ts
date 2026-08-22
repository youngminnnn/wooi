import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrStatus, StackCascadeStep } from '@shared/types'
import type { PrMeta } from './github'
import type { RemoteState } from './cascade'
import { planMergeTrain, runMergeTrain, type MergeTrainDeps, type TrainLayer } from './mergeTrain'

const layers: TrainLayer[] = ['bottom', 'middle', 'top'].map((branch, index) => ({
  workspaceId: `w${index}`,
  worktreePath: `/tmp/${branch}`,
  branch,
  prNumber: index + 1
}))

const status = (number: number, state: PrStatus['state'] = 'approved'): PrStatus => ({
  number,
  state,
  url: `https://example.test/${number}`,
  title: `PR ${number}`,
  label: state,
  needsBaseUpdate: false
})

const meta = (number: number, state = 'OPEN'): PrMeta => ({
  number,
  state,
  headRefName: layers[number - 1]?.branch ?? 'branch',
  baseRefName: number === 1 ? 'main' : layers[number - 2].branch,
  baseRefOid: `base-${number}`
})

let deps: MergeTrainDeps

beforeEach(() => {
  deps = {
    getPrStatus: vi.fn(async (_path, branch) =>
      status(layers.findIndex((l) => l.branch === branch) + 1)
    ),
    getPrMeta: vi.fn(async (_path, selector) => meta(Number(selector))),
    getPrHeadSha: vi.fn(async (_path, number) => `abcdef${number}`),
    isWorktreeClean: vi.fn(async () => true),
    detectRemoteDivergence: vi.fn(async (): Promise<RemoteState> => 'in-sync'),
    mergePr: vi.fn(async () => ({})),
    runCascade: vi.fn(async () => ({ steps: [] })),
    sleep: vi.fn(async () => {})
  }
})

describe('planMergeTrain', () => {
  it('plans a clean three-layer stack and says what one approval buys', async () => {
    const plan = await planMergeTrain({ layers, forcePushBranches: ['middle', 'top'] }, deps)
    expect(plan.mergeableCount).toBe(3)
    expect(plan.layers.every((layer) => layer.blockedReason === null)).toBe(true)
    expect(plan.forcePushCount).toBe(2)
    expect(plan.forcePushBranches).toEqual(['middle', 'top'])
  })

  it.each([
    ['draft', 'Still a draft.'],
    ['ci_failed', 'Checks failed.']
  ] as const)('stops the mergeable prefix at a middle %s', async (state, reason) => {
    vi.mocked(deps.getPrStatus)
      .mockResolvedValueOnce(status(1))
      .mockResolvedValueOnce(status(2, state))
      .mockResolvedValueOnce(status(3))
    const plan = await planMergeTrain({ layers, forcePushBranches: [] }, deps)
    expect(plan.mergeableCount).toBe(1)
    expect(plan.layers[1].blockedReason).toBe(reason)
    expect(plan.layers[2].state).toBe('approved')
  })

  it('blocks a dirty bottom worktree', async () => {
    vi.mocked(deps.isWorktreeClean).mockResolvedValueOnce(false)
    const plan = await planMergeTrain({ layers, forcePushBranches: [] }, deps)
    expect(plan.mergeableCount).toBe(0)
    expect(plan.layers[0].blockedReason).toBe('Uncommitted changes in the worktree.')
  })
})

function mergedMetaSequence(): void {
  vi.mocked(deps.getPrMeta)
    .mockImplementation(async (_path, selector) => meta(Number(selector)))
    .mockResolvedValueOnce(meta(1))
    .mockResolvedValueOnce(meta(1, 'MERGED'))
}

describe('runMergeTrain', () => {
  it('stops at a diverged cascade step and never merges the layer above', async () => {
    // 이 회귀는 GitHub 의 서버측 rebase 위에 옛 커밋을 덮어써 위층 diff 를 잃게 하므로 가장 중요하다.
    mergedMetaSequence()
    const diverged: StackCascadeStep = {
      branch: 'middle',
      prNumber: 2,
      kind: 'restack',
      status: 'diverged',
      message: 'remote rewritten'
    }
    vi.mocked(deps.runCascade).mockResolvedValueOnce({ steps: [diverged] })
    const result = await runMergeTrain(
      {
        layers,
        method: 'squash',
        expectedHeadShas: { bottom: 'abcdef1', middle: 'abcdef2', top: 'abcdef3' }
      },
      deps
    )
    expect(result.stoppedAt?.branch).toBe('middle')
    expect(deps.mergePr).toHaveBeenCalledTimes(1)
  })

  it('stops on a cascade conflict', async () => {
    mergedMetaSequence()
    vi.mocked(deps.runCascade).mockResolvedValueOnce({
      steps: [{ branch: 'middle', prNumber: 2, kind: 'restack', status: 'conflict' }]
    })
    const result = await runMergeTrain(
      { layers, method: 'merge', expectedHeadShas: { bottom: 'abcdef1' } },
      deps
    )
    expect(result.stoppedAt?.branch).toBe('middle')
    expect(deps.mergePr).toHaveBeenCalledTimes(1)
  })

  it('stops on a failed merge', async () => {
    vi.mocked(deps.mergePr).mockResolvedValueOnce({ error: 'merge denied' })
    const result = await runMergeTrain(
      { layers, method: 'merge', expectedHeadShas: { bottom: 'abcdef1' } },
      deps
    )
    expect(result.steps[0]).toMatchObject({ kind: 'merge', status: 'failed' })
    expect(deps.runCascade).not.toHaveBeenCalled()
  })

  it('stops before merging when the planned head changed', async () => {
    vi.mocked(deps.getPrHeadSha).mockResolvedValueOnce('9999999')
    const result = await runMergeTrain(
      { layers, method: 'merge', expectedHeadShas: { bottom: 'abcdef1' } },
      deps
    )
    expect(result.stoppedAt?.reason).toContain('9999999')
    expect(deps.mergePr).not.toHaveBeenCalled()
  })

  it('reports a failed merge step when GitHub reflection times out', async () => {
    const result = await runMergeTrain(
      { layers, method: 'merge', expectedHeadShas: { bottom: 'abcdef1' }, mergeWaitMs: 0 },
      deps
    )
    expect(result.steps[0]).toMatchObject({ kind: 'merge', status: 'failed' })
    expect(deps.runCascade).not.toHaveBeenCalled()
  })

  it('skips an already merged layer and continues', async () => {
    vi.mocked(deps.getPrMeta)
      .mockResolvedValueOnce(meta(1, 'MERGED'))
      .mockResolvedValueOnce(meta(2))
      .mockResolvedValueOnce(meta(2, 'MERGED'))
      .mockResolvedValueOnce(meta(3))
      .mockResolvedValueOnce(meta(3, 'MERGED'))
    const result = await runMergeTrain(
      { layers, method: 'squash', expectedHeadShas: { middle: 'abcdef2', top: 'abcdef3' } },
      deps
    )
    expect(result.steps[0]).toMatchObject({ branch: 'bottom', status: 'skipped' })
    expect(result.mergedPrs).toEqual([2, 3])
  })

  // 계획 대조는 "계획을 세운 뒤 남이 밀어 넣었나"를 묻는 것이지, 우리가 방금 한 일을 묻는 것이
  // 아니다. 아래층을 머지하면 캐스케이드가 위층을 새 base 위로 밀어 올리므로 그 층의 head SHA 는
  // 반드시 달라진다 — 그것까지 막으면 트레인은 언제나 첫 층 다음에서 멈춘다(= 기능이 없는 것과 같다).
  it('keeps going when its own cascade moved the layer above', async () => {
    const seen = new Map<number, number>()
    vi.mocked(deps.getPrMeta).mockImplementation(async (_path, selector) => {
      const number = Number(selector)
      const times = (seen.get(number) ?? 0) + 1
      seen.set(number, times)
      return meta(number, times > 1 ? 'MERGED' : 'OPEN')
    })
    vi.mocked(deps.runCascade).mockImplementation(async (_id, mergedBranch) => ({
      steps: [
        {
          branch: mergedBranch === 'bottom' ? 'middle' : 'top',
          prNumber: mergedBranch === 'bottom' ? 2 : 3,
          kind: 'restack',
          status: 'ok'
        }
      ]
    }))
    // 위층은 우리가 rebase 해 push 했으므로 계획 시점 SHA 와 다르다.
    vi.mocked(deps.getPrHeadSha).mockImplementation(async (_path, number) =>
      number === 1 ? 'abcdef1' : `rebased-${number}`
    )

    const result = await runMergeTrain(
      {
        layers,
        method: 'squash',
        expectedHeadShas: { bottom: 'abcdef1', middle: 'abcdef2', top: 'abcdef3' }
      },
      deps
    )

    expect(result.stoppedAt).toBeNull()
    expect(result.mergedPrs).toEqual([1, 2, 3])
  })
})
