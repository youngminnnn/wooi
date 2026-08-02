import { describe, it, expect } from 'vitest'
import { MIN_CODEX_VERSION, compareVersions, meetsMinimum, parseVersion } from './version'

describe('parseVersion', () => {
  it('codex --version 의 여러 출력 형태를 모두 받는다', () => {
    expect(parseVersion('codex-cli 0.146.0')).toBe('0.146.0')
    expect(parseVersion('codex 0.146.0')).toBe('0.146.0')
    expect(parseVersion('0.146.0')).toBe('0.146.0')
    expect(parseVersion('codex-cli 0.146.0\n')).toBe('0.146.0')
  })

  it('prerelease 접미사를 보존한다', () => {
    expect(parseVersion('codex-cli 0.146.0-alpha.14')).toBe('0.146.0-alpha.14')
  })

  it('버전을 못 찾으면 null (차단이 아니라 "불명"으로 취급하기 위해)', () => {
    expect(parseVersion('command not found')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('세 자리를 순서대로 비교한다', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.146.0', '0.128.0')).toBeGreaterThan(0)
    expect(compareVersions('0.99.0', '0.128.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0)
  })

  // 문자열 비교로 구현하면 "0.99" > "0.128" 이 되는 고전적인 함정.
  it('숫자로 비교한다(문자열 사전순이 아니라)', () => {
    expect(compareVersions('0.128.0', '0.99.0')).toBeGreaterThan(0)
  })

  it('prerelease 는 무시하고 숫자 세 자리만 본다', () => {
    expect(compareVersions('0.146.0-alpha.14', '0.146.0')).toBe(0)
  })

  it('자리가 모자라면 0 으로 채운다', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })
})

describe('meetsMinimum', () => {
  it('최소 버전 이상이면 통과', () => {
    expect(meetsMinimum(MIN_CODEX_VERSION)).toBe(true)
    expect(meetsMinimum('99.0.0')).toBe(true)
  })

  it('미만이면 거절', () => {
    expect(meetsMinimum('0.1.0')).toBe(false)
  })

  // 버전을 못 읽었다고 막으면, 멀쩡히 동작하는 설치본을 오탐으로 차단하게 된다.
  it('버전 불명(null)은 막지 않는다', () => {
    expect(meetsMinimum(null)).toBe(true)
  })
})
