import { describe, it, expect } from 'vitest'
import { sanitizeBranch, parseGithubOwner } from './git'

describe('sanitizeBranch', () => {
  it('공백을 하이픈으로 바꾼다', () => {
    expect(sanitizeBranch('my new feature')).toBe('my-new-feature')
  })

  it('git ref 로 쓸 수 없는 문자를 제거한다', () => {
    expect(sanitizeBranch('feat: add ~thing^!')).toBe('feat-add-thing')
  })

  it('영숫자와 ._/- 는 보존한다', () => {
    expect(sanitizeBranch('feature/foo_bar.v2')).toBe('feature/foo_bar.v2')
  })

  it('앞쪽 - 와 / 는 잘라낸다', () => {
    expect(sanitizeBranch('--/foo')).toBe('foo')
  })

  it('연속된 슬래시는 하나로 접는다', () => {
    expect(sanitizeBranch('feat///foo')).toBe('feat/foo')
  })

  it('내용이 모두 제거되면 "workspace" 로 폴백한다', () => {
    expect(sanitizeBranch('~~~')).toBe('workspace')
    expect(sanitizeBranch('   ')).toBe('workspace')
    expect(sanitizeBranch('')).toBe('workspace')
  })
})

describe('parseGithubOwner', () => {
  it('HTTPS URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi.git')).toBe('youngminnnn')
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi')).toBe('youngminnnn')
  })

  it('SSH(scp 형식) URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('git@github.com:youngminnnn/wooi.git')).toBe('youngminnnn')
  })

  it('ssh:// URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('ssh://git@github.com/youngminnnn/wooi')).toBe('youngminnnn')
  })

  it('끝의 슬래시를 허용한다', () => {
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi/')).toBe('youngminnnn')
  })

  it('대소문자를 가리지 않는다', () => {
    expect(parseGithubOwner('https://GitHub.com/Youngminnnn/Wooi.git')).toBe('Youngminnnn')
  })

  it('GitHub 리모트가 아니면 null 을 반환한다', () => {
    expect(parseGithubOwner('https://gitlab.com/foo/bar.git')).toBeNull()
    expect(parseGithubOwner('')).toBeNull()
    expect(parseGithubOwner('not a url')).toBeNull()
  })
})
