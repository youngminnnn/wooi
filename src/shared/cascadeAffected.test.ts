import { describe, it, expect } from 'vitest'
import { cascadeAffectedBranches, cascadeProblems } from './types'
import type { StackedBranch, Workspace } from './types'

/** 테스트에 필요한 필드만 채운 워크스페이스. */
const ws = (over: Partial<Workspace> & Pick<Workspace, 'id' | 'branch'>): Workspace =>
  ({
    repoId: 'r',
    baseBranch: 'main',
    parentWorkspaceId: null,
    prNumber: null,
    archived: false,
    ...over
  }) as Workspace

const entry = (branch: string, baseBranch: string): StackedBranch => ({
  branch,
  baseBranch,
  prNumber: null
})

describe('cascadeAffectedBranches', () => {
  it('is empty for a standalone workspace — merging force-pushes nothing', () => {
    const a = ws({ id: 'a', branch: 'feat' })
    expect(cascadeAffectedBranches(a, [a])).toEqual([])
  })

  it('counts direct child workspaces (model A)', () => {
    const a = ws({ id: 'a', branch: 'a' })
    const b = ws({ id: 'b', branch: 'b', parentWorkspaceId: 'a', baseBranch: 'a' })
    const c = ws({ id: 'c', branch: 'c', parentWorkspaceId: 'b', baseBranch: 'b' })
    // 모델 A 는 직속 자식만 rebase 한다(손자는 자기 부모가 병합될 때 처리된다).
    expect(cascadeAffectedBranches(a, [a, b, c])).toEqual(['b'])
  })

  it('ignores archived children', () => {
    const a = ws({ id: 'a', branch: 'a' })
    const b = ws({ id: 'b', branch: 'b', parentWorkspaceId: 'a', archived: true })
    expect(cascadeAffectedBranches(a, [a, b])).toEqual([])
  })

  it('counts every entry above the current branch (model B)', () => {
    const stack = [entry('a', 'main'), entry('b', 'a'), entry('c', 'b')]
    const w = ws({ id: 'w', branch: 'a', stack })
    // 모델 B 는 위쪽 전부를 순차 rebase 하므로 손자까지 force-push 대상이다.
    expect(cascadeAffectedBranches(w, [w])).toEqual(['b', 'c'])
  })

  it('counts nothing when the top of a branch stack is merged', () => {
    const stack = [entry('a', 'main'), entry('b', 'a')]
    const w = ws({ id: 'w', branch: 'b', stack })
    expect(cascadeAffectedBranches(w, [w])).toEqual([])
  })
})

describe('cascadeProblems', () => {
  it('surfaces only conflicts and failures', () => {
    const problems = cascadeProblems({
      steps: [
        { branch: 'a', prNumber: 1, kind: 'retarget', status: 'ok' },
        { branch: 'b', prNumber: 2, kind: 'retarget', status: 'skipped' },
        { branch: 'c', prNumber: 3, kind: 'restack', status: 'conflict' },
        { branch: 'd', prNumber: 4, kind: 'recover', status: 'failed' }
      ]
    })
    expect(problems.map((p) => p.branch)).toEqual(['c', 'd'])
  })
})
