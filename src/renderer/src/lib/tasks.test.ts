import { describe, it, expect } from 'vitest'
import type { ChatItem } from '@shared/types'
import { buildTaskCards, taskLabel } from './tasks'

let seq = 0
const use = (name: string, input: unknown, toolId = `t${++seq}`): ChatItem => ({
  id: `use:${toolId}`,
  type: 'tool_use',
  toolId,
  name,
  input,
  ts: 0
})
const result = (toolId: string, text: string, isError = false): ChatItem => ({
  id: `res:${toolId}`,
  type: 'tool_result',
  toolId,
  text,
  isError,
  ts: 0
})
const text = (id: string): ChatItem => ({ id, type: 'assistant', text: 'hi', ts: 0 })

/** 실제 SDK 응답 문구와 같은 형태의 생성 결과. */
const created = (n: number, subject: string): string =>
  `Task #${n} created successfully: ${subject}`

describe('buildTaskCards', () => {
  it('할 일 도구가 없는 대화는 아무것도 감추지 않는다', () => {
    const items = [text('a'), use('Bash', { command: 'ls' })]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)
    expect(cardByItemId.size).toBe(0)
    expect(hiddenItemIds.size).toBe(0)
  })

  it('연속된 TaskCreate 들을 카드 한 장으로 묶고 나머지 행은 감춘다', () => {
    seq = 0
    const items = [
      use('TaskCreate', { subject: 'Read auth.ts', activeForm: 'Reading auth.ts' }, 't1'),
      result('t1', created(1, 'Read auth.ts')),
      use('TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' }, 't2'),
      result('t2', created(2, 'Write tests')),
      use('TaskCreate', { subject: 'Refactor' }, 't3'),
      result('t3', created(3, 'Refactor'))
    ]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)

    // 카드는 구간의 마지막 항목 자리에 딱 한 장.
    expect([...cardByItemId.keys()]).toEqual(['res:t3'])
    expect(cardByItemId.get('res:t3')).toEqual([
      { id: '1', subject: 'Read auth.ts', status: 'pending', activeForm: 'Reading auth.ts' },
      { id: '2', subject: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      { id: '3', subject: 'Refactor', status: 'pending' }
    ])
    // 나머지 5개는 전부 감춘다.
    expect(hiddenItemIds.size).toBe(5)
    expect(hiddenItemIds.has('res:t3')).toBe(false)
  })

  it('TaskUpdate 의 상태 변화를 이후 카드에 반영한다', () => {
    const items = [
      use('TaskCreate', { subject: 'Read auth.ts' }, 't1'),
      result('t1', created(1, 'Read auth.ts')),
      text('mid'),
      use('TaskUpdate', { taskId: '1', status: 'in_progress' }, 't2'),
      result('t2', 'Updated task #1 status')
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('res:t1')).toEqual([
      { id: '1', subject: 'Read auth.ts', status: 'pending' }
    ])
    expect(cardByItemId.get('res:t2')).toEqual([
      { id: '1', subject: 'Read auth.ts', status: 'in_progress' }
    ])
  })

  it('앞선 카드는 나중 갱신에 영향받지 않는다(스냅샷이 독립적이다)', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', created(1, 'A')),
      text('mid'),
      use('TaskUpdate', { taskId: '1', status: 'completed' }, 't2'),
      result('t2', 'ok')
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('res:t1')?.[0].status).toBe('pending')
    expect(cardByItemId.get('res:t2')?.[0].status).toBe('completed')
  })

  it('status:deleted 는 항목을 목록에서 제거한다', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', created(1, 'A')),
      use('TaskCreate', { subject: 'B' }, 't2'),
      result('t2', created(2, 'B')),
      use('TaskUpdate', { taskId: '1', status: 'deleted' }, 't3'),
      result('t3', 'deleted')
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('res:t3')).toEqual([{ id: '2', subject: 'B', status: 'pending' }])
  })

  it('subject/activeForm 갱신도 반영한다', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', created(1, 'A')),
      use('TaskUpdate', { taskId: '1', subject: 'A2', activeForm: 'Doing A2' }, 't2'),
      result('t2', 'ok')
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('res:t2')).toEqual([
      { id: '1', subject: 'A2', status: 'pending', activeForm: 'Doing A2' }
    ])
  })

  it('조회 전용 도구(TaskList/TaskGet)는 구간을 끊지 않고 함께 감춘다', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', created(1, 'A')),
      use('TaskGet', { taskId: '1' }, 't2'),
      result('t2', 'subject: A'),
      use('TaskUpdate', { taskId: '1', status: 'in_progress' }, 't3'),
      result('t3', 'ok')
    ]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)
    expect([...cardByItemId.keys()]).toEqual(['res:t3'])
    expect(hiddenItemIds.has('use:t2')).toBe(true)
    expect(hiddenItemIds.has('res:t2')).toBe(true)
  })

  it('조회만 한 구간은 카드로 승격하지 않고 원래 도구 행을 남긴다', () => {
    const items = [use('TaskList', {}, 't1'), result('t1', 'no tasks')]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)
    expect(cardByItemId.size).toBe(0)
    expect(hiddenItemIds.size).toBe(0)
  })

  it('할 일과 무관한 Task* 도구(백그라운드 에이전트)는 건드리지 않는다', () => {
    const items = [
      use('Task', { prompt: 'go' }, 't1'),
      result('t1', 'started'),
      use('TaskStop', { taskId: 'x' }, 't2'),
      result('t2', 'stopped')
    ]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)
    expect(cardByItemId.size).toBe(0)
    expect(hiddenItemIds.size).toBe(0)
  })

  it('결과가 아직 안 온 TaskCreate 도 낙관적으로 보여 준다(실행 중 라이브 갱신)', () => {
    const items = [use('TaskCreate', { subject: 'A' }, 't1')]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('use:t1')).toEqual([{ id: '', subject: 'A', status: 'pending' }])
  })

  it('생성이 실패하면 낙관적으로 넣었던 항목을 되돌린다', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', 'Error: quota exceeded', true),
      use('TaskCreate', { subject: 'B' }, 't2'),
      result('t2', created(1, 'B'))
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect(cardByItemId.get('res:t2')).toEqual([{ id: '1', subject: 'B', status: 'pending' }])
  })

  it('모르는 taskId 의 갱신은 조용히 무시한다(기록이 잘린 대화)', () => {
    const items = [
      use('TaskUpdate', { taskId: '42', status: 'completed' }, 't1'),
      result('t1', 'ok')
    ]
    const { cardByItemId, hiddenItemIds } = buildTaskCards(items)
    expect(cardByItemId.size).toBe(0)
    expect(hiddenItemIds.size).toBe(0)
  })

  it('다른 항목이 끼면 구간이 나뉘어 카드가 각각 생긴다', () => {
    const items = [
      use('TaskCreate', { subject: 'A' }, 't1'),
      result('t1', created(1, 'A')),
      use('Bash', { command: 'ls' }, 't2'),
      result('t2', 'files'),
      use('TaskCreate', { subject: 'B' }, 't3'),
      result('t3', created(2, 'B'))
    ]
    const { cardByItemId } = buildTaskCards(items)
    expect([...cardByItemId.keys()]).toEqual(['res:t1', 'res:t3'])
    expect(cardByItemId.get('res:t1')).toHaveLength(1)
    expect(cardByItemId.get('res:t3')).toHaveLength(2)
  })
})

describe('taskLabel', () => {
  it('진행 중 항목만 현재진행형(activeForm)을 쓴다', () => {
    expect(
      taskLabel({
        id: '1',
        subject: 'Run tests',
        status: 'in_progress',
        activeForm: 'Running tests'
      })
    ).toBe('Running tests')
    expect(
      taskLabel({ id: '1', subject: 'Run tests', status: 'pending', activeForm: 'Running tests' })
    ).toBe('Run tests')
    expect(taskLabel({ id: '1', subject: 'Run tests', status: 'in_progress' })).toBe('Run tests')
  })
})
