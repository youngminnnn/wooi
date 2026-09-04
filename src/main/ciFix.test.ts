import { describe, it, expect } from 'vitest'
import type { PrCheck, PrChecks } from '@shared/types'
import {
  decideCiFix,
  buildCiFixPrompt,
  checksSettled,
  failedChecks,
  CI_FIX_MAX_ATTEMPTS,
  type CiFixState
} from './ciFix'

function checks(states: PrCheck['state'][], prNumber = 7): PrChecks {
  return {
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    checks: states.map((state, i) => ({ name: `check-${i}`, state }))
  }
}

const on = { enabled: true, running: false }

describe('checksSettled / failedChecks', () => {
  it('하나라도 돌고 있으면 끝난 게 아니다', () => {
    expect(checksSettled(checks(['success', 'pending']))).toBe(false)
    expect(checksSettled(checks(['success', 'failure']))).toBe(true)
  })

  it('취소·건너뜀은 실패가 아니다', () => {
    // github.ts 의 mapCheckRun 이 CANCELLED 를 neutral 로 내린다 — 그걸 실패로 읽으면
    // 사용자가 손으로 취소한 워크플로마다 에이전트가 깨어난다.
    expect(failedChecks(checks(['neutral', 'skipped', 'success']))).toEqual([])
    expect(failedChecks(checks(['failure', 'skipped'])).map((c) => c.name)).toEqual(['check-0'])
  })
})

describe('decideCiFix — 발동 조건', () => {
  it('꺼져 있으면 아무것도 하지 않고 기록도 지운다', () => {
    const prev: CiFixState = { prNumber: 7, attempts: 2, armed: true, notifiedStop: false }
    expect(
      decideCiFix({ enabled: false, running: false, checks: checks(['failure']), prev })
    ).toEqual({
      kind: 'idle',
      state: null
    })
  })

  it('실패로 확정되면 턴을 연다', () => {
    const d = decideCiFix({ ...on, checks: checks(['failure', 'success']), prev: null })
    expect(d.kind).toBe('fix')
    if (d.kind !== 'fix') return
    expect(d.failed.map((c) => c.name)).toEqual(['check-0'])
    expect(d.state).toEqual({ prNumber: 7, attempts: 1, armed: false, notifiedStop: false })
  })

  it('아직 돌고 있는 체크가 있으면 열지 않는다', () => {
    // 실패 하나에 다른 하나가 아직 도는 중 — 재시도로 초록이 될 수도 있다.
    const d = decideCiFix({ ...on, checks: checks(['failure', 'pending']), prev: null })
    expect(d.kind).toBe('idle')
  })

  it('전부 성공이면 열지 않는다', () => {
    expect(decideCiFix({ ...on, checks: checks(['success']), prev: null }).kind).toBe('idle')
  })

  it('체크를 못 읽었으면 판단하지 않고 기록을 그대로 둔다', () => {
    const prev: CiFixState = { prNumber: 7, attempts: 2, armed: false, notifiedStop: false }
    expect(decideCiFix({ ...on, checks: null, prev })).toEqual({ kind: 'idle', state: prev })
    expect(decideCiFix({ ...on, checks: checks([]), prev })).toEqual({ kind: 'idle', state: prev })
  })

  it('이미 도는 턴이 있으면 열지 않고 기다린다', () => {
    const d = decideCiFix({ enabled: true, running: true, checks: checks(['failure']), prev: null })
    expect(d.kind).toBe('idle')
    // 시도 횟수를 축내지 않고, 다음 폴링에서 다시 볼 수 있게 armed 를 유지한다.
    expect(d.state).toMatchObject({ attempts: 0, armed: true })
  })
})

