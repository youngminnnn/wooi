import { describe, it, expect } from 'vitest'
import { languageOf } from './highlight'

describe('languageOf', () => {
  it('흔한 확장자를 hljs 언어로 옮긴다', () => {
    expect(languageOf('src/App.tsx')).toBe('typescript')
    expect(languageOf('src/index.mjs')).toBe('javascript')
    expect(languageOf('styles/main.scss')).toBe('scss')
    expect(languageOf('README.md')).toBe('markdown')
  })

  it('확장자 표에 없어도 hljs 가 아는 이름이면 그대로 쓴다', () => {
    expect(languageOf('main.rust')).toBe('rust')
  })

  it('확장자가 없는 관용 파일명을 알아본다', () => {
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('build/Makefile')).toBe('makefile')
  })

  it('알 수 없으면 null 을 돌려 자동 감지로 넘긴다', () => {
    expect(languageOf('LICENSE')).toBeNull()
    expect(languageOf('data.zzz')).toBeNull()
  })
})
