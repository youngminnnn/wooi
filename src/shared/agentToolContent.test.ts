import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_IMAGE_KEY, agentToolContent } from './agentToolContent'

/**
 * 이 테스트가 지키려는 것.
 *
 * 이미지가 실려 있을 때 텍스트 블록에 `_image` 가 그대로 남으면 같은 base64 가 두 번(텍스트로 한 번,
 * image 블록으로 한 번) 모델에게 간다 — 컨텍스트가 두 배로 나가고, 모델은 텍스트 쪽의 난수 문자열도
 * 읽어야 한다. 그래서 "텍스트에서 빠졌는가" 와 "이미지가 아닌 것은 절대 이미지로 취급하지 않는가"
 * 를 가장 두껍게 본다.
 */

describe('agentToolContent', () => {
  it('이미지가 없으면 text 블록 하나로만 나온다', () => {
    const data = { url: 'http://localhost:5173/', width: 800 }

    expect(agentToolContent(data)).toEqual([{ type: 'text', text: JSON.stringify(data) }])
  })

  it('undefined 를 넘기면 text 가 null 이다', () => {
    expect(agentToolContent(undefined)).toEqual([{ type: 'text', text: 'null' }])
  })

  it('_image 가 실려 있으면 text 가 먼저, image 가 뒤에 온다', () => {
    const data = {
      url: 'http://localhost:5173/',
      [AGENT_TOOL_IMAGE_KEY]: { dataBase64: 'AAAA', mediaType: 'image/png' }
    }

    expect(agentToolContent(data)).toEqual([
      { type: 'text', text: JSON.stringify({ url: 'http://localhost:5173/' }) },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ])
  })

  it('text 블록의 JSON 에 _image 키가 없다 — 나머지 필드는 그대로 남는다', () => {
    const data = {
      url: 'http://localhost:5173/',
      width: 800,
      height: 600,
      [AGENT_TOOL_IMAGE_KEY]: { dataBase64: 'AAAA', mediaType: 'image/png' }
    }

    const [text] = agentToolContent(data)
    const parsed = JSON.parse((text as { text: string }).text)
    expect(parsed).not.toHaveProperty(AGENT_TOOL_IMAGE_KEY)
    expect(parsed).toEqual({ url: 'http://localhost:5173/', width: 800, height: 600 })
  })

  it('_image 가 문자열이면 이미지로 취급하지 않는다', () => {
    const data = { url: 'x', [AGENT_TOOL_IMAGE_KEY]: 'not-an-object' }

    expect(agentToolContent(data)).toEqual([{ type: 'text', text: JSON.stringify(data) }])
  })

  it('_image 가 null 이면 이미지로 취급하지 않는다', () => {
    const data = { url: 'x', [AGENT_TOOL_IMAGE_KEY]: null }

    expect(agentToolContent(data)).toEqual([{ type: 'text', text: JSON.stringify(data) }])
  })

  it('dataBase64 가 빈 문자열이면 이미지로 취급하지 않는다', () => {
    const data = { url: 'x', [AGENT_TOOL_IMAGE_KEY]: { dataBase64: '', mediaType: 'image/png' } }

    expect(agentToolContent(data)).toEqual([{ type: 'text', text: JSON.stringify(data) }])
  })

  it('mediaType 이 없으면 이미지로 취급하지 않는다', () => {
    const data = { url: 'x', [AGENT_TOOL_IMAGE_KEY]: { dataBase64: 'AAAA' } }

    expect(agentToolContent(data)).toEqual([{ type: 'text', text: JSON.stringify(data) }])
  })

  it.each([
    ['배열', ['a', 'b']],
    ['문자열', 'plain text'],
    ['숫자', 42],
    ['null', null]
  ])('data 가 %s 여도 던지지 않고 text 블록 하나로 나온다', (_label, value) => {
    expect(agentToolContent(value)).toEqual([{ type: 'text', text: JSON.stringify(value ?? null) }])
  })
})
