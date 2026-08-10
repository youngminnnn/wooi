import { describe, expect, it } from 'vitest'
import { withWooiCodexConfig } from './config'

describe('Wooi Codex process config', () => {
  it('app-server에서 전역 turn-ended notify를 끈다', () => {
    expect(withWooiCodexConfig(['app-server', '--listen', 'stdio://'])).toEqual([
      'app-server',
      '-c',
      'notify=[]',
      '--listen',
      'stdio://'
    ])
  })

  it('exec resume의 서브커맨드 구조를 보존한다', () => {
    expect(withWooiCodexConfig(['exec', 'resume', 'thread-id', '--json', '-'])).toEqual([
      'exec',
      '-c',
      'notify=[]',
      'resume',
      'thread-id',
      '--json',
      '-'
    ])
  })

  it('호출자가 만든 인자 배열을 변경하지 않는다', () => {
    const args = ['exec', '-']
    withWooiCodexConfig(args)
    expect(args).toEqual(['exec', '-'])
  })
})
