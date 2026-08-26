import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type Span } from './markdown'

/** 조각을 읽기 쉬운 문자열로 — `**굵게**` 는 `bold(굵게)`. */
function show(spans: Span[]): string {
  return spans
    .map((span) => {
      const flags = [
        span.bold === true ? 'bold' : null,
        span.italic === true ? 'italic' : null,
        span.code === true ? 'code' : null,
        span.strike === true ? 'strike' : null,
        span.href === undefined ? null : `link:${span.href}`
      ].filter((flag) => flag !== null)
      return flags.length === 0 ? span.text : `${flags.join('+')}(${span.text})`
    })
    .join('')
}

describe('parseInline', () => {
  it('굵게·기울임·취소선·코드를 가른다', () => {
    expect(show(parseInline('a **b** c *d* e ~~f~~ g `h`'))).toBe(
      'a bold(b) c italic(d) e strike(f) g code(h)'
    )
  })

  it('별표 셋은 굵고 기울인 하나다', () => {
    expect(show(parseInline('***both***'))).toBe('bold+italic(both)')
  })

  it('강조 안의 강조는 플래그를 겹쳐 싣는다', () => {
    expect(show(parseInline('**run `npm test` now**'))).toBe(
      'bold(run )bold+code(npm test)bold( now)'
    )
  })

  // 코드가 강조보다 세지 않으면 셸 글롭이 통째로 기울어진다.
  it('코드 안의 별표는 강조가 아니다', () => {
    expect(show(parseInline('`ls *.ts *.tsx`'))).toBe('code(ls *.ts *.tsx)')
  })

  // 실제로 이것 때문에 파일명이 깨져 보인다 — 식별자에 밑줄은 흔하다.
  it('낱말 안의 밑줄은 기울이지 않는다', () => {
    expect(show(parseInline('call parse_tool_input twice'))).toBe('call parse_tool_input twice')
    expect(show(parseInline('_really_'))).toBe('italic(really)')
  })

  it('공백 뒤의 별표는 여는 구분자가 아니다', () => {
    expect(show(parseInline('2 * 3 * 4'))).toBe('2 * 3 * 4')
  })

  it('닫히지 않은 구분자는 글자로 남긴다', () => {
    expect(show(parseInline('**unclosed'))).toBe('**unclosed')
    expect(show(parseInline('a ` b'))).toBe('a ` b')
  })

  it('링크와 맨 주소를 모두 연다', () => {
    expect(show(parseInline('[docs](https://a.dev/x)'))).toBe('link:https://a.dev/x(docs)')
    expect(show(parseInline('see https://a.dev/x now'))).toBe(
      'see link:https://a.dev/x(https://a.dev/x) now'
    )
  })

  it('맨 주소 뒤의 문장부호는 주소에 넣지 않는다', () => {
    expect(show(parseInline('at https://a.dev/x.'))).toBe(
      'at link:https://a.dev/x(https://a.dev/x).'
    )
  })

  it('백틱 두 개는 백틱 두 개로만 닫힌다', () => {
    expect(show(parseInline('``a ` b``'))).toBe('code(a ` b)')
  })
})

describe('parseMarkdown', () => {
  it('헤딩은 세 단계까지 접는다', () => {
    const blocks = parseMarkdown('# one\n\n#### four')
    expect(blocks).toMatchObject([
      { kind: 'heading', level: 1 },
      { kind: 'heading', level: 3 }
    ])
  })

  it('코드 울타리에서 언어를 살린다', () => {
    expect(parseMarkdown('```bash\nnpm test\n```')).toEqual([
      { kind: 'code', language: 'bash', code: 'npm test' }
    ])
  })

  // 스트리밍 중에는 닫는 울타리가 아직 안 온다. 그때 백틱 세 개가 본문에 보이면 안 된다.
  it('닫히지 않은 울타리도 코드로 본다', () => {
    expect(parseMarkdown('```\nhalf way')).toEqual([
      { kind: 'code', language: null, code: 'half way' }
    ])
  })

  it('글머리표와 번호를 단계별로 매긴다', () => {
    const blocks = parseMarkdown('- top\n  - nested\n1. first\n2. second')
    expect(blocks).toMatchObject([
      { kind: 'listItem', depth: 0, marker: '•' },
      { kind: 'listItem', depth: 1, marker: '◦' },
      { kind: 'listItem', depth: 0, marker: '1.' },
      { kind: 'listItem', depth: 0, marker: '2.' }
    ])
  })

  // 2칸을 쓰는 모델과 4칸을 쓰는 모델이 둘 다 있다. 4칸을 2단계로 읽으면 한 단계가 사라진다.
  it('4칸 들여쓰기도 한 단계로 읽는다', () => {
    expect(parseMarkdown('- top\n    - nested')[1]).toMatchObject({ depth: 1 })
  })

  it('목록 항목 아래 들여쓴 줄은 그 항목에 붙인다', () => {
    const blocks = parseMarkdown('- first line\n  second line')
    expect(blocks).toHaveLength(1)
    expect(show((blocks[0] as { spans: Span[] }).spans)).toBe('first line\nsecond line')
  })

  it('규칙선을 글머리표로 읽지 않는다', () => {
    expect(parseMarkdown('a\n\n---\n\nb').map((block) => block.kind)).toEqual([
      'paragraph',
      'rule',
      'paragraph'
    ])
  })

  it('연속된 인용은 한 덩어리다', () => {
    const blocks = parseMarkdown('> one\n> two')
    expect(blocks).toHaveLength(1)
    expect(show((blocks[0] as { spans: Span[] }).spans)).toBe('one\ntwo')
  })

  // 데스크톱(CommonMark)과 일부러 다른 지점. 폰 폭에서 접으면 파일 목록이 한 줄로 흘러 붙는다.
  it('문단 안의 줄바꿈을 살린다', () => {
    const blocks = parseMarkdown('Files changed:\nsrc/a.ts\nsrc/b.ts')
    expect(blocks).toHaveLength(1)
    expect(show((blocks[0] as { spans: Span[] }).spans)).toBe('Files changed:\nsrc/a.ts\nsrc/b.ts')
  })

  it('빈 줄로 문단을 가른다', () => {
    expect(parseMarkdown('one\n\ntwo')).toHaveLength(2)
  })

  it('빈 입력은 아무것도 만들지 않는다', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n \n')).toEqual([])
  })
})
