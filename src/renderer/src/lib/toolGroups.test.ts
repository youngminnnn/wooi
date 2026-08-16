import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/types'
import { buildToolGroups, formatToolGroup, toolKind } from './toolGroups'

const use = (name: string, input: unknown, toolId: string): ChatItem => ({
  id: `use:${toolId}`,
  type: 'tool_use',
  toolId,
  name,
  input,
  ts: 0
})
const result = (toolId: string): ChatItem => ({
  id: `result:${toolId}`,
  type: 'tool_result',
  toolId,
  text: 'ok',
  isError: false,
  ts: 0
})
const text = (id: string): ChatItem => ({ id, type: 'assistant', text: 'between', ts: 0 })

describe('buildToolGroups', () => {
  it('연속 호출이 하나뿐이면 묶지 않는다', () => {
    expect(buildToolGroups([use('Read', { file_path: 'a.ts' }, '1')]).groupByItemId.size).toBe(0)
  })

  it('결과 행을 사이에 둔 연속 호출 두 개부터 묶는다', () => {
    const built = buildToolGroups([
      use('Read', { file_path: 'a.ts' }, '1'),
      result('1'),
      use('Grep', { pattern: 'needle' }, '2'),
      result('2')
    ])
    expect([...built.groupByItemId.keys()]).toEqual(['use:1'])
    expect([...built.hiddenItemIds]).toEqual(['use:2'])
  })

  it('assistant 텍스트가 끼면 양쪽 단독 호출을 묶지 않는다', () => {
    expect(
      buildToolGroups([use('Read', {}, '1'), result('1'), text('a'), use('Glob', {}, '2')])
        .groupByItemId.size
    ).toBe(0)
  })

  it('Edit은 인라인 diff를 숨기지 않도록 그룹을 끊는다', () => {
    const built = buildToolGroups([
      use('Read', {}, '1'),
      use('Edit', { file_path: 'a.ts' }, '2'),
      use('Grep', {}, '3')
    ])
    expect(built.groupByItemId.size).toBe(0)
    expect(toolKind('Apply patch', {})).toBe('uncollapsible')
  })

  it('완료/진행 시제와 복수형, 여러 종류를 한 문구로 합친다', () => {
    const complete = buildToolGroups([
      use('Read', {}, '1'),
      result('1'),
      use('Read', {}, '2'),
      result('2'),
      use('Read', {}, '3'),
      result('3'),
      use('Bash', {}, '4'),
      result('4'),
      use('Bash', {}, '5'),
      result('5')
    ]).groupByItemId.get('use:1')!
    expect(formatToolGroup(complete)).toBe('Read 3 files, ran 2 shell commands')

    const active = buildToolGroups([use('Grep', {}, '6'), use('Read', {}, '7')]).groupByItemId.get(
      'use:6'
    )!
    expect(formatToolGroup(active)).toBe('Searching for 1 pattern, reading 1 file')
  })

  // 가져온 내용이 곧 답의 재료인 도구는 훑어보기가 아니다 — 묶어서 감추면 안 된다.
  it('WebFetch·WebSearch 는 묶지 않는다', () => {
    expect(toolKind('WebFetch', { url: 'https://example.com' })).toBe('uncollapsible')
    expect(toolKind('WebSearch', { query: 'wooi' })).toBe('uncollapsible')
    expect(
      buildToolGroups([use('WebFetch', {}, '1'), use('WebFetch', {}, '2')]).groupByItemId.size
    ).toBe(0)
  })

  it('체크리스트가 차지한 항목은 제외하고 그 자리에서 그룹을 끊는다', () => {
    const items = [use('Read', {}, '1'), use('Bash', {}, 'task'), use('Grep', {}, '2')]
    expect(buildToolGroups(items, new Set(['use:task'])).groupByItemId.size).toBe(0)
  })
})
