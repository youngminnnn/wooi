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

  // CI 가 도는 층에서 계획이 끊기면, 정작 트레인을 걸고 싶은 순간(방금 push 해 CI 가 도는 때)에
  // 버튼이 사라진다. 실행은 기다렸다 머지하므로 계획도 그 층을 세어야 앞뒤가 맞는다.
  it('counts a layer whose checks are still running instead of stopping the prefix', async () => {
    vi.mocked(deps.getPrStatus).mockImplementation(async (_path, branch) => {
      const number = layers.findIndex((l) => l.branch === branch) + 1
      return status(number, branch === 'middle' ? 'ci_pending' : 'approved')
    })

    const plan = await planMergeTrain({ layers, forcePushBranches: [] }, deps)

    expect(plan.mergeableCount).toBe(3)
    expect(plan.layers.every((layer) => layer.blockedReason === null)).toBe(true)
    expect(plan.layers[1].waitReason).toBe('Checks are still running.')
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

  // 스택 최하단에서 건 트레인은 층이 하나다. 머지 한 번과 그 위 전부를 밀어 올리는 캐스케이드가
  // 남는데, 그건 prMerge 가 일부러 하지 않는 일이라 트레인만의 경로다 — 막을 이유가 없다.
  it('runs a one-layer train: merges the bottom and cascades the rest', async () => {
    const seen = new Map<number, number>()
    vi.mocked(deps.getPrMeta).mockImplementation(async (_path, selector) => {
      const number = Number(selector)
      const times = (seen.get(number) ?? 0) + 1
      seen.set(number, times)
      return meta(number, times > 1 ? 'MERGED' : 'OPEN')
    })
    vi.mocked(deps.runCascade).mockResolvedValue({
      steps: [{ branch: 'middle', prNumber: 2, kind: 'restack', status: 'ok' }]
    })

    const result = await runMergeTrain(
      { layers: [layers[0]], method: 'squash', expectedHeadShas: { bottom: 'abcdef1' } },
      deps
    )

    expect(result.stoppedAt).toBeNull()
    expect(result.mergedPrs).toEqual([1])
    expect(deps.runCascade).toHaveBeenCalledWith('w0', 'bottom', 'main', undefined)
  })
})

