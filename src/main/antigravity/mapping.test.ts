import type { ChatItem } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  createMapperState,
  mapEvent,
  mapExitStderr,
  rememberOptimisticUser,
  type MapperState
} from './mapping'
import type { AntigravityEvent } from './protocol'

function map(event: AntigravityEvent, state: MapperState = createMapperState('run1')) {
  return mapEvent(event, state)
}

function items(result: ReturnType<typeof map>): ChatItem[] {
  return result.events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
}

function step(step_update: Record<string, unknown>): AntigravityEvent {
  return { event: 'step_update', step_update } as AntigravityEvent
}

describe('세션과 응답', () => {
  it('init 의 conversation id 와 모델을 세션으로 넘긴다', () => {
    expect(
      map({
        event: 'init',
        conversation_id: 'conv-1',
        init: { model: 'gemini' }
      } as AntigravityEvent).events
    ).toEqual([{ type: 'session', sessionId: 'conv-1', model: 'gemini' }])
  })

  it('assistant 델타를 같은 버블에 보내고 DONE 때 하나만 저장한다', () => {
    const state = createMapperState('run1')
    const a = map(
      step({ step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hel' }),
      state
    )
    const b = map(
      step({ step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'lo ' }),
      state
    )
    const done = map(
      step({ step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'world' }),
      state
    )
    expect(a.events[0]).toMatchObject({ type: 'delta', id: 'antigravity:run1:step:2', text: 'hel' })
    expect(b.events[0]).toMatchObject({ id: 'antigravity:run1:step:2', text: 'lo ' })
    expect(done.persist).toEqual([
      expect.objectContaining({ type: 'assistant', text: 'hello world' })
    ])
  })

  it('payload 가 빠진 init 도 던지지 않는다', () => {
    expect(() => map({ event: 'init', init: {} } as AntigravityEvent)).not.toThrow()
    expect(map({ event: 'init', init: {} } as AntigravityEvent)).toEqual({
      events: [],
      persist: []
    })
  })
})

describe('도구', () => {
  it('일반 도구 ACTIVE→DONE을 tool_use와 tool_result로 확정한다', () => {
    const state = createMapperState('run1')
    const active = map(
      step({
        step_index: 3,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_info: { name: 'search', parameters: { q: 'x' } }
      }),
      state
    )
    expect(items(active)[0]).toMatchObject({ type: 'tool_use', name: 'search', input: { q: 'x' } })
    const done = map(
      step({
        step_index: 3,
        step_type: 'tool',
        state: 'DONE',
        tool_info: { name: 'search', output: 'found' }
      }),
      state
    )
    expect(items(done)).toEqual([
      expect.objectContaining({ type: 'tool_use', name: 'search' }),
      expect.objectContaining({ type: 'tool_result', text: 'found', isError: false })
    ])
    expect(done.persist).toHaveLength(2)
  })

  it('run_command를 CommandLine 명령의 bash 카드로 만든다', () => {
    const state = createMapperState('run1')
    map(
      step({
        step_index: 4,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello' } }
      }),
      state
    )
    const done = map(
      step({
        step_index: 4,
        step_type: 'tool',
        state: 'DONE',
        tool_info: { name: 'run_command', output: 'hello\n' }
      }),
      state
    )
    expect(items(done)[0]).toMatchObject({
      type: 'bash',
      agent: true,
      command: 'echo hello',
      output: 'hello\n',
      exitCode: null,
      running: false
    })
  })

  it('tool_info.error를 오류 tool_result로 만든다', () => {
    const done = map(
      step({
        step_index: 5,
        step_type: 'tool',
        state: 'DONE',
        tool_info: { name: 'search', error: { type: 'Denied', message: 'nope' } }
      })
    )
    expect(items(done)[1]).toMatchObject({ type: 'tool_result', text: 'nope', isError: true })
  })

  it('파일 쓰기 도구 완료 뒤 git 재조회 신호를 보낸다', () => {
    const done = map(
      step({
        step_index: 6,
        step_type: 'tool',
        state: 'DONE',
        tool_info: { name: 'write_to_file', output: 'ok' }
      })
    )
    expect(done.events).toContainEqual({ type: 'workingTreeChanged' })
  })

  it('checkpoint는 의도적으로 아무것도 만들지 않는다', () => {
    expect(map(step({ step_index: 7, step_type: 'checkpoint', state: 'DONE' }))).toEqual({
      events: [],
      persist: []
    })
  })
})

describe('사용자 echo와 결과', () => {
  it('낙관적으로 표시한 동일 사용자 echo만 억제한다', () => {
    const state = createMapperState('run1')
    rememberOptimisticUser(state, 'hello')
    expect(
      map(
        step({ step_index: 8, step_type: 'user_input', state: 'DONE', text_delta: 'hello' }),
        state
      )
    ).toEqual({ events: [], persist: [] })
    expect(
      items(
        map(
          step({ step_index: 9, step_type: 'user_input', state: 'DONE', text_delta: 'different' }),
          state
        )
      )[0]
    ).toMatchObject({ type: 'user', text: 'different' })
  })

  it('result를 비용 없는 요약 카드로 만든다', () => {
    const result = items(
      map({
        event: 'result',
        result: { status: 'ERROR', duration_seconds: 1.25, num_turns: 3 }
      } as AntigravityEvent)
    )[0] as Extract<ChatItem, { type: 'result' }>
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error',
      isError: true,
      // durationMs 는 CLI 값이 아니라 우리가 잰 벽시계 시간이라 여기서 고정하지 않는다.
      numTurns: 3
    })
    expect(result.costUsd).toBeUndefined()
  })
})

