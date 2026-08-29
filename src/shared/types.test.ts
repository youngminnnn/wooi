import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceName, sanitizeAgentEnv, workspaceDisplayName } from './types'

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

describe('sanitizeAgentEnv', () => {
  it('평범한 키는 그대로 통과시킨다', () => {
    expect(sanitizeAgentEnv({ HTTPS_PROXY: 'http://localhost:8080', FOO_1: '' })).toEqual({
      env: { HTTPS_PROXY: 'http://localhost:8080', FOO_1: '' },
      blocked: []
    })
  })

  it.each([['PATH'], ['HOME'], ['path'], ['Home']])(
    '%s 는 대소문자를 가리지 않고 막는다',
    (key) => {
      const { env, blocked } = sanitizeAgentEnv({ [key]: '/tmp' })
      expect(env).toEqual({})
      expect(blocked).toEqual([key])
    }
  )

  it('WOOI_ 로 시작하는 키는 전부 막는다 — dev/설치본 격리가 걸려 있다', () => {
    const { env, blocked } = sanitizeAgentEnv({ WOOI_DEV_PORT: '1', wooi_user_data: '/x', OK: 'y' })
    expect(env).toEqual({ OK: 'y' })
    expect(blocked).toEqual(['WOOI_DEV_PORT', 'wooi_user_data'])
  })

  it('환경 변수 이름이 될 수 없는 키를 막는다', () => {
    const { env, blocked } = sanitizeAgentEnv({ '1BAD': 'x', 'has space': 'y', 'a-b': 'z' })
    expect(env).toEqual({})
    expect(blocked).toEqual(['1BAD', 'has space', 'a-b'])
  })

  it('손으로 고친 파일이 넣은 문자열 아닌 값을 막는다', () => {
    const raw = { GOOD: 'x', BAD: 42 } as unknown as Record<string, string>
    expect(sanitizeAgentEnv(raw)).toEqual({ env: { GOOD: 'x' }, blocked: ['BAD'] })
  })

  it('키 앞뒤 공백을 떼고, 비어 있으면 조용히 버린다', () => {
    expect(sanitizeAgentEnv({ '  FOO  ': 'bar', '   ': 'x' })).toEqual({
      env: { FOO: 'bar' },
      blocked: []
    })
  })

  it('설정이 없으면 빈 결과다', () => {
    expect(sanitizeAgentEnv(undefined)).toEqual({ env: {}, blocked: [] })
  })
})
