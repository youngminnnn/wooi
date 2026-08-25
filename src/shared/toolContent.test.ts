import { describe, expect, it } from 'vitest'
import { binaryContentPlaceholder } from './toolContent'

describe('binaryContentPlaceholder', () => {
  it('Claude와 MCP 이미지 블록에서 base64 대신 형식만 표시한다', () => {
    expect(
      binaryContentPlaceholder({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'very-long-base64' }
      })
    ).toBe('[Image content omitted (image/png)]')
    expect(
      binaryContentPlaceholder({ type: 'image', mimeType: 'image/jpeg', data: 'opaque' })
    ).toBe('[Image content omitted (image/jpeg)]')
  })

  it('오디오와 blob resource도 바이너리 본문을 숨긴다', () => {
    expect(binaryContentPlaceholder({ type: 'audio', data: 'opaque' })).toBe(
      '[Audio content omitted]'
    )
    expect(
      binaryContentPlaceholder({
        type: 'resource',
        resource: { mimeType: 'application/pdf', blob: 'opaque' }
      })
    ).toBe('[Binary resource content omitted (application/pdf)]')
  })

  it('텍스트와 알 수 없는 객체는 건드리지 않는다', () => {
    expect(binaryContentPlaceholder({ type: 'text', text: 'hello' })).toBeNull()
    expect(binaryContentPlaceholder({ future: true })).toBeNull()
  })
})
