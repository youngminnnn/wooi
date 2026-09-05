import { describe, it, expect } from 'vitest'
import type {
  BaseMismatch,
  FileDiff,
  StackCascadeStep,
  StackedBranch,
  StackOpProgress,
  StackTrainPlan,
  WorkspaceDiff
} from '@shared/types'
import {
  branchStackDepths,
  buildStackLayers,
  diffTotals,
  reviewablePrNumbers,
  stackSummary,
  trainCellFor,
  type StackLayer,
  type StackLayerState
} from './stackView'
import { git, pr, workspace } from '../test/fixtures'

function layer(overrides: Partial<StackLayer> = {}): StackLayer {
  return {
    key: 'l1',
    workspaceId: 'w1',
    label: 'l1',
    branch: 'feat/l1',
    baseBranch: 'main',
    depth: 0,
    prNumber: null,
    parentKey: null,
    isAnchor: false,
    live: true,
    baseDrift: null,
    prBaseMismatch: null,
    ...overrides
  }
}

function layerState(overrides: Partial<StackLayerState> = {}): StackLayerState {
  return {
    pr: null,
    git: null,
    commits: null,
    diff: null,
    train: { state: 'none' },
    ...overrides
  }
}

describe('branchStackDepths', () => {
  it('main 을 향한 3단 체인의 깊이를 0,1,2 로 센다', () => {
    const entries: StackedBranch[] = [
      { branch: 'a', baseBranch: 'main', prNumber: 1 },
      { branch: 'b', baseBranch: 'a', prNumber: 2 },
      { branch: 'c', baseBranch: 'b', prNumber: 3 }
    ]
    const depths = branchStackDepths(entries)
    expect(depths.get('a')).toBe(0)
    expect(depths.get('b')).toBe(1)
    expect(depths.get('c')).toBe(2)
  })

  /** 바닥 엔트리의 baseBranch(main)는 엔트리 목록에 없으므로 깊이는 0이다. */
  it('바닥 엔트리의 base 는 목록에 없어 깊이 0 이다', () => {
    const entries: StackedBranch[] = [{ branch: 'a', baseBranch: 'main', prNumber: 1 }]
    expect(branchStackDepths(entries).get('a')).toBe(0)
  })

  it('순환·자기참조 엔트리에서 멈추지 않는다', () => {
    const entries: StackedBranch[] = [
      { branch: 'x', baseBranch: 'y', prNumber: null },
      { branch: 'y', baseBranch: 'x', prNumber: null }
    ]
    const depths = branchStackDepths(entries)
    expect(depths.get('x')).toBe(2)
    expect(depths.get('y')).toBe(2)
  })
})

