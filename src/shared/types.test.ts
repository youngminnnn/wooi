import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceName, workspaceDisplayName } from './types'

describe('workspaceDisplayName', () => {
  it('사람 이름, PR 제목, 자동 이름, worktree 이름 순으로 고른다', () => {
    const workspace = {
      name: 'fearless-echidna',
      displayName: 'Human name',
      autoName: 'Agent name'
    }
    expect(workspaceDisplayName(workspace, 'PR title')).toBe('Human name')
    expect(workspaceDisplayName({ ...workspace, displayName: null }, 'PR title')).toBe('PR title')
    expect(workspaceDisplayName({ ...workspace, displayName: null }, null)).toBe('Agent name')
    expect(workspaceDisplayName({ ...workspace, displayName: null, autoName: null }, null)).toBe(
      'fearless-echidna'
    )
  })

  it('공백뿐인 사람 이름과 자동 이름은 건너뛴다', () => {
    expect(
      workspaceDisplayName({ name: 'fearless-echidna', displayName: '  ', autoName: '\n ' }, null)
    ).toBe('fearless-echidna')
  })

  it('PR 제목은 자동 이름보다 앞선다', () => {
    expect(
      workspaceDisplayName(
        { name: 'fearless-echidna', displayName: null, autoName: 'Agent name' },
        'PR title'
      )
    ).toBe('PR title')
  })
})

describe('normalizeWorkspaceName', () => {
  it('마크다운 heading 접두사와 감싼 따옴표를 벗긴다', () => {
    expect(normalizeWorkspaceName('### “Plan the workspace”')).toBe('Plan the workspace')
  })

  it('줄바꿈과 제어 문자를 공백 하나로 접는다', () => {
    expect(normalizeWorkspaceName('Plan\n\tthe\u0000 workspace')).toBe('Plan the workspace')
  })

  it('60자에서 가까운 단어 경계로 자르고 말줄임표를 붙이지 않는다', () => {
    const result = normalizeWorkspaceName(`${'a'.repeat(50)} boundary ${'b'.repeat(20)}`)
    expect(result).toBe(`${'a'.repeat(50)} boundary`)
    expect(result).toHaveLength(59)
  })

  it('가까운 단어 경계가 없으면 정확히 60자로 자른다', () => {
    expect(normalizeWorkspaceName('x'.repeat(80))).toBe('x'.repeat(60))
  })

  it.each([[''], ['   '], [null], [42], [{}]])('빈 값과 문자열 아닌 값은 null이다', (raw) => {
    expect(normalizeWorkspaceName(raw)).toBeNull()
  })
})
