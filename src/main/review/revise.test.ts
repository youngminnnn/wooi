import { describe, it, expect } from 'vitest'
import { applyRevisions, findingHandle, resolveFindingId } from './revise'
import type { ReviewFinding } from '@shared/types'

/**
 * 에이전트가 자기 지적을 되돌아보는 자리. 여기서 지켜야 하는 것은 두 가지다 —
 * **게시된 것은 못 건드린다**(상대가 이미 읽었다), **모르는 핸들은 흘린다**(엉뚱한 지적을
 * 지우느니 지시를 놓치는 편이 낫다).
 */

function finding(id: string, over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id,
    severity: 'major',
    title: `Finding ${id}`,
    body: 'The original body.',
    anchor: null,
    ...over
  }
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'

describe('findingHandle', () => {
  it('하이픈을 빼고 앞 8 자만 남긴다', () => {
    expect(findingHandle(A)).toBe('aaaaaaaa')
    expect(findingHandle('12345678-90ab')).toBe('12345678')
  })
})

describe('resolveFindingId', () => {
  const findings = [finding(A), finding(B)]

  it('핸들의 앞자리로 지적을 찾는다', () => {
    expect(resolveFindingId(findings, 'aaaaaaaa')).toBe(A)
  })

  it('id 를 통째로 줘도 찾는다 — 모델이 그렇게 복사해 오는 일이 있다', () => {
    expect(resolveFindingId(findings, A)).toBe(A)
  })

  it('너무 짧은 핸들은 거절한다 — 앞자리 대조가 엉뚱한 지적을 집는다', () => {
    expect(resolveFindingId(findings, 'aaa')).toBeUndefined()
  })

  /** 두 지적이 같은 앞자리를 가지면 어느 쪽인지 모른다. 모르는 채로 지우는 것이 최악이다. */
  it('앞자리가 겹치는 지적이 둘이면 아무것도 고르지 않는다', () => {
    const twins = [finding('abcdef01-x'), finding('abcdef02-x')]
    expect(resolveFindingId(twins, 'abcdef')).toBeUndefined()
  })
})

describe('applyRevisions — 고쳐 쓰기', () => {
  it('준 필드만 바꾸고 나머지는 그대로 둔다', () => {
    const { updated } = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', body: 'A sharper body.' }],
      discards: []
    })
    expect(updated).toHaveLength(1)
    expect(updated[0].body).toBe('A sharper body.')
    expect(updated[0].title).toBe(`Finding ${A}`)
    expect(updated[0].severity).toBe('major')
  })

  it('심각도만 낮추는 것도 변경으로 친다', () => {
    const { updated } = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', severity: 'nit' }],
      discards: []
    })
    expect(updated[0].severity).toBe('nit')
  })

  /** 앵커·PR 번호는 diff 가 정한 것이라 에이전트의 재서술로 흔들리면 안 된다. */
  it('앵커는 건드리지 않는다', () => {
    const anchored = finding(A, {
      anchor: { file: 'a.ts', side: 'RIGHT', line: 12, startLine: null, snappedFrom: null },
      prNumber: 7
    })
    const { updated } = applyRevisions({
      findings: [anchored],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', title: 'Renamed' }],
      discards: []
    })
    expect(updated[0].anchor).toEqual(anchored.anchor)
    expect(updated[0].prNumber).toBe(7)
  })

  it('바뀐 것이 없으면 갱신으로 세지 않는다', () => {
    const result = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', body: 'The original body.' }],
      discards: []
    })
    expect(result.updated).toHaveLength(0)
    expect(result.ignored[0].reason).toMatch(/nothing actually changed/)
  })

  it('빈 문자열은 "지워라" 가 아니라 "안 냈다" 로 읽는다', () => {
    const result = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', title: '   ', body: '' }],
      discards: []
    })
    expect(result.updated).toHaveLength(0)
  })
})

describe('applyRevisions — 거둬들이기', () => {
  it('지적을 목록에서 빼고 이유를 함께 돌려준다', () => {
    const { discarded } = applyRevisions({
      findings: [finding(A), finding(B)],
      postedIds: [],
      updates: [],
      discards: [{ id: 'aaaaaaaa', reason: 'They fixed it in the new commit.' }]
    })
    expect(discarded).toHaveLength(1)
    expect(discarded[0].finding.id).toBe(A)
    expect(discarded[0].reason).toBe('They fixed it in the new commit.')
  })

  it('이유가 없어도 거둬들인다 — 이유가 없다고 지시를 흘리면 목록만 남는다', () => {
    const { discarded } = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [],
      discards: [{ id: 'aaaaaaaa' }]
    })
    expect(discarded).toHaveLength(1)
    expect(discarded[0].reason).toBeTruthy()
  })

  /** 같은 턴이 거둔 것을 다시 고쳐 쓰라고 하면 조용히 되살아나서는 안 된다. */
  it('거둬들인 지적은 같은 턴의 고쳐 쓰기로 되살아나지 않는다', () => {
    const result = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [{ id: 'aaaaaaaa', body: 'Back from the dead.' }],
      discards: [{ id: 'aaaaaaaa', reason: 'Fixed.' }]
    })
    expect(result.discarded).toHaveLength(1)
    expect(result.updated).toHaveLength(0)
  })
})

describe('applyRevisions — 건드리면 안 되는 것', () => {
  /**
   * 게시된 코멘트는 상대가 이미 읽은 말이다. 화면에서만 바꾸면 두 사람이 서로 다른 문장을 보고,
   * 화면에서만 지우면 GitHub 에 남은 코멘트를 우리만 잊는다.
   */
  it('이미 게시된 지적은 고쳐 쓰지도 거둬들이지도 않는다', () => {
    const result = applyRevisions({
      findings: [finding(A)],
      postedIds: [A],
      updates: [{ id: 'aaaaaaaa', body: 'Rewritten.' }],
      discards: [{ id: 'aaaaaaaa', reason: 'Fixed.' }]
    })
    expect(result.updated).toHaveLength(0)
    expect(result.discarded).toHaveLength(0)
    expect(result.ignored.every((i) => /already posted/.test(i.reason))).toBe(true)
  })

  it('모르는 핸들은 조용히 흘린다', () => {
    const result = applyRevisions({
      findings: [finding(A)],
      postedIds: [],
      updates: [],
      discards: [{ id: 'deadbeef', reason: 'Gone.' }]
    })
    expect(result.discarded).toHaveLength(0)
    expect(result.ignored[0].reason).toMatch(/no finding with that handle/)
  })
})
