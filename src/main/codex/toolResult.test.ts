import { describe, expect, it } from 'vitest'
import { codexToolResult } from './toolResult'

describe('codexToolResult', () => {
  it('MCP 표준 텍스트 블록의 포장만 벗긴다', () => {
    expect(
      codexToolResult({
        type: 'mcpToolCall',
        result: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' }
          ],
          structuredContent: { large: '도구마다 뜻이 다르므로 요약하지 않는다' }
        }
      })
    ).toEqual({ text: 'first\nsecond' })
  })

  it('빈 MCP 결과만 확실한 작은 요약으로 남긴다', () => {
    expect(codexToolResult({ type: 'mcpToolCall', result: { content: [] } })).toEqual({
      text: '',
      summary: { kind: 'output', empty: true }
    })
  })

  it('비텍스트 MCP 콘텐츠는 정보가 사라지지 않게 JSON 폴백한다', () => {
    const result = { content: [{ type: 'image', data: 'opaque' }] }
    expect(codexToolResult({ type: 'mcpToolCall', result }).text).toBe(
      JSON.stringify(result, null, 2)
    )
  })

  it('dynamic tool의 텍스트 콘텐츠를 꺼낸다', () => {
    expect(
      codexToolResult({
        type: 'dynamicToolCall',
        contentItems: [{ type: 'inputText', text: 'ok' }]
      })
    ).toEqual({ text: 'ok' })
  })

  it('이미지 조회는 줄 수를 지어내지 않고 경로만 요약한다', () => {
    expect(codexToolResult({ type: 'imageView', path: '/tmp/a.png' })).toEqual({
      text: 'Done.',
      summary: { kind: 'view', path: '/tmp/a.png' }
    })
  })

  it('모르는 결과 모양은 기존 텍스트 폴백을 유지한다', () => {
    expect(codexToolResult({ type: 'sleep', result: { ok: true } })).toEqual({
      text: '{\n  "ok": true\n}'
    })
  })
})
