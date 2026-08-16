import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ChatItem } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  ACP_PLAN_SNAPSHOT_TOOL,
  createAcpMapperState,
  mapSessionUpdate,
  type AcpMapperState
} from './mapping'

function map(update: SessionUpdate, state: AcpMapperState = createAcpMapperState()) {
  return mapSessionUpdate(update, 'codex', state, 1000)
}

function items(result: ReturnType<typeof map>): ChatItem[] {
  return result.events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
}

describe('ACP 메시지 청크', () => {
  it('메시지 id 로 어시스턴트 델타를 이어 붙인다', () => {
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hello' }
      }).events
    ).toEqual([{ type: 'delta', id: 'codex:assistant:m1', itemType: 'assistant', text: 'hello' }])
  })

  it('생각 청크는 thinking 으로 보낸다', () => {
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'r1',
        content: { type: 'text', text: 'checking' }
      }).events[0]
    ).toMatchObject({ type: 'delta', id: 'codex:thinking:r1', itemType: 'thinking' })
  })
})

describe('ACP 도구 호출', () => {
  it('종류·제목·입력·위치를 tool_use 로 옮긴다', () => {
    const result = map({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read package.json',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'package.json' },
      locations: [{ path: '/repo/package.json', line: 1 }]
    })
    expect(items(result)[0]).toMatchObject({
      id: 'codex:tool:t1',
      type: 'tool_use',
      toolId: 't1',
      name: 'Read package.json',
      input: { path: 'package.json', locations: ['/repo/package.json'] },
      ts: 1000
    })
    expect(result.persist).toHaveLength(1)
  })

  it('diff 내용을 실행 전 도구 카드에 보존한다', () => {
    const result = map({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Edit a.txt',
      kind: 'edit',
      content: [{ type: 'diff', path: 'a.txt', oldText: 'before', newText: 'after' }]
    })
    const diff = (items(result)[0] as Extract<ChatItem, { type: 'tool_use' }>).diff
    expect(diff).toContain('--- a/a.txt')
    expect(diff).toContain('-before')
    expect(diff).toContain('+after')
  })

  it('부분 업데이트는 앞선 제목을 유지하고 완료 결과를 만든다', () => {
    const state = createAcpMapperState()
    map(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't3',
        title: 'Run tests',
        kind: 'execute',
        rawInput: { command: 'npm test' }
      },
      state
    )
    expect(
      items(
        map({ sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'in_progress' }, state)
      )[0]
    ).toMatchObject({ type: 'tool_use', name: 'Run tests' })

    const done = map(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't3',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'PASS' } }]
      },
      state
    )
    expect(items(done)[0]).toMatchObject({
      id: 'codex:toolres:t3',
      type: 'tool_result',
      text: 'PASS',
      isError: false
    })
  })

  it('실패 상태를 오류 결과로 표시한다', () => {
    expect(
      items(map({ sessionUpdate: 'tool_call_update', toolCallId: 't4', status: 'failed' }))[0]
    ).toMatchObject({ type: 'tool_result', isError: true })
  })
})

describe('ACP 계획·제어 업데이트', () => {
  it('계획 전체를 체크리스트 스냅샷으로 옮긴다', () => {
    const result = map({
      sessionUpdate: 'plan',
      entries: [{ content: 'Add tests', priority: 'high', status: 'in_progress' }]
    })
    expect(items(result)[0]).toMatchObject({
      type: 'tool_use',
      name: ACP_PLAN_SNAPSHOT_TOOL,
      input: {
        tasks: [{ subject: 'Add tests', priority: 'high', status: 'in_progress' }]
      }
    })
  })

  it('명령 목록과 현재 모드를 제어 값으로 돌려준다', () => {
    expect(
      map({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review changes', input: { hint: 'path' } }
        ]
      }).commands
    ).toEqual([{ name: 'review', description: 'Review changes', argumentHint: 'path' }])
    expect(
      map({ sessionUpdate: 'current_mode_update', currentModeId: 'mode/agent' }).currentModeId
    ).toBe('mode/agent')
  })
})

describe('모르는 ACP 업데이트', () => {
  it('고정 unknown id 한 장만 만들고 같은 종류는 중복하지 않는다', () => {
    const state = createAcpMapperState()
    const update = { sessionUpdate: 'future_update', value: 1 } as unknown as SessionUpdate
    const first = map(update, state)
    const second = map(update, state)
    expect(items(first)[0]).toEqual({
      id: 'unknown:codex:session update "future_update"',
      type: 'unknown',
      backend: 'codex',
      what: 'session update "future_update"',
      ts: 1000
    })
    expect(second.events).toEqual([])
    expect(second.persist).toEqual([])
  })
})
