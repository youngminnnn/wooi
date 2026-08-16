import { describe, expect, it } from 'vitest'
import type { ChatItem, ToolSummary } from '@shared/types'
import { RAW_OUTPUT_LINE_CAP, buildChatRows, capRawOutput } from './rows'

const use = (toolId: string, name = 'Read', input: unknown = { file_path: `${toolId}.ts` }): ChatItem => ({ id: `use:${toolId}`, type: 'tool_use', toolId, name, input, ts: Number(toolId) * 10 })
const result = (toolId: string, text = `result ${toolId}`, summary?: ToolSummary): ChatItem => ({ id: `result:${toolId}`, type: 'tool_result', toolId, text, isError: false, summary, ts: Number(toolId) * 10 + 1 })

describe('buildChatRows', () => {
  it('toolId로 호출과 결과를 한 카드에 짝짓고 결과 행을 숨긴다', () => {
    const rows = buildChatRows([result('1'), use('1')])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tool', card: { title: 'Read · 1.ts', body: 'result 1' } })
  })

  it('짝 없는 결과는 페이지 경계에서 잃지 않는다', () => {
    expect(buildChatRows([result('1')])[0]).toMatchObject({ kind: 'tool', id: 'result:1' })
  })

  it('연속 조회 호출을 묶고 newest-first 반환 순서를 유지한다', () => {
    const newestFirst = [{ id: 'after', type: 'assistant', text: 'after', ts: 40 } as ChatItem, result('2'), use('2', 'Grep', { pattern: 'needle' }), result('1'), use('1')]
    const rows = buildChatRows(newestFirst)
    expect(rows.map((row) => row.id)).toEqual(['after', 'use:1'])
    expect(rows[1]).toMatchObject({ kind: 'tool-group', group: { uses: [{ toolId: '1' }, { toolId: '2' }], latestHint: 'needle' } })
  })

  it('빈 thinking만 버린다', () => {
    const rows = buildChatRows([{ id: 'empty', type: 'thinking', text: ' \n ', ts: 2 }, { id: 'kept', type: 'thinking', text: 'reasoning', ts: 1 }])
    expect(rows.map((row) => row.id)).toEqual(['kept'])
  })

  it('성공은 summary를 우선하고 옛 결과와 실패는 본문 첫 줄을 쓴다', () => {
    const summary: ToolSummary = { kind: 'read', path: 'a.ts', lines: 12 }
    const failed = { ...result('3', 'permission denied\ndetail', summary), isError: true }
    const rows = buildChatRows([failed, use('3', 'WebFetch'), result('2', 'legacy first\nlegacy second'), use('2', 'WebFetch'), result('1', 'raw', summary), use('1', 'WebFetch')])
    expect(rows.map((row) => row.kind === 'tool' && row.card.subtitle)).toEqual(['permission denied', 'legacy first', 'Read a.ts (12 lines)'])
  })

  it('아직 결과가 없거나 본문이 빈 결과는 펼칠 본문을 두지 않는다', () => {
    const rows = buildChatRows([result('2', ' \n '), use('2', 'Write', { file_path: 'a.ts' }), use('1', 'Write', { file_path: 'b.ts' })])
    expect(rows.map((row) => row.kind === 'tool' && row.card.body)).toEqual([undefined, undefined])
  })

  it('펼친 원문을 200줄로 자르고 생략 줄 수를 센다', () => {
    const text = Array.from({ length: RAW_OUTPUT_LINE_CAP + 7 }, (_, index) => `line ${index + 1}`).join('\n')
    const capped = capRawOutput(text)
    expect(capped.text.split('\n')).toHaveLength(RAW_OUTPUT_LINE_CAP)
    expect(capped.text).toContain(`line ${RAW_OUTPUT_LINE_CAP}`)
    expect(capped.omittedLines).toBe(7)
  })
})
