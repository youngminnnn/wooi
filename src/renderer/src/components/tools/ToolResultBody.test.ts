import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolResultBody } from './ToolResultBody'

describe('ToolResultBody', () => {
  it('summary가 없는 옛 트랜스크립트는 기존 텍스트 접기 폴백으로 렌더한다', () => {
    const html = renderToStaticMarkup(
      createElement(ToolResultBody, {
        result: {
          id: 'old-result',
          type: 'tool_result',
          toolId: 'old-tool',
          text: 'one\ntwo\nthree\nfour\nfive',
          isError: false,
          ts: 0
        },
        verbose: false
      })
    )

    expect(html).toContain('one\ntwo\nthree')
    expect(html).not.toContain('four')
    expect(html).toContain('+2 lines')
  })
})