describe('buildStackLayers', () => {
  describe('모델 A(워크스페이스 체인)', () => {
    const root = workspace({
      id: 'root',
      branch: 'feat/schema',
      baseBranch: 'main',
      parentWorkspaceId: null
    })
    const mid = workspace({
      id: 'mid',
      branch: 'feat/engine',
      baseBranch: 'feat/schema',
      parentWorkspaceId: 'root'
    })
    const top = workspace({
      id: 'top',
      branch: 'feat/ui',
      baseBranch: 'feat/engine',
      parentWorkspaceId: 'mid'
    })

    it('바닥→꼭대기 순으로 층을 펴고 앵커만 isAnchor 다', () => {
      const layers = buildStackLayers([root, mid, top], 'top')
      expect(layers.map((l) => l.key)).toEqual(['root', 'mid', 'top'])
      expect(layers.map((l) => l.depth)).toEqual([0, 1, 2])
      expect(layers.every((l) => l.live)).toBe(true)
      expect(layers.every((l) => l.baseDrift === null)).toBe(true)
      expect(layers.map((l) => l.parentKey)).toEqual([null, 'root', 'mid'])
      expect(layers.map((l) => l.isAnchor)).toEqual([false, false, true])
    })

    it('baseBranch 가 부모의 branch 와 다르면 baseDrift 를 기록한다', () => {
      const driftedMid = workspace({ ...mid, baseBranch: 'main' })
      const layers = buildStackLayers([root, driftedMid, top], 'top')
      const midLayer = layers.find((l) => l.key === 'mid')
      expect(midLayer?.baseDrift).toEqual({ expected: 'feat/schema', actual: 'main' })
    })

    it('아카이브된 멤버와 다른 레포 멤버는 뺀다', () => {
      const archivedChild = workspace({
        id: 'archived-child',
        branch: 'feat/dead',
        baseBranch: 'feat/ui',
        parentWorkspaceId: 'top',
        archived: true
      })
      const otherRepoChild = workspace({
        id: 'other-repo-child',
        repoId: 'repo-2',
        branch: 'feat/other',
        baseBranch: 'main',
        parentWorkspaceId: 'root'
      })
      const layers = buildStackLayers([root, mid, top, archivedChild, otherRepoChild], 'top')
      expect(layers.map((l) => l.key)).toEqual(['root', 'mid', 'top'])
    })
  })

  describe('모델 B(worktree 안 브랜치 스택)', () => {
    const entries: StackedBranch[] = [
      { branch: 'feat/a', baseBranch: 'main', prNumber: 101 },
      { branch: 'feat/b', baseBranch: 'feat/a', prNumber: 102 },
      { branch: 'feat/c', baseBranch: 'feat/b', prNumber: 103 }
    ]
    const mismatch: BaseMismatch = { prNumber: 102, prBase: 'main', expectedBase: 'feat/a' }
    const ws = workspace({
      id: 'ws1',
      branch: 'feat/b',
      baseBranch: 'feat/a',
      prNumber: 102,
      stack: entries,
      baseMismatch: mismatch
    })

    it('세 층 모두 같은 workspaceId 를 공유하고, 체크아웃된 브랜치만 live 다', () => {
      const layers = buildStackLayers([ws], 'ws1')
      expect(layers).toHaveLength(3)
      expect(layers.every((l) => l.workspaceId === 'ws1')).toBe(true)
      expect(layers.map((l) => l.live)).toEqual([false, true, false])
      expect(layers.every((l) => l.baseDrift === null)).toBe(true)
    })

    it('prBaseMismatch 는 체크아웃된(live) 층에만 실린다', () => {
      const layers = buildStackLayers([ws], 'ws1')
      expect(layers.map((l) => l.prBaseMismatch)).toEqual([null, mismatch, null])
    })
  })

  it('모르는 앵커 id 는 빈 배열이다', () => {
    expect(buildStackLayers([workspace({ id: 'a' })], 'nope')).toEqual([])
  })
})

describe('diffTotals', () => {
  it('null·undefined 는 그대로 null 이다', () => {
    expect(diffTotals(null)).toBeNull()
    expect(diffTotals(undefined)).toBeNull()
  })

  it('파일들의 +/- 를 합산하고 파일 수를 센다', () => {
    const files: FileDiff[] = [
      { path: 'a.ts', status: 'modified', additions: 3, deletions: 1, patch: '', binary: false },
      { path: 'b.ts', status: 'added', additions: 10, deletions: 0, patch: '', binary: false }
    ]
    const diff: WorkspaceDiff = { baseBranch: 'main', files }
    expect(diffTotals(diff)).toEqual({ files: 2, additions: 13, deletions: 1 })
  })
})