describe('모르는 입력', () => {
  it('모르는 event와 step_type을 서로 다른 unknown 카드로 만든다', () => {
    const seen: string[] = []
    const event = mapEvent({ event: 'future_event' }, createMapperState('run1'), (what) =>
      seen.push(what)
    )
    const kind = mapEvent(
      step({ step_index: 10, step_type: 'future_step', state: 'DONE' }),
      createMapperState('run1'),
      (what) => seen.push(what)
    )
    expect(items(event)).toHaveLength(1)
    expect(items(kind)).toHaveLength(1)
    expect(items(event)[0].id).not.toBe(items(kind)[0].id)
    expect(seen).toEqual(['event "future_event"', 'step type "future_step"'])
  })
})

describe('종료 stderr', () => {
  const denied =
    'jetski: no output produced — a tool required permission, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json.'

  it('중단은 표시하지 않는다', () =>
    expect(mapExitStderr('error', 1, true)).toEqual({ events: [], persist: [] }))
  it('비정상 종료는 error로 만든다', () =>
    expect(items(mapExitStderr('boom', 2, false))[0]).toMatchObject({
      type: 'error',
      text: 'boom'
    }))
  it('정상 종료의 빈 stderr는 표시하지 않는다', () =>
    expect(mapExitStderr('  ', 0, false)).toEqual({ events: [], persist: [] }))
  it('정상 종료 stderr는 system으로 원문을 보존한다', () =>
    expect(items(mapExitStderr('warning', 0, false))[0]).toMatchObject({
      type: 'system',
      text: 'warning'
    }))
  it('auto-deny에는 Wooi Full access 안내와 CLI 원문을 함께 둔다', () => {
    const item = items(mapExitStderr(denied, 0, false))[0] as Extract<ChatItem, { type: 'system' }>
    expect(item.text).toMatch(/Full access/)
    expect(item.text).toContain(denied)
  })
})

/**
 * 이 백엔드는 턴마다 프로세스를 새로 띄우고 step_index 는 매번 0 부터 다시 센다. Wooi 아이템은
 * id 기준 upsert 라, 실행을 구분하는 접두사가 빠지면 다음 턴이 이전 턴의 말풍선과 도구 카드를
 * **덮어써서 대화가 지워진다**. 눈에 띄지 않는 종류의 손실이라 여기서 못박아 둔다.
 */
describe('실행 간 아이템 id 충돌', () => {
  const doneStep = (index: number): AntigravityEvent => ({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: index,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'hi'
    }
  })

  it('같은 step_index 라도 실행이 다르면 id 가 다르다', () => {
    const first = mapEvent(doneStep(0), createMapperState('run-a')).persist[0]
    const second = mapEvent(doneStep(0), createMapperState('run-b')).persist[0]
    expect(first.id).not.toBe(second.id)
  })

  it('result 카드도 실행마다 별개다', () => {
    const result: AntigravityEvent = {
      event: 'result',
      result: {
        conversation_id: 'c',
        status: 'SUCCESS',
        response: '',
        duration_seconds: 1,
        num_turns: 1
      }
    }
    const first = mapEvent(result, createMapperState('run-a')).persist[0]
    const second = mapEvent(result, createMapperState('run-b')).persist[0]
    expect(first.id).not.toBe(second.id)
  })
})

