import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionRequest, Workspace } from '@shared/types'
import { pendingPermissions } from './remote/permissions'
import { rememberRunningAgents } from './runningAgentsCache'
import { stackedChildProgress } from './stackedProgress'

const NOW = Date.parse('2026-08-22T00:00:00Z')

function child(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: 'child',
    status: 'idle',
    archived: false,
    lastActiveAt: NOW,
    pendingRateLimitResume: null,
    rateLimited: null,
    ...patch
  } as Workspace
}

afterEach(() => {
  pendingPermissions.clear()
  rememberRunningAgents('child', [])
})

describe('stackedChildProgress', () => {
  it('턴이 도는 자식만 진행 가능이다', () => {
    expect(stackedChildProgress(child({ status: 'running' }), NOW)).toEqual({
      canProgress: true,
      reason: 'running'
    })
  })

  it('아카이브는 되돌아올 수 없으므로 무엇보다 먼저 본다', () => {
    expect(stackedChildProgress(child({ status: 'running', archived: true }), NOW)).toEqual({
      canProgress: false,
      reason: 'archived'
    })
  })

  /**
   * 이 테스트가 이 파일의 존재 이유다. 승인 카드에 걸린 워크스페이스는 `status` 가 `running`
   * 이라, 판정을 여기서 새로 만들면 "진행 가능" 으로 읽혀 정지 깨움이 영영 열리지 않는다.
   */
  it('승인 카드에 걸리면 status 가 running 이어도 진행 불가다', () => {
    pendingPermissions.add({
      requestId: 'req-1',
      workspaceId: 'child',
      toolName: 'Bash'
    } as PermissionRequest)
    expect(stackedChildProgress(child({ status: 'running' }), NOW)).toEqual({
      canProgress: false,
      reason: 'waiting-for-user-permission'
    })
  })

  it('다른 워크스페이스의 승인 카드는 이 자식의 판정을 바꾸지 않는다', () => {
    pendingPermissions.add({
      requestId: 'req-2',
      workspaceId: 'someone-else',
      toolName: 'Bash'
    } as PermissionRequest)
    expect(stackedChildProgress(child({ status: 'running' }), NOW).canProgress).toBe(true)
  })

  it('자동 이어가기가 예약된 레이트리밋은 스스로 풀리므로 진행 가능이다', () => {
    const ws = child({
      rateLimited: { backend: 'claude', detectedAt: NOW, resetsAt: NOW + 60_000 },
      pendingRateLimitResume: {
        backend: 'claude',
        sessionId: 's',
        detectedAt: NOW,
        retryAt: NOW + 60_000,
        attempt: 0
      }
    })
    expect(stackedChildProgress(ws, NOW)).toEqual({ canProgress: true, reason: 'resuming' })
  })

  it('예약 없는 레이트리밋은 사람이 손대야 풀린다', () => {
    const ws = child({
      rateLimited: { backend: 'claude', detectedAt: NOW, resetsAt: NOW + 60_000 }
    })
    expect(stackedChildProgress(ws, NOW)).toEqual({ canProgress: false, reason: 'rate-limited' })
  })

  it('에러로 끝난 턴은 진행 불가다', () => {
    expect(stackedChildProgress(child({ status: 'error' }), NOW)).toEqual({
      canProgress: false,
      reason: 'ended-with-error'
    })
  })

  it('백그라운드 셸이 남아 있어도 에이전트 자신은 유휴라 보고가 오지 않는다', () => {
    rememberRunningAgents('child', [{ id: 'a', taskType: 'bash' }] as never)
    expect(stackedChildProgress(child(), NOW)).toEqual({
      canProgress: false,
      reason: 'background-tasks-running'
    })
  })

  it('그냥 유휴면 진행 불가다', () => {
    expect(stackedChildProgress(child(), NOW)).toEqual({ canProgress: false, reason: 'idle' })
  })
})
