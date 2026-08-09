import { describe, expect, it, vi } from 'vitest'
import { ScriptRunner } from './scripts'

describe('ScriptRunner dynamic script ids', () => {
  it('등록 개수와 무관하게 workspace의 실행과 로그를 모두 정리한다', () => {
    const runner = new ScriptRunner(vi.fn())
    const stop = vi.spyOn(runner, 'stop').mockImplementation(() => undefined)
    const internals = runner as unknown as {
      running: Map<string, unknown>
      history: Map<string, string>
    }
    internals.running.set('w1:web', {})
    internals.running.set('w1:api', {})
    internals.running.set('w2:web', {})
    internals.history.set('w1:web', 'web log')
    internals.history.set('w1:test', 'test log')
    internals.history.set('w2:web', 'other log')

    runner.disposeWorkspace('w1')

    expect(stop.mock.calls).toEqual(
      expect.arrayContaining([
        ['w1', 'web'],
        ['w1', 'api']
      ])
    )
    expect([...internals.history.keys()]).toEqual(['w2:web'])
  })

  it('상태는 고정 종류 대신 실제 script id를 반환한다', () => {
    const runner = new ScriptRunner(vi.fn())
    const internals = runner as unknown as { history: Map<string, string> }
    internals.history.set('w1:storybook', 'done')

    expect(runner.getStatus('w1')).toEqual([
      { scriptId: 'storybook', state: 'idle', exitCode: null }
    ])
  })
})
