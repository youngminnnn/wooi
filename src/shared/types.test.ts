import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceName,
  notificationSkipReason,
  sanitizeAgentEnv,
  usableDefaultBackend,
  workspaceDisplayName
} from './types'

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

describe('notificationSkipReason', () => {
  const base = {
    muted: false,
    channelOn: true,
    appFocused: false,
    viewingWorkspaceId: null as string | null,
    workspaceId: 'w1',
    suppressWhenFocused: true,
    supported: true
  }

  it('조건이 다 맞으면 띄운다', () => {
    expect(notificationSkipReason(base)).toBeNull()
  })

  it('음소거가 채널보다 먼저다', () => {
    expect(notificationSkipReason({ ...base, muted: true, channelOn: false })).toBe('muted')
  })

  it('채널이 꺼져 있으면 사유를 남긴다', () => {
    expect(notificationSkipReason({ ...base, channelOn: false })).toBe('channel-off')
  })

  it('보고 있는 워크스페이스는 누른다', () => {
    const input = { ...base, appFocused: true, viewingWorkspaceId: 'w1' }
    expect(notificationSkipReason(input)).toBe('suppressed-focus')
  })

  it('앱은 앞에 있어도 다른 워크스페이스를 보고 있으면 띄운다', () => {
    const input = { ...base, appFocused: true, viewingWorkspaceId: 'w2' }
    expect(notificationSkipReason(input)).toBeNull()
  })

  it('창이 흐려져 있으면 그 워크스페이스를 보고 있어도 띄운다', () => {
    const input = { ...base, appFocused: false, viewingWorkspaceId: 'w1' }
    expect(notificationSkipReason(input)).toBeNull()
  })

  it('무엇을 보고 있는지 모르면 누르지 않는다 — 한 번 더 뜨는 편이 낫다', () => {
    const input = { ...base, appFocused: true, viewingWorkspaceId: null }
    expect(notificationSkipReason(input)).toBeNull()
  })

  it('설정을 끄면 보고 있어도 띄운다', () => {
    const input = {
      ...base,
      appFocused: true,
      viewingWorkspaceId: 'w1',
      suppressWhenFocused: false
    }
    expect(notificationSkipReason(input)).toBeNull()
  })

  it('OS 가 지원하지 않으면 사유를 남긴다', () => {
    expect(notificationSkipReason({ ...base, supported: false })).toBe('not-supported')
  })

  it('포커스 억제가 미지원보다 먼저다 — 어차피 안 띄울 것의 이유로는 앞이 더 정확하다', () => {
    const input = { ...base, appFocused: true, viewingWorkspaceId: 'w1', supported: false }
    expect(notificationSkipReason(input)).toBe('suppressed-focus')
  })
})

describe('usableDefaultBackend', () => {
  it('저장된 값이 쓸 수 있는 목록에 있으면 그대로 돌려준다', () => {
    expect(usableDefaultBackend('codex', ['claude', 'codex'])).toBe('codex')
  })

  it('저장된 값을 쓸 수 없으면(그 CLI 를 지운 등) 쓸 수 있는 첫 번째로 바꾼다', () => {
    expect(usableDefaultBackend('claude', ['codex'])).toBe('codex')
  })

  it('쓸 수 있는 목록이 비어 있으면(감지 실패) 저장된 값을 건드리지 않는다', () => {
    expect(usableDefaultBackend('claude', [])).toBe('claude')
  })
})
