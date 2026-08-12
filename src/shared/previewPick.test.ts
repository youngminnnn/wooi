import { describe, expect, it } from 'vitest'
import { formatPickedElement, type PickedElement } from './previewPick'

const base: PickedElement = {
  selector: 'div.card > button.primary',
  html: '<button class="primary">Save</button>',
  htmlTruncated: false,
  css: '.primary { padding: 4px; }',
  cssTruncated: false,
  source: null
}

describe('formatPickedElement', () => {
  it('페이지·선택자·HTML·CSS 를 한 블록에 담는다', () => {
    const out = formatPickedElement(base, 'http://localhost:5173/settings')
    expect(out).toContain('- page: http://localhost:5173/settings')
    expect(out).toContain('- selector: `div.card > button.primary`')
    expect(out).toContain('```html')
    expect(out).toContain('<button class="primary">Save</button>')
    expect(out).toContain('```css')
    expect(out).toContain('.primary { padding: 4px; }')
  })

  it('소스 위치를 알면 적고, 모르면 그 줄 자체를 넣지 않는다', () => {
    expect(formatPickedElement({ ...base, source: 'src/Card.tsx:42' }, 'u')).toContain(
      '- source: `src/Card.tsx:42`'
    )
    expect(formatPickedElement(base, 'u')).not.toContain('- source:')
  })

  it('잘린 블록에는 잘렸다고 표시한다', () => {
    const out = formatPickedElement({ ...base, htmlTruncated: true, cssTruncated: true }, 'u')
    expect(out.match(/truncated/g)).toHaveLength(2)
  })

  it('자르지 않았으면 그 표시가 없다', () => {
    expect(formatPickedElement(base, 'u')).not.toContain('truncated')
  })
})
