import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { permissionOutcome, pickPermissionOptionId } from './permission'

function option(optionId: string, kind: acp.PermissionOptionKind): acp.PermissionOption {
  return { optionId, name: optionId, kind }
}

/** 네 kind 를 모두 보내는, 스펙대로인 에이전트. */
const FULL: acp.PermissionOption[] = [
  option('allow-once', 'allow_once'),
  option('allow-always', 'allow_always'),
  option('reject-once', 'reject_once'),
  option('reject-always', 'reject_always')
]

describe('pickPermissionOptionId', () => {
  it('네 kind 가 다 있으면 정확히 그 kind 를 고른다', () => {
    expect(pickPermissionOptionId(FULL, 'allow')).toBe('allow-once')
    expect(pickPermissionOptionId(FULL, 'allowAlways')).toBe('allow-always')
    expect(pickPermissionOptionId(FULL, 'reject')).toBe('reject-once')
    expect(pickPermissionOptionId(FULL, 'rejectAlways')).toBe('reject-always')
  })

  // 실측: GitHub Copilot CLI 는 reject_always 를 보내지 않는다. 없는 kind 를 찾다가 빈손으로
  // 돌아오면 그 턴이 멈추므로, 같은 방향의 남은 kind 로 강등돼야 한다.
  it('요청한 kind 가 없으면 같은 방향의 다른 kind 로 내려간다', () => {
    const noRejectAlways = FULL.filter((o) => o.kind !== 'reject_always')
    expect(pickPermissionOptionId(noRejectAlways, 'rejectAlways')).toBe('reject-once')

    const noAllowAlways = FULL.filter((o) => o.kind !== 'allow_always')
    expect(pickPermissionOptionId(noAllowAlways, 'allowAlways')).toBe('allow-once')
  })

  it('kind 가 비표준이면 optionId 접두사로 찾는다', () => {
    const odd = [
      { optionId: 'approve_this', name: 'Approve', kind: 'weird' },
      { optionId: 'deny_this', name: 'Deny', kind: 'weird' }
    ] as unknown as acp.PermissionOption[]
    expect(pickPermissionOptionId(odd, 'allow')).toBe('approve_this')
    expect(pickPermissionOptionId(odd, 'reject')).toBe('deny_this')
  })

  // 거절이 허용으로 뒤집히는 것이 최악이다. 못 찾으면 찍지 말고 포기해야 한다.
  it('맞는 방향이 하나도 없으면 아무거나 찍지 않고 null 이다', () => {
    const allowOnly = [option('allow-once', 'allow_once')]
    expect(pickPermissionOptionId(allowOnly, 'reject')).toBeNull()
    expect(pickPermissionOptionId([], 'allow')).toBeNull()
  })
})

describe('permissionOutcome', () => {
  it('고른 선택지를 selected 로 감싼다', () => {
    expect(permissionOutcome(FULL, 'allow')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  // cancelled 는 스펙이 정의한 정상 응답이라 에이전트가 턴을 접을 수 있다. 무응답과 다르다.
  it('맞는 선택지가 없으면 cancelled 로 답한다', () => {
    expect(permissionOutcome([option('allow-once', 'allow_once')], 'reject')).toEqual({
      outcome: { outcome: 'cancelled' }
    })
  })
})
