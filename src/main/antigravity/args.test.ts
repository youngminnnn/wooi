import { describe, expect, it } from 'vitest'
import type { EffortSetting } from '@shared/types'
import { ANTIGRAVITY_PRINT_TIMEOUT, antigravityArgs, antigravityEffort } from './args'

const base = {
  prompt: 'fix it',
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
