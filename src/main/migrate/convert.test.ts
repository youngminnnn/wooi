import { describe, it, expect } from 'vitest'
import { convertClaudeTranscript, convertCodexTranscript, convertTranscript } from './convert'

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

describe('convertClaudeTranscript', () => {
  it('사용자·어시스턴트·사고·도구를 화면 항목으로 옮긴다', () => {
    const { items, dropped } = convertClaudeTranscript(
      jsonl([
        { type: 'custom-title', customTitle: 'ignored' },
        { type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { content: '고쳐 줘' } },
        {
          type: 'assistant',
          timestamp: '2026-08-01T00:00:01.000Z',
          message: {
            content: [
              { type: 'thinking', thinking: '무엇을 고칠까' },
              { type: 'text', text: '고치겠습니다' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
            ]
          }
        },
        {
          type: 'user',
          timestamp: '2026-08-01T00:00:02.000Z',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }]
          }
        }
      ])
    )

    expect(dropped).toBe(0)
    expect(items.map((item) => item.type)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool_use',
      'tool_result'
    ])
    expect(items[0]).toMatchObject({ type: 'user', text: '고쳐 줘', ts: 1785542400000 })
    expect(items[3]).toMatchObject({ type: 'tool_use', toolId: 'toolu_1', name: 'Bash' })
    expect(items[4]).toMatchObject({ type: 'tool_result', toolId: 'toolu_1', text: 'a\nb' })
  })

  it('항목 id 는 겹치지 않게 다시 매긴다', () => {
    const { items } = convertClaudeTranscript(
      jsonl([
        { type: 'user', message: { content: 'a' } },
        { type: 'user', message: { content: 'b' } }
      ])
    )
    expect(items.map((item) => item.id)).toEqual(['import-0', 'import-1'])
  })

  it('서브에이전트 줄과 CLI 내부 살림은 옮기지 않는다', () => {
    const { items } = convertClaudeTranscript(
      jsonl([
        { type: 'user', isSidechain: true, message: { content: '서브에이전트' } },
        { type: 'queue-operation', operation: 'enqueue', content: '큐' },
        { type: 'file-history-snapshot', snapshot: {} },
        { type: 'user', message: { content: '본 대화' } }
      ])
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ text: '본 대화' })
  })

  it('본문이 비어 있는(리댁트된) 사고는 버린다', () => {
    const { items } = convertClaudeTranscript(
      jsonl([
        {
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] }
        }
      ])
    )
    expect(items).toEqual([])
  })

  it('tool_result 의 블록 배열과 오류 표시를 읽는다', () => {
    const { items } = convertClaudeTranscript(
      jsonl([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                is_error: true,
                content: [{ type: 'text', text: 'boom' }, { type: 'image' }]
              }
            ]
          }
        }
      ])
    )
    expect(items[0]).toMatchObject({ type: 'tool_result', isError: true, text: 'boom\n[image]' })
  })

  it('깨진 줄과 빈 파일을 조용히 넘긴다', () => {
    expect(convertClaudeTranscript('')).toEqual({ items: [], dropped: 0 })
    expect(convertClaudeTranscript('not json\n[1,2]\n').items).toEqual([])
  })

  it('상한을 넘으면 최근 것부터 남기고 몇 개를 버렸는지 알려 준다', () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      type: 'user',
      message: { content: `m${index}` }
    }))
    const { items, dropped } = convertClaudeTranscript(jsonl(rows))
    expect(items).toHaveLength(1000)
    expect(dropped).toBe(200)
    expect(items[0]).toMatchObject({ text: 'm200' })
  })
})

describe('convertCodexTranscript', () => {
  const rollout = jsonl([
    { type: 'session_meta', payload: { id: 't1', cwd: '/work/a' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-01T00:00:00.000Z',
      payload: { type: 'user_message', message: '리뷰해 줘' }
    },
    {
      type: 'response_item',
      timestamp: '2026-08-01T00:00:01.000Z',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '숨김' }]
      }
    },
    {
      type: 'event_msg',
      timestamp: '2026-08-01T00:00:02.000Z',
      payload: { type: 'agent_message', message: '보겠습니다' }
    },
    {
      type: 'response_item',
      timestamp: '2026-08-01T00:00:02.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '보겠습니다' }]
      }
    },
    {
      type: 'response_item',
      timestamp: '2026-08-01T00:00:03.000Z',
      payload: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"command":"ls"}'
      }
    },
    {
      type: 'response_item',
      timestamp: '2026-08-01T00:00:04.000Z',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'a\nb' }
    },
    { type: 'event_msg', payload: { type: 'token_count', info: {} } }
  ])

  it('텍스트는 event_msg 에서, 도구는 response_item 에서 가져온다', () => {
    const { items } = convertCodexTranscript(rollout)
    expect(items.map((item) => item.type)).toEqual(['user', 'assistant', 'tool_use', 'tool_result'])
    // 같은 말이 event_msg 와 response_item 에 두 번 있어도 한 번만 옮긴다.
    expect(items.filter((item) => item.type === 'assistant')).toHaveLength(1)
    expect(items[2]).toMatchObject({ type: 'tool_use', toolId: 'call_1', name: 'shell' })
    expect(items[2].type === 'tool_use' && items[2].input).toEqual({ command: 'ls' })
    expect(items[3]).toMatchObject({ type: 'tool_result', toolId: 'call_1', text: 'a\nb' })
  })

  it('event_msg 가 없는 기록은 response_item 으로 폴백하고 developer 지시는 감춘다', () => {
    const { items } = convertCodexTranscript(
      jsonl([
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '숨김' }]
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '질문' }]
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '답' }]
          }
        }
      ])
    )
    expect(items.map((item) => item.type)).toEqual(['user', 'assistant'])
    expect(items[0]).toMatchObject({ text: '질문' })
  })

  it('custom_tool_call 과 그 출력 블록을 읽는다', () => {
    const { items } = convertCodexTranscript(
      jsonl([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(1)' }
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'c1',
            output: [{ type: 'input_text', text: 'done' }]
          }
        }
      ])
    )
    expect(items[0]).toMatchObject({ type: 'tool_use', name: 'exec' })
    expect(items[1]).toMatchObject({ type: 'tool_result', text: 'done' })
  })
})

describe('convertTranscript', () => {
  it('모르는 백엔드는 아무것도 옮기지 않는다', () => {
    expect(convertTranscript('acp' as never, 'anything')).toEqual({ items: [], dropped: 0 })
  })
})
