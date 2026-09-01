import { describe, expect, it } from 'vitest'
import { pr } from '../test/fixtures'
import { describeWorkspaceStatus, type WorkspaceStatusInput } from './workspaceStatus'

/** 어느 사다리도 트리거하지 않는 최소 입력. 각 테스트가 필요한 필드만 덮어쓴다. */
function baseInput(overrides: Partial<WorkspaceStatusInput> = {}): WorkspaceStatusInput {
  return {
    status: 'idle',
    awaitingPermission: false,
    compacting: false,
    stale: false,
    runningMs: 0,
    ...overrides
  }
}

describe('describeWorkspaceStatus', () => {
  it('권한 대기면 awaiting-permission', () => {
    const result = describeWorkspaceStatus(
      baseInput({ awaitingPermission: true, ask: 'Run rm -rf?' })
    )
    expect(result.rung).toBe('awaiting-permission')
    expect(result.title).toBe('Run rm -rf?')
  })

  it('실행 중 압축 중이면 compacting', () => {
    const result = describeWorkspaceStatus(baseInput({ status: 'running', compacting: true }))
    expect(result.rung).toBe('compacting')
  })

  it('실행이 오래 걸리면 running-stale', () => {
    const result = describeWorkspaceStatus(
      baseInput({ status: 'running', stale: true, runningMs: 12 * 60_000 })
    )
    expect(result.rung).toBe('running-stale')
    expect(result.title).toBe('Running for 12m — may be stuck')
  })

  it('그냥 실행 중이면 running', () => {
    const result = describeWorkspaceStatus(baseInput({ status: 'running' }))
    expect(result.rung).toBe('running')
  })

  it('사용량 제한에 걸리면 rate-limited', () => {
    const result = describeWorkspaceStatus(
      baseInput({ rateLimited: { backend: 'claude', detectedAt: 0, resetsAt: null } })
    )
    expect(result.rung).toBe('rate-limited')
  })

  it('스택 대기 중이면 awaiting-stacked-work', () => {
    const result = describeWorkspaceStatus(
      baseInput({
        awaitingStackedWork: {
          targets: [{ workspaceId: 'w2', seenReportAt: null }],
          until: 'all-reported',
          startedAt: 0,
          deadlineAt: Date.now() + 60_000,
          sessionId: null
        }
      })
    )
    expect(result.rung).toBe('awaiting-stacked-work')
  })

  it('상태가 error 면 error', () => {
    const result = describeWorkspaceStatus(baseInput({ status: 'error' }))
    expect(result.rung).toBe('error')
  })

  it('백그라운드 셸이 남아 있으면 background-tasks', () => {
    const result = describeWorkspaceStatus(baseInput({ backgroundTasks: 1 }))
    expect(result.rung).toBe('background-tasks')
  })

  it('사용자가 중단했으면 interrupted', () => {
    const result = describeWorkspaceStatus(baseInput({ interrupted: true }))
    expect(result.rung).toBe('interrupted')
  })

  it('PR 이 있으면 pr', () => {
    const result = describeWorkspaceStatus(baseInput({ pr: pr('open') }))
    expect(result.rung).toBe('pr')
  })

  it('그 외는 idle', () => {
    const result = describeWorkspaceStatus(baseInput())
    expect(result.rung).toBe('idle')
  })

  describe('우선순위 — 원본(Sidebar.tsx) 순서를 그대로 검사한다', () => {
    it('권한 대기가 error 를 이긴다', () => {
      const result = describeWorkspaceStatus(
        baseInput({ awaitingPermission: true, status: 'error' })
      )
      expect(result.rung).toBe('awaiting-permission')
    })

    it('실행 중이 사용량 제한을 이긴다', () => {
      const result = describeWorkspaceStatus(
        baseInput({
          status: 'running',
          rateLimited: { backend: 'claude', detectedAt: 0, resetsAt: null }
        })
      )
      expect(result.rung).toBe('running')
    })

    it('사용량 제한이 error 를 이긴다', () => {
      const result = describeWorkspaceStatus(
        baseInput({
          status: 'error',
          rateLimited: { backend: 'claude', detectedAt: 0, resetsAt: null }
        })
      )
      expect(result.rung).toBe('rate-limited')
    })

    it('백그라운드 셸이 PR 점을 이긴다 — 지금 이 순간의 정보가 언제나 그대로인 PR 상태보다 앞선다', () => {
      const result = describeWorkspaceStatus(baseInput({ backgroundTasks: 2, pr: pr('open') }))
      expect(result.rung).toBe('background-tasks')
    })

    it('중단이 PR 점을 이긴다 — 재개할 것이 남았다는 사실이 PR 상태보다 앞선다', () => {
      const result = describeWorkspaceStatus(baseInput({ interrupted: true, pr: pr('open') }))
      expect(result.rung).toBe('interrupted')
    })
  })
})
