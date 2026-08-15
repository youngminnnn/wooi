import { describe, expect, it, vi } from 'vitest'
import type { AntigravityEvent } from './protocol'
import { createAntigravityStream } from './stream'

function harness(): {
  events: AntigravityEvent[]
  unparsable: string[]
  push: (chunk: string) => void
  end: () => void
} {
  const events: AntigravityEvent[] = []
  const unparsable: string[] = []
  const reader = createAntigravityStream(
    (event) => events.push(event),
    (line) => unparsable.push(line)
  )
  return { events, unparsable, push: reader.push, end: reader.end }
}

const init = {
  event: 'init',
  conversation_id: 'c1',
  init: { cwd: '/tmp', tools: [], permission_mode: 'plan' }
}
const result = {
  event: 'result',
  result: {
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: 'ok',
    duration_seconds: 1,
    num_turns: 1
  }
}

describe('createAntigravityStream', () => {
  it('한 청크의 이벤트를 읽는다', () => {
    const h = harness()
    h.push(`${JSON.stringify(init)}\n`)
    expect(h.events).toEqual([init])
  })

  it('세 청크로 잘린 이벤트를 이어 붙인다', () => {
    const h = harness()
    h.push('{"event":"in')
    h.push('it","conversation_id":"c1","init":{"cwd":"/tmp",')
    h.push('"tools":[],"permission_mode":"plan"}}\n')
    expect(h.events).toEqual([init])
  })

  it('한 청크의 여러 이벤트를 모두 읽는다', () => {
    const h = harness()
    h.push(`${JSON.stringify(init)}\n${JSON.stringify(result)}\n`)
    expect(h.events).toEqual([init, result])
  })

  it('빈 줄은 조용히 건너뛴다', () => {
    const h = harness()
    h.push(`\n  \n${JSON.stringify(init)}\n\n`)
    expect(h.events).toEqual([init])
    expect(h.unparsable).toEqual([])
  })

  it('쓰레기 줄 뒤에도 유효한 이벤트를 계속 읽는다', () => {
    const h = harness()
    h.push(`${JSON.stringify(init)}\ndiagnostic text\n${JSON.stringify(result)}\n`)
    expect(h.events).toEqual([init, result])
    expect(h.unparsable).toEqual(['diagnostic text'])
  })

  it('개행 없는 마지막 줄을 end 에서 내보낸다', () => {
    const h = harness()
    h.push(JSON.stringify(result))
    expect(h.events).toEqual([])
    h.end()
    expect(h.events).toEqual([result])
  })

  it('CRLF 입력을 읽는다', () => {
    const h = harness()
    h.push(`${JSON.stringify(init)}\r\n${JSON.stringify(result)}\r\n`)
    expect(h.events).toEqual([init, result])
  })

  it('event 필드가 없는 JSON 을 unparsable 로 보낸다', () => {
    const onUnparsable = vi.fn()
    const reader = createAntigravityStream(() => {}, onUnparsable)
    reader.push('{"message":"no event"}\n')
    expect(onUnparsable).toHaveBeenCalledWith('{"message":"no event"}')
  })

  it('새 이벤트 이름은 데이터로 전달한다', () => {
    const h = harness()
    h.push('{"event":"future_event","payload":1}\n')
    expect(h.events).toEqual([{ event: 'future_event', payload: 1 }])
  })
})
