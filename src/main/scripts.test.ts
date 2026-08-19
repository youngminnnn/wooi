import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { HISTORY_LIMIT, ScriptRunner } from './scripts'

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

/**
 * 재시작은 "죽이고 곧바로 띄우기" 다. kill 은 비동기라 옛 프로세스의 close 가 새 프로세스보다
 * 늦게 도착하는데, 그 종료를 새 실행의 것으로 읽으면 방금 뜬 dev 서버가 "종료됨" 으로 보이고
 * setup 재실행은 시작하자마자 실패로 표시된다. 실제 셸을 띄워 순서째로 확인한다.
 */
describe('ScriptRunner 재시작', () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('옛 프로세스의 종료를 새 실행의 것으로 알리지 않는다', async () => {
    const dispatch = vi.fn()
    const runner = new ScriptRunner(dispatch)
    try {
      runner.run('w1', 'dev', 'sleep 30', tmpdir())
      await settle(200)
      dispatch.mockClear()

      runner.run('w1', 'dev', 'sleep 30', tmpdir())
      await settle(600)

      const exits = dispatch.mock.calls.filter(([channel]) => channel === 'evt:scriptExit')
      expect(exits).toEqual([])
      // 꼬리 버퍼도 깨끗해야 한다 — 나중에 뜬 패널이 이 줄을 그대로 보여 준다.
      expect(runner.getOutput('w1', 'dev')).not.toContain('exited')
      expect(runner.getStatus('w1')).toEqual([
        { scriptId: 'dev', state: 'running', exitCode: null }
      ])
    } finally {
      runner.disposeAll()
    }
  })

  // 위 가드가 "자리가 비었을 때" 까지 막으면 사용자가 직접 중지했을 때 종료 표시가 사라진다.
  it('사용자가 중지하면 종료를 그대로 알린다', async () => {
    const dispatch = vi.fn()
    const runner = new ScriptRunner(dispatch)
    try {
      runner.run('w1', 'dev', 'sleep 30', tmpdir())
      await settle(200)
      dispatch.mockClear()

      runner.stop('w1', 'dev')
      await settle(600)

      const exits = dispatch.mock.calls.filter(([channel]) => channel === 'evt:scriptExit')
      expect(exits).toHaveLength(1)
    } finally {
      runner.disposeAll()
    }
  })
})

/**
 * 아카이브 스크립트가 실패했을 때 사용자가 그것을 알 수 있는지는 전적으로 이 반환값에 달렸다
 * — 여기서 종료 코드나 출력을 잃으면 `docker compose down` 이 실패해도 화면에는 아무 일도
 * 일어나지 않는다. 실제 셸을 띄워 확인한다(파이프·프로세스 그룹까지 함께 검증된다).
 */
describe('ScriptRunner.runOnce', () => {
  const runner = new ScriptRunner(vi.fn())
  const cwd = tmpdir()

  it('성공하면 코드 0 과 출력을 돌려준다', async () => {
    const res = await runner.runOnce('echo hi', cwd)

    expect(res).toMatchObject({ code: 0, timedOut: false })
    expect(res.output).toContain('hi')
  })

  it('빈 명령은 실행하지 않고 성공으로 친다', async () => {
    await expect(runner.runOnce('   ', cwd)).resolves.toEqual({
      code: 0,
      timedOut: false,
      output: ''
    })
  })

  // stderr 만 남기고 죽는 정리 스크립트가 흔하다 — 코드와 함께 그 출력도 잡아야 진단이 된다.
  it('실패하면 0 이 아닌 코드와 stderr 를 함께 돌려준다', async () => {
    const res = await runner.runOnce('echo boom >&2; exit 3', cwd)

    expect(res).toMatchObject({ code: 3, timedOut: false })
    expect(res.output).toContain('boom')
  })

  // 타임아웃과 정상 종료가 섞이면 "코드 없음" 이 시작 실패인지 멈춘 것인지 알 수 없다.
  it('타임아웃은 정상 종료와 구분된다', async () => {
    const res = await runner.runOnce('sleep 30', cwd, 200)

    expect(res).toMatchObject({ code: null, timedOut: true })
  })

  // 출력이 무한정 자라면 그대로 메인 프로세스 메모리다. 최신 부분만 남기고 앞을 버린다.
  it('출력이 상한을 넘으면 꼬리만 남긴다', async () => {
    const size = HISTORY_LIMIT + 50_000
    const res = await runner.runOnce(`head -c ${size} /dev/zero | tr '\\0' 'x'`, cwd)

    expect(res.code).toBe(0)
    expect(res.output.length).toBe(HISTORY_LIMIT)
    expect(res.output.endsWith('x')).toBe(true)
  })
})
