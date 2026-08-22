import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, Workspace } from '@shared/types'

const permissionRequests = vi.hoisted(() => [] as PermissionRequest[])
const backgroundShellCount = vi.hoisted(() => vi.fn(() => 0))

vi.mock('../../remote/permissions', () => ({
  pendingPermissions: {
    list: () => permissionRequests,
    toolFor: (requestId: string) =>
      permissionRequests.find((request) => request.requestId === requestId)?.toolName
  }
}))
vi.mock('../../runningAgentsCache', () => ({ backgroundShellCount }))

import { describeWorkspaceActivity } from './workspaceState'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-child',
    status: 'idle',
    lastActiveAt: NOW,
    rateLimited: null,
    pendingRateLimitResume: null,
    ...overrides
  } as Workspace
}

beforeEach(() => {
  permissionRequests.splice(0)
  backgroundShellCount.mockReset()
  backgroundShellCount.mockReturnValue(0)
})

describe('describeWorkspaceActivity', () => {
  it('승인 대기를 모든 상태보다 우선한다', () => {
    permissionRequests.push({
      requestId: 'p-1',
      workspaceId: 'ws-child',
      toolName: 'Bash',
      input: {}
    })
    const ws = workspace({
      status: 'running',
      rateLimited: { backend: 'claude', detectedAt: NOW, resetsAt: NOW + 60_000 }
    })
    backgroundShellCount.mockReturnValue(1)

    expect(describeWorkspaceActivity(ws, NOW)).toMatchObject({
      state: 'waiting-for-user-permission',
      note: expect.stringContaining('Bash')
    })
  })

  it('running 을 레이트리밋보다 우선한다', () => {
    const ws = workspace({
      status: 'running',
      rateLimited: { backend: 'claude', detectedAt: NOW, resetsAt: NOW + 60_000 }
    })
    expect(describeWorkspaceActivity(ws, NOW).state).toBe('running')
  })

  it('5분 이상 running 이면 한 문장으로 stale 가능성을 알린다', () => {
    const activity = describeWorkspaceActivity(
      workspace({ status: 'running', lastActiveAt: NOW - 5 * 60_000 }),
      NOW
    )
    expect(activity).toMatchObject({ state: 'running', note: expect.stringContaining('5 minutes') })
  })

  it('5분 전 running 에는 note 가 없다', () => {
    const activity = describeWorkspaceActivity(
      workspace({ status: 'running', lastActiveAt: NOW - 5 * 60_000 + 1 }),
      NOW
    )
    expect(activity).toEqual({ state: 'running', lastActiveAt: NOW - 5 * 60_000 + 1 })
  })

  it('레이트리밋을 error 와 background 보다 우선하고 자동 재개 시각을 쓴다', () => {
    backgroundShellCount.mockReturnValue(2)
    const activity = describeWorkspaceActivity(
      workspace({
        status: 'error',
        pendingRateLimitResume: {
          backend: 'claude',
          sessionId: 'session-1',
          detectedAt: NOW,
          retryAt: NOW + 120_000,
          attempt: 1
        }
      }),
      NOW
    )
    expect(activity).toMatchObject({
      state: 'rate-limited',
      note: expect.stringContaining(new Date(NOW + 120_000).toISOString())
    })
  })

  it('error 를 background 보다 우선한다', () => {
    backgroundShellCount.mockReturnValue(1)
    expect(describeWorkspaceActivity(workspace({ status: 'error' }), NOW)).toEqual({
      state: 'ended-with-error',
      lastActiveAt: NOW
    })
  })

  it('idle 전에 background task 를 판정한다', () => {
    backgroundShellCount.mockReturnValue(3)
    expect(describeWorkspaceActivity(workspace(), NOW)).toMatchObject({
      state: 'background-tasks-running',
      note: expect.stringContaining('3 background shells')
    })
  })

  it('아무 신호가 없으면 idle 이다', () => {
    expect(describeWorkspaceActivity(workspace(), NOW)).toEqual({
      state: 'idle',
      lastActiveAt: NOW
    })
  })
})
