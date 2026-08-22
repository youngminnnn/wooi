import { describe, expect, it, vi } from 'vitest'

import { evaluateStopHook } from './stop-gate.mjs'

const 성공 = { status: 0, output: '', timedOut: false }

function 메모리캐시() {
  let 저장값: string | null = null
  return {
    read: vi.fn(() => 저장값),
    write: vi.fn((_cwd: string, fingerprint: string) => {
      저장값 = fingerprint
    })
  }
}

const 지문 = (files: string[]) => files.join('|')

describe('Claude Code Stop 품질 게이트', () => {
  it('Stop hook 이 시작한 turn 은 아무 검사 없이 끝낸다', () => {
    const changedFiles = vi.fn(() => ['src/main/index.ts'])
    const runner = vi.fn(() => 성공)

    const result = evaluateStopHook(
      { stop_hook_active: true },
      { changedFiles, runner, env: {}, fingerprinter: 지문, fingerprintCache: 메모리캐시() }
    )

    expect(result.code).toBe(0)
    expect(changedFiles).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
  })

  it('관련 없는 변경은 아무 검사 없이 통과한다', () => {
    const runner = vi.fn(() => 성공)
    const result = evaluateStopHook(
      { stop_hook_active: false },
      {
        changedFiles: () => ['README.md', '.claude/settings.json'],
        runner,
        env: {},
        fingerprinter: 지문,
        fingerprintCache: 메모리캐시()
      }
    )

    expect(result.code).toBe(0)
    expect(runner).not.toHaveBeenCalled()
  })

  it('renderer 변경만 있으면 저렴한 검사만 실행한다', () => {
    const runner = vi.fn(() => 성공)
    const result = evaluateStopHook(
      { stop_hook_active: false },
      {
        changedFiles: () => ['src/renderer/src/App.tsx'],
        runner,
        env: {},
        fingerprinter: 지문,
        fingerprintCache: 메모리캐시()
      }
    )

    expect(result.code).toBe(0)
    expect(runner.mock.calls.map(([gate]) => gate)).toEqual(['typecheck:web', 'test:renderer'])
  })

  it('실패한 검사는 이름과 출력으로 stop 을 막는다', () => {
    const runner = vi.fn((gate: string) =>
      gate === 'typecheck'
        ? { status: 1, output: 'src/main/index.ts(1,1): error TS2322: bad type', timedOut: false }
        : 성공
    )
    const result = evaluateStopHook(
      { stop_hook_active: false },
      {
        changedFiles: () => ['src/main/index.ts'],
        runner,
        env: {},
        fingerprinter: 지문,
        fingerprintCache: 메모리캐시()
      }
    )

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('npm run typecheck')
    expect(result.stderr).toContain('error TS2322')
  })

  it('검사가 timeout 되면 session 을 막지 않는다', () => {
    const result = evaluateStopHook(
      { stop_hook_active: false },
      {
        changedFiles: () => ['src/renderer/src/App.tsx'],
        runner: () => ({ status: null, output: '', timedOut: true }),
        env: {},
        fingerprinter: 지문,
        fingerprintCache: 메모리캐시()
      }
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('timed out')
  })

  it('성공한 지문이 같으면 다음 호출은 검사를 실행하지 않는다', () => {
    const runner = vi.fn(() => 성공)
    const fingerprintCache = 메모리캐시()
    const options = {
      changedFiles: () => ['src/main/index.ts'],
      runner,
      env: {},
      fingerprinter: () => '같은-지문',
      fingerprintCache
    }

    expect(evaluateStopHook({}, options).code).toBe(0)
    expect(evaluateStopHook({}, options)).toMatchObject({ code: 0, ran: [] })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('파일을 편집해 지문이 바뀌면 검사를 다시 실행한다', () => {
    const runner = vi.fn(() => 성공)
    const fingerprintCache = 메모리캐시()
    let fingerprint = '편집-전'
    const options = {
      changedFiles: () => ['src/main/index.ts'],
      runner,
      env: {},
      fingerprinter: () => fingerprint,
      fingerprintCache
    }

    expect(evaluateStopHook({}, options).code).toBe(0)
    fingerprint = '편집-후'
    expect(evaluateStopHook({}, options).code).toBe(0)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('실패한 지문은 저장하지 않아 다음 호출도 다시 막는다', () => {
    const runner = vi.fn(() => ({ status: 1, output: 'broken', timedOut: false }))
    const fingerprintCache = 메모리캐시()
    const options = {
      changedFiles: () => ['src/main/index.ts'],
      runner,
      env: {},
      fingerprinter: () => '실패-지문',
      fingerprintCache
    }

    expect(evaluateStopHook({}, options).code).toBe(2)
    expect(evaluateStopHook({}, options).code).toBe(2)
    expect(runner).toHaveBeenCalledTimes(2)
    expect(fingerprintCache.write).not.toHaveBeenCalled()
  })

  it('손상되거나 읽을 수 없는 상태는 cache miss 로 처리한다', () => {
    const runner = vi.fn(() => 성공)
    const fingerprintCache = {
      read: vi.fn(() => {
        throw new Error('corrupt')
      }),
      write: vi.fn()
    }

    expect(() =>
      evaluateStopHook(
        {},
        {
          changedFiles: () => ['src/main/index.ts'],
          runner,
          env: {},
          fingerprinter: () => '새-지문',
          fingerprintCache
        }
      )
    ).not.toThrow()
    expect(runner).toHaveBeenCalledTimes(2)
  })
})
