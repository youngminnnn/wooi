import { describe, expect, it } from 'vitest'
import type { EffortSetting } from '@shared/types'
import { ANTIGRAVITY_PRINT_TIMEOUT, antigravityArgs, antigravityEffort } from './args'

const base = {
  prompt: 'fix it',
  cwd: '/work/tree',
  conversationId: null,
  model: null,
  effort: null,
  modeArgs: []
}

describe('antigravityArgs', () => {
  it('첫 턴에는 conversation 인자를 넣지 않는다', () => {
    expect(antigravityArgs(base)).toEqual([
      '-p',
      'fix it',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/work/tree',
      '--print-timeout',
      '24h'
    ])
  })

  it('이어지는 턴에는 conversation 과 선택 모델을 넣는다', () => {
    expect(antigravityArgs({ ...base, conversationId: 'conv-1', model: 'gemini-pro' })).toEqual([
      '-p',
      'fix it',
      '--output-format',
      'stream-json',
      '--conversation',
      'conv-1',
      '--model',
      'gemini-pro',
      '--add-dir',
      '/work/tree',
      '--print-timeout',
      '24h'
    ])
  })

  it('mode 인자를 effort 뒤, add-dir 앞에 그대로 둔다', () => {
    expect(
      antigravityArgs({
        ...base,
        effort: 'high',
        modeArgs: ['--mode', 'plan', '--allow-tool', 'write_file'],
        extraDirs: ['/tmp/a', '/tmp/b']
      })
    ).toEqual([
      '-p',
      'fix it',
      '--output-format',
      'stream-json',
      '--effort',
      'high',
      '--mode',
      'plan',
      '--allow-tool',
      'write_file',
      '--add-dir',
      '/work/tree',
      '--add-dir',
      '/tmp/a',
      '--add-dir',
      '/tmp/b',
      '--print-timeout',
      '24h'
    ])
  })

  it('상대 add-dir 는 거절한다', () => {
    expect(() => antigravityArgs({ ...base, extraDirs: ['relative/path'] })).toThrow(
      'must be absolute'
    )
  })

  it('print-timeout 을 항상 마지막에 둔다', () => {
    const args = antigravityArgs({ ...base, model: 'm', modeArgs: ['--mode', 'plan'] })
    expect(args.slice(-2)).toEqual(['--print-timeout', ANTIGRAVITY_PRINT_TIMEOUT])
  })
})

describe('antigravityEffort', () => {
  it.each<[EffortSetting | null, string | undefined]>([
    [null, undefined],
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
    ['ultracode', 'high']
  ])('%s 를 %s 로 변환한다', (input, expected) => {
    expect(antigravityEffort(input)).toBe(expected)
  })
})

/**
 * `--add-dir <cwd>` 가 빠지면 이 백엔드는 조용히 무너진다 — 에이전트가 워크트리 밖
 * (`~/.gemini/antigravity-cli/scratch`)에 파일을 쓰고 Changes 패널은 영원히 비어 있다.
 * agy 1.1.13 에서 실측한 동작이라 회귀로 못박는다(args.ts 주석 참고).
 */
describe('cwd 를 작업 루트로 못박는다', () => {
  it('추가 디렉터리가 없어도 cwd 는 항상 --add-dir 로 나간다', () => {
    const args = antigravityArgs(base)
    expect(args).toContain('--add-dir')
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/work/tree')
  })

  it('cwd 가 사용자 추가 디렉터리보다 먼저 나간다', () => {
    const args = antigravityArgs({ ...base, extraDirs: ['/tmp/extra'] })
    expect(args.filter((_, i) => args[i - 1] === '--add-dir')).toEqual(['/work/tree', '/tmp/extra'])
  })
})