describe('trainCellFor', () => {
  function progress(overrides: Partial<StackOpProgress> = {}): StackOpProgress {
    return {
      workspaceId: 'w1',
      kind: 'train',
      total: null,
      done: [],
      current: null,
      finished: false,
      startedAt: 0,
      ...overrides
    }
  }
  function step(overrides: Partial<StackCascadeStep> = {}): StackCascadeStep {
    return { branch: 'feat/a', prNumber: 1, kind: 'merge', status: 'ok', ...overrides }
  }
  function plan(layers: StackTrainPlan['layers']): StackTrainPlan {
    return { layers, mergeableCount: layers.length, forcePushCount: 0, forcePushBranches: [] }
  }

  it('지금 도는 단계면 running 이다', () => {
    const p = progress({ current: { branch: 'feat/a', kind: 'restack' }, finished: false })
    expect(trainCellFor('feat/a', null, p)).toEqual({ state: 'running', kind: 'restack' })
  })

  it('끝난 단계가 있으면 계획을 이긴다', () => {
    const p = progress({
      finished: true,
      done: [step({ status: 'ok', message: 'Rebased onto main' })]
    })
    const pl = plan([{ branch: 'feat/a', prNumber: 1, state: null, blockedReason: 'conflict' }])
    expect(trainCellFor('feat/a', pl, p)).toEqual({
      state: 'done',
      status: 'ok',
      message: 'Rebased onto main'
    })
  })

  it('메시지 없는 done 단계는 message 키를 만들지 않는다', () => {
    const p = progress({ finished: true, done: [step({ status: 'ok' })] })
    const result = trainCellFor('feat/a', null, p)
    expect(result).toEqual({ state: 'done', status: 'ok' })
    expect(result).not.toHaveProperty('message')
  })

  it('계획에도 있고 진행에도 있으면 done 이 이긴다', () => {
    const p = progress({ finished: true, done: [step({ status: 'failed' })] })
    const pl = plan([{ branch: 'feat/a', prNumber: 1, state: null, blockedReason: null }])
    expect(trainCellFor('feat/a', pl, p)).toMatchObject({ state: 'done', status: 'failed' })
  })

  it('계획뿐이면 blockedReason 유무로 blocked/ready 를 가른다', () => {
    const blockedPlan = plan([
      { branch: 'feat/a', prNumber: 1, state: null, blockedReason: 'CI failing' }
    ])
    expect(trainCellFor('feat/a', blockedPlan, null)).toEqual({
      state: 'blocked',
      reason: 'CI failing'
    })

    const readyPlan = plan([{ branch: 'feat/a', prNumber: 1, state: null, blockedReason: null }])
    expect(trainCellFor('feat/a', readyPlan, null)).toEqual({ state: 'ready' })
  })

  it('계획에도 없고 진행도 없으면 none 이다', () => {
    expect(trainCellFor('feat/a', null, null)).toEqual({ state: 'none' })
    expect(trainCellFor('feat/a', plan([]), progress())).toEqual({ state: 'none' })
  })

  // 기다리는 동안은 done 도 current 도 늘지 않는다. 계획의 'ready' 로 되돌아가면 그 층은
  // "아직 시작도 안 했다" 로 읽히고, 사용자는 트레인이 멎었다고 본다.
  it('CI 를 기다리는 층은 계획 상태보다 대기를 먼저 보여 준다', () => {
    const readyPlan = plan([{ branch: 'feat/a', prNumber: 1, state: null, blockedReason: null }])
    const p = progress({
      waiting: { branch: 'feat/a', note: 'Checks are still running.', since: 1 }
    })
    expect(trainCellFor('feat/a', readyPlan, p)).toEqual({
      state: 'waiting',
      note: 'Checks are still running.'
    })
  })

  it('같은 브랜치에 done 단계가 여럿이면 마지막 것을 쓴다', () => {
    const p = progress({
      finished: true,
      done: [step({ status: 'ok' }), step({ status: 'conflict', message: 'retry needed' })]
    })
    expect(trainCellFor('feat/a', null, p)).toEqual({
      state: 'done',
      status: 'conflict',
      message: 'retry needed'
    })
  })
})

describe('stackSummary', () => {
  it('PR·drift·behind·blocked·증감을 층별로 집계한다', () => {
    const layers = [
      layer({ key: 'a', prNumber: 1 }),
      layer({ key: 'b', prNumber: 2, baseDrift: { expected: 'x', actual: 'y' } }),
      layer({
        key: 'c',
        prNumber: 3,
        prBaseMismatch: { prNumber: 3, prBase: 'main', expectedBase: 'b' }
      }),
      layer({ key: 'd', prNumber: 4 })
    ]
    const states: Record<string, StackLayerState | undefined> = {
      // a: 상태 자체가 없다 — undefined 로 남아 missingPr 로 세어져야 한다.
      b: layerState({
        pr: pr('open'),
        git: git({ behind: 2 }),
        diff: { files: 1, additions: 5, deletions: 2 },
        train: { state: 'blocked', reason: 'CI failing' }
      }),
      c: layerState({ pr: pr('merged') }),
      d: layerState({ pr: null, diff: { files: 1, additions: 3, deletions: 1 } })
    }

    expect(stackSummary(layers, states)).toEqual({
      layers: 4,
      openPrs: 1,
      missingPrs: 2,
      drifted: 2,
      behind: 1,
      blocked: 1,
      additions: 8,
      deletions: 3
    })
  })
})

describe('reviewablePrNumbers', () => {
  it('아래→위 순서로, 병합·닫힘·PR 없음을 빼고 뽑는다', () => {
    const layers = [
      layer({ key: 'a' }),
      layer({ key: 'b' }),
      layer({ key: 'c' }),
      layer({ key: 'd' }),
      layer({ key: 'e' })
    ]
    const states: Record<string, StackLayerState | undefined> = {
      b: layerState({ pr: pr('open', { number: 2 }) }),
      c: layerState({ pr: pr('merged', { number: 3 }) }),
      d: layerState({ pr: pr('closed', { number: 4 }) }),
      e: layerState({ pr: pr('approved', { number: 5 }) })
    }
    expect(reviewablePrNumbers(layers, states)).toEqual([2, 5])
  })
})
