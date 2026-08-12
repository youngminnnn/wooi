import { describe, expect, it } from 'vitest'
import { fanoutGroupOf, fanoutSlotName, unresolvedFanoutGroups } from './types'
import type { FanoutGroup } from './types'

function group(over: Partial<FanoutGroup> = {}): FanoutGroup {
  return {
    id: 'g1',
    repoId: 'r1',
    name: 'rate-limit',
    prompt: 'add rate limiting',
    workspaceIds: ['w1', 'w2'],
    adoptedWorkspaceId: null,
    createdAt: 0,
    ...over
  }
}

describe('fanoutSlotName', () => {
  it('후보 순번을 이름에 남긴다 — 브랜치만 보고도 몇 번째인지 알아야 한다', () => {
    expect(fanoutSlotName('rate-limit', 0)).toBe('rate-limit-1')
    expect(fanoutSlotName('rate-limit', 3)).toBe('rate-limit-4')
  })

  it('뿌리 이름이 비어 있어도 이름 없는 브랜치를 만들지 않는다', () => {
    expect(fanoutSlotName('   ', 0)).toBe('fanout-1')
  })
})

describe('fanoutGroupOf', () => {
  it('워크스페이스가 속한 그룹을 찾는다', () => {
    const groups = [group(), group({ id: 'g2', workspaceIds: ['w3'] })]
    expect(fanoutGroupOf(groups, 'w2')?.id).toBe('g1')
    expect(fanoutGroupOf(groups, 'w3')?.id).toBe('g2')
    expect(fanoutGroupOf(groups, 'w9')).toBeUndefined()
    // 아직 아무 그룹도 없는(마이그레이션 직후) 상태에서도 터지지 않아야 한다.
    expect(fanoutGroupOf(undefined, 'w1')).toBeUndefined()
  })
})

describe('unresolvedFanoutGroups', () => {
  it('채택이 끝난 그룹은 빼고, 요청한 레포로 좁힌다', () => {
    const groups = [
      group(),
      group({ id: 'g2', adoptedWorkspaceId: 'w1' }),
      group({ id: 'g3', repoId: 'r2' })
    ]
    expect(unresolvedFanoutGroups(groups).map((g) => g.id)).toEqual(['g1', 'g3'])
    expect(unresolvedFanoutGroups(groups, 'r1').map((g) => g.id)).toEqual(['g1'])
    expect(unresolvedFanoutGroups(undefined)).toEqual([])
  })
})
