import { describe, expect, it } from 'vitest'
import type { StackCascadeStep } from '@shared/types'
import { buildConflictPrompt, pickAutoResolveStep } from './conflictResolve'

type Step = StackCascadeStep & { workspaceId?: string }

function step(overrides: Partial<Step> = {}): Step {
  return {
    branch: 'feature/a',
    prNumber: 12,
    kind: 'restack',
    status: 'conflict',
    workspaceId: 'workspace-a',
    conflictedFiles: ['src/a.ts'],
    ...overrides
  }
}

describe('pickAutoResolveStep', () => {
  it('설정이 꺼져 있으면 유효한 충돌도 고르지 않는다', () => {
    expect(pickAutoResolveStep(false, [step()])).toBeNull()
  })

  it('diverged 는 사람이 버릴 쪽을 골라야 하므로 자동 해결하지 않는다', () => {
    expect(pickAutoResolveStep(true, [step({ status: 'diverged' })])).toBeNull()
  })

  it('workspaceId 또는 충돌 파일이 없는 단계는 건너뛴다', () => {
    expect(
      pickAutoResolveStep(true, [
        step({ workspaceId: undefined }),
        step({ workspaceId: 'workspace-b', conflictedFiles: [] })
      ])
    ).toBeNull()
  })

  it('여러 충돌 중 첫 번째로 조건을 만족한 단계 하나만 고른다', () => {
    const first = step({ branch: 'feature/first', workspaceId: 'workspace-first' })
    const second = step({ branch: 'feature/second', workspaceId: 'workspace-second' })

    expect(pickAutoResolveStep(true, [step({ workspaceId: undefined }), first, second])).toBe(first)
  })

  it.each(['failed', 'ok', 'skipped'] as const)('%s 단계는 고르지 않는다', (status) => {
    expect(pickAutoResolveStep(true, [step({ status })])).toBeNull()
  })

  // 머지 트레인의 merge 단계가 말하는 conflict 는 "PR 이 base 와 충돌한다"는 GitHub 쪽 사실이라
  // 워크트리에는 풀 것이 없다. restack 단계만 워크트리를 rebase 진행 상태로 남긴다.
  it.each(['merge', 'retarget', 'recover'] as const)(
    '%s 단계의 conflict 는 워크트리 충돌이 아니므로 고르지 않는다',
    (kind) => {
      expect(pickAutoResolveStep(true, [step({ kind })])).toBeNull()
    }
  )
})

describe('buildConflictPrompt', () => {
  const input = {
    branch: 'feature/payments',
    baseBranch: 'main',
    conflictedFiles: ['src/payment flow.ts', 'src/shared/exact[1].ts']
  }

  it('필요한 맥락·명령·금지 사항을 빠짐없이 담는다', () => {
    const prompt = buildConflictPrompt(input)

    expect(prompt).toContain(input.branch)
    expect(prompt).toContain(input.baseBranch)
    for (const file of input.conflictedFiles) expect(prompt).toContain(`- ${file}`)
    expect(prompt).toContain('git rebase --continue')
    expect(prompt).toContain('git rebase --abort')
    expect(prompt).toContain('Do not refactor.')
    expect(prompt).toContain('Do not touch files outside the conflicted list.')
    expect(prompt).toContain('Do not run the full test suite.')
    expect(prompt).toContain('Do not broadly explore the repository.')
  })

  it('자동 시작일 때만 Wooi가 시작한 이유와 설정에서 끄는 길을 밝힌다', () => {
    const manual = buildConflictPrompt(input)
    const automatic = buildConflictPrompt({ ...input, auto: true })

    expect(automatic).not.toBe(manual)
    expect(automatic).toContain('Wooi started this turn automatically')
    expect(automatic).toContain('turn it off in Settings')
    expect(manual).not.toContain('Wooi started this turn automatically')
  })
})
