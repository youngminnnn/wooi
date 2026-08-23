import { describe, expect, it } from 'vitest'
import { nameFromPlanText, shouldAutoName } from './planName'

describe('nameFromPlanText', () => {
  it('첫 markdown heading을 쓴다', () => {
    expect(nameFromPlanText('Intro\n\n# Add automatic workspace names\nDetails')).toBe(
      'Add automatic workspace names'
    )
  })

  it('heading이 없으면 첫 문장을 쓴다', () => {
    expect(nameFromPlanText('Add automatic names. Then update the mobile mirror.')).toBe(
      'Add automatic names'
    )
  })

  it('맨 앞 code fence를 건너뛴다', () => {
    expect(nameFromPlanText('```ts\n# Not a heading\n```\n\n## Real plan')).toBe('Real plan')
  })

  it('긴 heading도 공통 60자 제한을 따른다', () => {
    expect(nameFromPlanText(`# ${'x'.repeat(80)}`)).toBe('x'.repeat(60))
  })

  it('빈 계획은 null이다', () => {
    expect(nameFromPlanText(' \n\n')).toBeNull()
  })
})

describe('shouldAutoName', () => {
  const workspace = { displayName: null, autoName: null, prNumber: null }

  it('네 조건이 모두 맞으면 이름을 붙인다', () => {
    expect(shouldAutoName(workspace, { behavior: 'allow' })).toBe(true)
  })

  it('거부된 결정이면 붙이지 않는다', () => {
    expect(shouldAutoName(workspace, { behavior: 'deny' })).toBe(false)
  })

  it('사람 이름이 있으면 붙이지 않는다', () => {
    expect(shouldAutoName({ ...workspace, displayName: 'Human' }, { behavior: 'allow' })).toBe(
      false
    )
  })

  it('자동 이름이 이미 있으면 붙이지 않는다', () => {
    expect(shouldAutoName({ ...workspace, autoName: 'Earlier' }, { behavior: 'allow' })).toBe(false)
  })

  it('PR이 있으면 붙이지 않는다', () => {
    expect(shouldAutoName({ ...workspace, prNumber: 12 }, { behavior: 'allow' })).toBe(false)
  })
})