/**
 * 실물 `agy` 1.1.13 이 로그인 전 headless 실행에서 그대로 내보낸 result 이벤트다.
 * `error` 는 문서의 stream-json 스키마에 없지만 실제로는 온다 — 유일한 실패 설명이라 버리면 안 된다.
 */
describe('실측 — 로그인 전 result', () => {
  const real: AntigravityEvent = JSON.parse(
    '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}'
  )

  it('실패 사유를 error 카드로 보여 주고 result 카드도 남긴다', () => {
    const out = items(mapEvent(real, createMapperState('run1')))
    expect(out.map((i) => i.type)).toEqual(['error', 'result'])
    expect(out[0]).toMatchObject({ text: 'authentication failed or timed out' })
    expect(out[1]).toMatchObject({ subtype: 'error', isError: true })
  })
})

/**
 * 아래는 전부 실물 `agy` 1.1.13 이 실제로 내보낸 모양이다. 문서에 없는 것들이라, 실측 없이는
 * 알 수 없었고 그대로 두면 조용히 깨졌을 자리들이다.
 */
describe('실측 — 문서에 없는 스텝 모양', () => {
  it('권한 거부는 state:"ERROR" 로 끝난다 — DONE 만 종료로 보면 카드가 영원히 실행 중이다', () => {
    const state = createMapperState('run1')
    const active: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi-from-agy"}}}}'
    )
    const failed: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.13,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi-from-agy"},"error":{"type":"TOOL_ERROR","message":"User denied permission to run command:\\necho hi-from-agy"}}}}'
    )
    expect(mapEvent(active, state).persist).toEqual([])
    const out = mapEvent(failed, state).persist[0] as Extract<ChatItem, { type: 'bash' }>
    expect(out).toMatchObject({ type: 'bash', command: 'echo hi-from-agy', running: false })
    expect(out.output).toContain('User denied permission')
  })

  it('step_type "unknown" 은 정상 값이라 unknown 카드를 만들지 않는다', () => {
    // 실측에서 **매 턴** step_index 1 에 들어온다. 카드로 만들면 턴마다 한 장씩 쌓인다.
    const real: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.001039}}'
    )
    expect(mapEvent(real, createMapperState('run1'))).toEqual({ events: [], persist: [] })
  })

  it('step_type "error_message" 도 페이로드가 없어 카드를 만들지 않는다', () => {
    const real: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"error_message"}}'
    )
    expect(mapEvent(real, createMapperState('run1'))).toEqual({ events: [], persist: [] })
  })

  it('agent_response 의 최종 텍스트는 DONE 이벤트에 통째로 실려 온다', () => {
    // 실측: stream-json 이어도 텍스트는 조각으로 나뉘지 않고 DONE 한 번에 온다.
    const real: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":7,"state":"DONE","step_type":"agent_response","text_delta":"Created NOTES.md.","duration_seconds":1.7}}'
    )
    const out = mapEvent(real, createMapperState('run1'))
    expect(out.persist[0]).toMatchObject({ type: 'assistant', text: 'Created NOTES.md.' })
  })

  it('텍스트 없는 agent_response(도구 호출 턴)는 빈 말풍선을 만들지 않는다', () => {
    const real: AntigravityEvent = JSON.parse(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"agent_response","duration_seconds":1.77,"usage":{"input_tokens":16509,"output_tokens":71,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":16580}}}'
    )
    expect(mapEvent(real, createMapperState('run1')).persist).toEqual([])
  })
})

describe('턴 소요 시간', () => {
  it('CLI 의 duration_seconds 가 아니라 우리가 잰 시간을 쓴다', () => {
    // 실측에서 이어진 턴의 duration_seconds 가 753 초로 왔다 — 응답이 걸린 시간이 아니다.
    const state = createMapperState('run1')
    state.turnStartedAt = Date.now() - 2_000
    const real: AntigravityEvent = JSON.parse(
      '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"ok","duration_seconds":753.7,"num_turns":2}}'
    )
    const item = mapEvent(real, state).persist[0] as Extract<ChatItem, { type: 'result' }>
    expect(item.durationMs).toBeGreaterThanOrEqual(2_000)
    expect(item.durationMs).toBeLessThan(60_000)
  })
})
