import { describe, expect, it } from 'vitest'
import { EXPERIMENTAL_UNSUPPORTED_REASON, redactDebugConfig, withWooiCodexConfig } from './config'

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

describe('/debug-config redaction', () => {
  it('redacts credentials and every environment value without mutating the response', () => {
    const input = {
      model: 'gpt-5',
      api_key: 'secret',
      hooks: [{ env: ['secret'] }],
      mcp_servers: {
        demo: { env: { PUBLIC_NAME: 'also-secret', TOKEN: 'secret' }, env_vars: ['secret'] }
      }
    }

    expect(redactDebugConfig(input)).toEqual({
      model: 'gpt-5',
      api_key: '[redacted]',
      hooks: [{ env: ['[redacted]'] }],
      mcp_servers: {
        demo: { env: { PUBLIC_NAME: '[redacted]', TOKEN: '[redacted]' }, env_vars: ['secret'] }
      }
    })
    expect(input.api_key).toBe('secret')
  })
})

describe('/experimental app-server boundary', () => {
  it('documents the missing 0.146 metadata/toggle surface instead of guessing config keys', () => {
    expect(EXPERIMENTAL_UNSUPPORTED_REASON).toBe(
      'Codex app-server 0.146 does not expose experimental-feature metadata or a safe feature-toggle method.'
    )
  })
})