describe('decideCiFix — 루프 방지', () => {
  it('같은 실패를 다시 보아도 두 번 열지 않는다', () => {
    const first = decideCiFix({ ...on, checks: checks(['failure']), prev: null })
    expect(first.kind).toBe('fix')

    // 에이전트가 아직 아무것도 밀지 않았다 — 폴링이 같은 실패를 다시 본다.
    const second = decideCiFix({ ...on, checks: checks(['failure']), prev: first.state })
    expect(second.kind).toBe('idle')
    expect(second.state).toMatchObject({ attempts: 1 })

    // 몇 번을 더 보아도 마찬가지다.
    let state = second.state
    for (let i = 0; i < 10; i++) {
      const again = decideCiFix({ ...on, checks: checks(['failure']), prev: state })
      expect(again.kind).toBe('idle')
      state = again.state
    }
    expect(state).toMatchObject({ attempts: 1 })
  })

  it('새 CI 실행을 본 뒤에야 다시 열린다', () => {
    const first = decideCiFix({ ...on, checks: checks(['failure']), prev: null })
    // 에이전트가 밀어서 체크가 다시 돈다.
    const rerun = decideCiFix({ ...on, checks: checks(['pending']), prev: first.state })
    expect(rerun.kind).toBe('idle')
    expect(rerun.state).toMatchObject({ armed: true, attempts: 1 })

    // 그리고 또 실패했다 — 이건 새 사건이므로 연다.
    const second = decideCiFix({ ...on, checks: checks(['failure']), prev: rerun.state })
    expect(second.kind).toBe('fix')
    expect(second.state).toMatchObject({ attempts: 2 })
  })

  /** 고치고 → 밀고 → 또 실패하는 고리를 상한까지 돌린다. */
  function runLoop(rounds: number): { fixes: number; stops: number; state: CiFixState | null } {
    let state: CiFixState | null = null
    let fixes = 0
    let stops = 0
    for (let i = 0; i < rounds; i++) {
      const settled = decideCiFix({ ...on, checks: checks(['failure']), prev: state })
      if (settled.kind === 'fix') fixes++
      if (settled.kind === 'stop') stops++
      state = settled.state
      // 에이전트가 뭔가 밀어 체크가 다시 돈다.
      state = decideCiFix({ ...on, checks: checks(['pending']), prev: state }).state
    }
    return { fixes, stops, state }
  }

  it('상한을 넘겨 열지 않는다', () => {
    const { fixes } = runLoop(20)
    expect(fixes).toBe(CI_FIX_MAX_ATTEMPTS)
  })

  it('상한에 닿으면 멈춘다고 딱 한 번 알린다', () => {
    const { stops } = runLoop(20)
    expect(stops).toBe(1)
  })

  it('상한에 닿은 뒤에는 계속 조용하다', () => {
    const { state } = runLoop(20)
    const after = decideCiFix({ ...on, checks: checks(['failure']), prev: state })
    expect(after.kind).toBe('idle')
    expect(after.state).toMatchObject({ attempts: CI_FIX_MAX_ATTEMPTS, notifiedStop: true })
  })

  it('초록으로 끝나면 시도 횟수가 풀린다', () => {
    let state: CiFixState | null = decideCiFix({
      ...on,
      checks: checks(['failure']),
      prev: null
    }).state
    state = decideCiFix({ ...on, checks: checks(['success']), prev: state }).state
    expect(state).toMatchObject({ attempts: 0, armed: true, notifiedStop: false })

    // 나중에 무관한 실패가 나면 상한을 새로 받는다.
    expect(decideCiFix({ ...on, checks: checks(['failure']), prev: state }).kind).toBe('fix')
  })

  it('PR 이 바뀌면 처음부터 다시 센다', () => {
    const { state } = runLoop(20)
    expect(state).toMatchObject({ attempts: CI_FIX_MAX_ATTEMPTS })

    const other = decideCiFix({ ...on, checks: checks(['failure'], 99), prev: state })
    expect(other.kind).toBe('fix')
    expect(other.state).toMatchObject({ prNumber: 99, attempts: 1 })
  })

  it('상한 근처에서 도는 턴이 있으면 시도를 축내지 않는다', () => {
    const prev: CiFixState = {
      prNumber: 7,
      attempts: CI_FIX_MAX_ATTEMPTS - 1,
      armed: true,
      notifiedStop: false
    }
    const busy = decideCiFix({ enabled: true, running: true, checks: checks(['failure']), prev })
    expect(busy.kind).toBe('idle')
    expect(busy.state).toMatchObject({ attempts: CI_FIX_MAX_ATTEMPTS - 1, armed: true })

    // 턴이 끝난 뒤에는 남은 한 번을 그대로 쓴다.
    const free = decideCiFix({ ...on, checks: checks(['failure']), prev: busy.state })
    expect(free.kind).toBe('fix')
  })
})

describe('buildCiFixPrompt', () => {
  const base = {
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    failed: [{ name: 'CI / test', state: 'failure' as const }],
    attempt: 1,
    max: CI_FIX_MAX_ATTEMPTS
  }

  it('왜 열렸는지, 끄는 법, 몇 번째인지를 첫 문단에 적는다', () => {
    const p = buildCiFixPrompt({ ...base, logs: [] })
    // 사용자가 치지 않은 턴이라, 이유와 끄는 법이 없으면 앱이 제멋대로 구는 것으로 읽힌다.
    expect(p).toContain('automatically')
    expect(p).toContain('Checks panel')
    expect(p).toContain(`attempt 1 of ${CI_FIX_MAX_ATTEMPTS}`)
    expect(p).toContain('#7')
    expect(p).toContain('CI / test')
  })

  it('로그가 있으면 싣는다', () => {
    const p = buildCiFixPrompt({ ...base, logs: [{ checkName: 'CI / test', text: 'boom' }] })
    expect(p).toContain('boom')
    expect(p).toContain('Failure output')
  })

  it('로그를 못 가져왔으면 그렇다고 적는다 — 없는 것을 지어내지 않게', () => {
    const p = buildCiFixPrompt({ ...base, logs: [{ checkName: 'CI / test' }] })
    expect(p).not.toContain('Failure output')
    expect(p).toContain('could not read the failure logs')
  })
})
