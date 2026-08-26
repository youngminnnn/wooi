import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/types'
import { activityLabel } from './activity'
import { buildChatRows } from './rows'

const use = (toolId: string, name = 'Read', input: unknown = { file_path: `${toolId}.ts` }): ChatItem => ({ id: `use:${toolId}`, type: 'tool_use', toolId, name, input, ts: Number(toolId) * 10 })
const result = (toolId: string): ChatItem => ({ id: `result:${toolId}`, type: 'tool_result', toolId, text: 'ok', isError: false, ts: Number(toolId) * 10 + 1 })

/** 화면과 같은 순서(newest-first)로 행을 만든다. */
const rowsOf = (newestFirst: ChatItem[]) => buildChatRows(newestFirst)

describe('activityLabel', () => {
  it('돌고 있지 않으면 아무 말도 하지 않는다', () => {
    expect(activityLabel(rowsOf([use('1')]), false)).toBeNull()
  })

  // 이 줄이 있는 이유 자체다 — 도구만 도는 구간은 멈춘 것과 구별되지 않았다.
  it('결과를 기다리는 도구는 그 도구가 하는 일을 말한다', () => {
    expect(activityLabel(rowsOf([use('1')]), true)).toBe('Reading 1.ts')
  })

  it('끝난 도구 뒤에는 다음 일을 알 수 없으므로 일반적인 말로 둔다', () => {
    expect(activityLabel(rowsOf([result('1'), use('1')]), true)).toBe('Working…')
  })

  it('묶인 도구는 마지막으로 시작한 것을 말한다', () => {
    const rows = rowsOf([use('2', 'Grep', { pattern: 'needle' }), result('1'), use('1')])
    expect(activityLabel(rows, true)).toBe('Searching for needle')
  })

  it('생각 중이면 그렇게 말한다', () => {
    const thinking: ChatItem = { id: 't', type: 'thinking', text: 'hmm', streaming: true, ts: 9 }
    expect(activityLabel(rowsOf([thinking]), true)).toBe('Thinking…')
  })

  // 커서가 이미 말하고 있다. 같은 말을 두 자리에서 하면 둘 다 신호가 아니게 된다.
  it('답을 쓰는 중이면 커서에 맡기고 비운다', () => {
    const writing: ChatItem = { id: 'a', type: 'assistant', text: 'partial', streaming: true, ts: 9 }
    expect(activityLabel(rowsOf([writing]), true)).toBeNull()
  })

  it('다 쓴 답 뒤에는 다시 일반적인 말로 돌아간다', () => {
    const done: ChatItem = { id: 'a', type: 'assistant', text: 'done', ts: 9 }
    expect(activityLabel(rowsOf([done]), true)).toBe('Working…')
  })

  it('아직 아무것도 없는 대화에서도 돌고 있으면 그렇게 말한다', () => {
    expect(activityLabel([], true)).toBe('Working…')
  })
})
