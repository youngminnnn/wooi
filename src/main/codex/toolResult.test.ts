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

  it('MCP 바이너리 콘텐츠는 base64 대신 사람이 읽을 설명만 남긴다', () => {
    const result = { content: [{ type: 'image', mimeType: 'image/png', data: 'opaque' }] }
    expect(codexToolResult({ type: 'mcpToolCall', result }).text).toBe(
      '[Image content omitted (image/png)]'
    )
  })

  it('input image/audio도 payload 대신 MIME만 남긴다', () => {
    const result = {
      content: [
        { type: 'input_image', media_type: 'image/webp', data: 'very-secret-base64' },
        { type: 'input_audio', mimeType: 'audio/wav', data: 'very-secret-base64' }
      ]
    }
    expect(codexToolResult({ type: 'mcpToolCall', result }).text).toBe(
      '[Image content omitted (image/webp)]\n[Audio content omitted (audio/wav)]'
    )
  })

  it('MCP resource link는 실행하지 않고 제목·URI·MIME만 남긴다', () => {
    const result = {
      content: [
        {
          type: 'resource_link',
          title: 'Build log',
          uri: 'https://example.test/build/42',
          mimeType: 'text/plain'
        }
      ]
    }
    expect(codexToolResult({ type: 'mcpToolCall', result }).text).toBe(
      '[Resource link: Build log (text/plain) — https://example.test/build/42]'
    )
  })

  it('embedded resource는 본문과 blob을 복제하지 않고 식별 정보만 남긴다', () => {
    const result = {
      content: [
        {
          type: 'resource',
          resource: {
            title: 'Private report',
            uri: 'file:///private/report.pdf',
            mimeType: 'application/pdf',
            text: 'do not copy this private text',
            blob: 'do-not-copy-this-binary'
          }
        }
      ]
    }
    const text = codexToolResult({ type: 'mcpToolCall', result }).text
    expect(text).toBe('[Embedded resource: Private report (application/pdf) — file:///private/report.pdf]')
    expect(text).not.toContain('private text')
    expect(text).not.toContain('do-not-copy')
  })

  it('알 수 없는 block이 섞여도 앞선 media payload를 JSON fallback으로 다시 노출하지 않는다', () => {
    const text = codexToolResult({
      type: 'mcpToolCall',
      result: {
        content: [
          { type: 'image', mediaType: 'image/png', data: 'secret-base64' },
          { type: 'future_block', data: 'another-secret' }
        ]
      }
    }).text
    expect(text).toContain('[Image content omitted (image/png)]')
    expect(text).toContain('[Unsupported content omitted]')
    expect(text).not.toContain('secret-base64')
    expect(text).not.toContain('another-secret')
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

  it('imageGeneration savedPath를 사용자에게 보이는 결과로 보존한다', () => {
    expect(
      codexToolResult({
        type: 'imageGeneration',
        savedPath: '/tmp/codex/generated-chart.png'
      })
    ).toEqual({ text: 'Generated image: /tmp/codex/generated-chart.png' })
  })

  it('모르는 결과 모양은 기존 텍스트 폴백을 유지한다', () => {
    expect(codexToolResult({ type: 'sleep', result: { ok: true } })).toEqual({
      text: '{\n  "ok": true\n}'
    })
  })

})