describe('runMergeTrain — waiting for checks', () => {
  const shas = { bottom: 'abcdef1', middle: 'abcdef2', top: 'abcdef3' }
  const mergeOnSecondLook = (): void => {
    const seen = new Map<number, number>()
    vi.mocked(deps.getPrMeta).mockImplementation(async (_path, selector) => {
      const number = Number(selector)
      const times = (seen.get(number) ?? 0) + 1
      seen.set(number, times)
      return meta(number, times > 1 ? 'MERGED' : 'OPEN')
    })
  }

  // 캐스케이드가 위층을 force-push 하면 그 층 CI 는 처음부터 다시 돈다. 이걸 차단으로 읽으면
  // 트레인은 사실상 항상 두 번째 층에서 멈춘다 — 기다리는 것이 트레인의 일이다.
  it('waits while checks are running, then merges', async () => {
    mergeOnSecondLook()
    let looks = 0
    vi.mocked(deps.getPrStatus).mockImplementation(async (_path, branch) => {
      const number = layers.findIndex((l) => l.branch === branch) + 1
      if (branch !== 'bottom') return status(number)
      looks++
      return status(1, looks <= 3 ? 'ci_pending' : 'approved')
    })

    const result = await runMergeTrain(
      {
        layers: [layers[0]],
        method: 'squash',
        expectedHeadShas: shas,
        pollDelaysMs: [0]
      },
      deps
    )

    expect(result.stoppedAt).toBeNull()
    expect(result.mergedPrs).toEqual([1])
    expect(deps.sleep).toHaveBeenCalledTimes(3)
  })

  // 사람이 손대야 끝나는 차단까지 기다리면 트레인은 영영 돌아오지 않는다.
  it.each([
    ['ci_failed', 'Checks failed.'],
    ['changes_requested', 'Changes requested.'],
    ['draft', 'Still a draft.']
  ] as const)('stops right away on %s without waiting', async (state, reason) => {
    vi.mocked(deps.getPrStatus).mockImplementation(async () => status(1, state))

    const result = await runMergeTrain(
      { layers: [layers[0]], method: 'squash', expectedHeadShas: shas, pollDelaysMs: [0] },
      deps
    )

    expect(result.stoppedAt).toEqual({ branch: 'bottom', reason })
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(deps.mergePr).not.toHaveBeenCalled()
  })

  // force-push 직후에는 새 head 의 체크가 아직 등록되지 않아 GitHub 가 BLOCKED → review_required
  // 를 돌려준다. 우리가 방금 민 층이면 그 판정을 잠깐 유보해야 헛되이 멈추지 않는다.
  it('rides out review_required on a layer it just force-pushed', async () => {
    mergeOnSecondLook()
    const looks = new Map<string, number>()
    vi.mocked(deps.getPrStatus).mockImplementation(async (_path, branch) => {
      const number = layers.findIndex((l) => l.branch === branch) + 1
      const times = (looks.get(branch) ?? 0) + 1
      looks.set(branch, times)
      if (branch !== 'middle') return status(number)
      // 등록 전 두 번은 BLOCKED 로 보이고, 그다음 체크가 붙고, 통과한다.
      if (times <= 2) return status(2, 'review_required')
      if (times === 3) return status(2, 'ci_pending')
      return status(2)
    })
    vi.mocked(deps.runCascade).mockResolvedValue({
      steps: [{ branch: 'middle', prNumber: 2, kind: 'restack', status: 'ok' }]
    })
    vi.mocked(deps.getPrHeadSha).mockImplementation(async (_path, number) =>
      number === 1 ? 'abcdef1' : `rebased-${number}`
    )

    const result = await runMergeTrain(
      {
        layers: [layers[0], layers[1]],
        method: 'squash',
        expectedHeadShas: shas,
        pollDelaysMs: [1],
        settleMs: 100
      },
      deps
    )

    expect(result.stoppedAt).toBeNull()
    expect(result.mergedPrs).toEqual([1, 2])
  })

  // 우리가 밀지 않은 층의 review_required 는 진짜 리뷰 요구다 — 유보할 이유가 없다.
  it('stops on review_required for a layer it did not push', async () => {
    vi.mocked(deps.getPrStatus).mockImplementation(async () => status(1, 'review_required'))

    const result = await runMergeTrain(
      { layers: [layers[0]], method: 'squash', expectedHeadShas: shas, pollDelaysMs: [1] },
      deps
    )

    // 바닥 층은 이 실행이 민 적이 없으므로 유보 없이 바로 멈춘다.
    expect(result.stoppedAt).toEqual({ branch: 'bottom', reason: 'Review required.' })
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('gives up once the settle window passes', async () => {
    mergeOnSecondLook()
    vi.mocked(deps.getPrStatus).mockImplementation(async (_path, branch) =>
      branch === 'middle' ? status(2, 'review_required') : status(1)
    )
    vi.mocked(deps.runCascade).mockResolvedValue({
      steps: [{ branch: 'middle', prNumber: 2, kind: 'restack', status: 'ok' }]
    })
    vi.mocked(deps.getPrHeadSha).mockImplementation(async (_path, number) =>
      number === 1 ? 'abcdef1' : `rebased-${number}`
    )

    const result = await runMergeTrain(
      {
        layers: [layers[0], layers[1]],
        method: 'squash',
        expectedHeadShas: shas,
        pollDelaysMs: [1],
        settleMs: 3
      },
      deps
    )

    expect(result.mergedPrs).toEqual([1])
    expect(result.stoppedAt).toEqual({ branch: 'middle', reason: 'Review required.' })
  })

  it('stops without merging anything when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runMergeTrain(
      {
        layers,
        method: 'squash',
        expectedHeadShas: shas,
        signal: controller.signal
      },
      deps
    )

    expect(result.canceled).toBe(true)
    expect(result.stoppedAt).toEqual({ branch: 'bottom', reason: 'Canceled.' })
    expect(deps.mergePr).not.toHaveBeenCalled()
  })

  it('cancels mid-wait and keeps what it already merged', async () => {
    mergeOnSecondLook()
    const controller = new AbortController()
    let looks = 0
    vi.mocked(deps.getPrStatus).mockImplementation(async (_path, branch) => {
      const number = layers.findIndex((l) => l.branch === branch) + 1
      if (branch !== 'middle') return status(number)
      looks++
      if (looks === 2) controller.abort()
      return status(2, 'ci_pending')
    })
    vi.mocked(deps.runCascade).mockResolvedValue({ steps: [] })

    const result = await runMergeTrain(
      {
        layers: [layers[0], layers[1]],
        method: 'squash',
        expectedHeadShas: shas,
        pollDelaysMs: [0],
        signal: controller.signal
      },
      deps
    )

    expect(result.mergedPrs).toEqual([1])
    expect(result.canceled).toBe(true)
    expect(result.stoppedAt).toEqual({ branch: 'middle', reason: 'Canceled.' })
  })
})
