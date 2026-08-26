/**
 * 마크다운을 **그릴 수 있는 조각**으로 쪼갠다. 그리는 일은 `components/RichText.tsx` 가 한다.
 *
 * 데스크톱은 react-markdown + remark-gfm 을 쓰지만(ChatPrimitives 의 `MarkdownBody`) 그건
 * DOM 렌더러라 RN 에서는 한 줄도 재사용할 수 없다. 라이브러리를 새로 붙이는 대신 직접
 * 쪼개는 이유는 두 가지다 — 에이전트 답변에 실제로 나오는 문법이 여기 있는 여섯 가지뿐이고,
 * 순수 함수라 **노드에서 테스트할 수 있다**(vitest.config.mts 가 화면은 대상에서 뺀다).
 *
 * 데스크톱과 일부러 다른 것이 하나 있다: **문단 안의 줄바꿈을 살린다.** CommonMark 와
 * 데스크톱 CSS 는 이걸 공백으로 접지만, 폰 폭에서 접으면
 *
 *     Files changed:
 *     src/a.ts
 *     src/b.ts
 *
 * 이 한 줄로 흘러 붙어 읽을 수 없게 된다. 넓은 화면에서 미관을 얻는 규칙이 좁은 화면에서는
 * 내용을 잃는다.
 */

/** 인라인 조각 하나. 플래그는 겹칠 수 있다(**`굵은 코드`**). */
export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** 링크면 목적지. 겹쳐 쓰지 않는다 — 링크 안의 강조는 플래그로 함께 실린다. */
  href?: string
}

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  /** `marker` 는 그릴 글머리다 — 순서 없는 목록은 글머리표, 있는 목록은 "3." 처럼 실제 번호. */
  | { kind: 'listItem'; depth: number; marker: string; spans: Span[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'code'; language: string | null; code: string }
  | { kind: 'rule' }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/

/**
 * 들여쓰기를 단계로 바꾼다. 2칸을 쓰는 모델과 4칸을 쓰는 모델이 둘 다 있어서 나눗셈으로
 * 접으면 한쪽이 어긋난다(4칸을 2단계로 읽어 버린다). 폰 폭에서 3단계 넘게 들여쓸 자리도 없다.
 */
function indentDepth(prefix: string): number {
  const width = prefix.replace(/\t/g, '    ').length
  return width >= 6 ? 2 : width >= 2 ? 1 : 0
}

const BULLETS = ['•', '◦', '‣']

export function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let quote: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    blocks.push({ kind: 'quote', spans: parseInline(quote.join('\n')) })
    quote = []
  }
  const flush = (): void => {
    flushParagraph()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]
      const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \t]*$`)
      const body: string[] = []
      index += 1
      // 닫는 울타리가 없으면(스트리밍 중이라 아직 안 온 경우가 대부분이다) 남은 줄을 전부
      // 코드로 본다 — 그 편이 백틱 세 개가 본문에 그대로 보이는 것보다 낫다.
      while (index < lines.length && !closing.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      blocks.push({ kind: 'code', language: fence[2] || null, code: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    // 규칙선을 목록보다 먼저 본다 — `---` 은 BULLET 에도 걸린다.
    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, spans: parseInline(heading[2]) })
      continue
    }

    const quoted = QUOTE.exec(line)
    if (quoted) {
      flushParagraph()
      quote.push(quoted[1])
      continue
    }
    flushQuote()

    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      const [, prefix, token, rest] = (bullet ?? ordered) as RegExpExecArray
      const depth = indentDepth(prefix)
      blocks.push({
        kind: 'listItem',
        depth,
        marker: bullet ? BULLETS[depth] : `${token}.`,
        spans: parseInline(rest)
      })
      continue
    }

    // 목록 항목 아래에 들여쓴 줄은 그 항목의 계속이다. 새 문단으로 떼면 글머리 열에서
    // 벗어나 다른 항목처럼 읽힌다.
    const previous = blocks[blocks.length - 1]
    if (paragraph.length === 0 && previous?.kind === 'listItem' && /^[ \t]{2,}\S/.test(line)) {
      previous.spans = [...previous.spans, { text: '\n' }, ...parseInline(line.trim())]
      continue
    }

    paragraph.push(line)
  }

  flush()
  return blocks
}

const LINK = /^\[([^\]]*)\]\(\s*<?([^\s>)]*)>?(?:\s+"[^"]*")?\s*\)/
const AUTOLINK = /^https?:\/\/[^\s<>()[\]]+/
/** 링크 뒤에 붙은 문장부호는 주소가 아니다 — `(https://a.dev/x).` 의 마침표까지 열지 않는다. */
const TRAILING = /[.,;:!?)\]}'"]+$/

/** 강조 구분자가 낱말 한가운데인지. `snake_case_name` 을 기울이지 않으려는 검사다. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}

const MAX_DEPTH = 4

/**
 * 한 줄(또는 한 문단)을 인라인 조각으로 쪼갠다.
 *
 * 강조 안의 강조는 재귀로 풀고 플래그를 겹쳐 싣는다 — `**굵고 `코드`**` 는 code+bold 조각
 * 하나가 된다. 깊이를 막아 두는 이유는 별표만 잔뜩 있는 입력에서 스택이 터지지 않게 하려는 것.
 */
export function parseInline(text: string, depth = 0): Span[] {
  const spans: Span[] = []
  let plain = ''
  const pushPlain = (): void => {
    if (plain !== '') {
      spans.push({ text: plain })
      plain = ''
    }
  }
  const pushAll = (inner: Span[], flag: Partial<Span>): void => {
    pushPlain()
    for (const span of inner) spans.push({ ...span, ...flag })
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]
    const rest = text.slice(index)

    // 코드가 가장 세다 — 안에 든 별표는 강조가 아니라 글자다.
    if (char === '`') {
      const open = (/^`+/.exec(rest)?.[0] ?? '`').length
      const close = findBacktickRun(text, index + open, open)
      if (close !== -1) {
        let code = text.slice(index + open, close)
        // CommonMark: 양쪽이 다 공백이면 한 칸씩 벗긴다(`` ` `` 를 적기 위한 규칙).
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        pushPlain()
        spans.push({ text: code, code: true })
        index = close + open
        continue
      }
    }

    if (char === '[' && depth < MAX_DEPTH) {
      const link = LINK.exec(rest)
      if (link && link[2] !== '') {
        pushAll(parseInline(link[1], depth + 1), { href: link[2] })
        index += link[0].length
        continue
      }
    }

    // 맨 주소. 모델이 링크 문법 없이 그냥 적는 일이 훨씬 잦다.
    if ((char === 'h' || char === 'H') && !isWordChar(text[index - 1])) {
      const auto = AUTOLINK.exec(rest)?.[0]
      if (auto !== undefined) {
        const url = auto.replace(TRAILING, '')
        if (url !== '') {
          pushPlain()
          spans.push({ text: url, href: url })
          index += url.length
          continue
        }
      }
    }

    if ((char === '*' || char === '_' || char === '~') && depth < MAX_DEPTH) {
      const run = new RegExp(`^\\${char}+`).exec(rest)?.[0] ?? char
      // 별표 셋은 굵고 기울인 것 하나다 — 둘로 접으면 남은 별표가 본문에 그대로 남는다.
      const width = char === '~' ? 2 : Math.min(3, run.length)
      if (!(char === '~' && run.length < 2)) {
        const marker = char.repeat(width)
        const openOk =
          !/\s/.test(text[index + run.length] ?? '') &&
          // 밑줄만 낱말 경계를 요구한다. 별표는 낱말 안에서도 강조로 쓰인다.
          (char !== '_' || !isWordChar(text[index - 1]))
        if (openOk) {
          const from = index + width
          const close = findClosing(text, from, marker, char === '_')
          if (close !== -1) {
            const flag: Partial<Span> =
              char === '~'
                ? { strike: true }
                : width === 3
                  ? { bold: true, italic: true }
                  : width === 2
                    ? { bold: true }
                    : { italic: true }
            pushAll(parseInline(text.slice(from, close), depth + 1), flag)
            index = close + width
            continue
          }
        }
      }
    }

    plain += char
    index += 1
  }

  pushPlain()
  return spans
}

/** 닫는 구분자 자리. 앞이 공백이면 닫지 않는다(`a * b * c` 를 기울이지 않는다). */
function findClosing(text: string, from: number, marker: string, wordBoundary: boolean): number {
  let at = text.indexOf(marker, from)
  while (at !== -1) {
    const before = text[at - 1]
    const after = text[at + marker.length]
    if (
      at > from &&
      before !== undefined &&
      !/\s/.test(before) &&
      (!wordBoundary || !isWordChar(after))
    ) {
      return at
    }
    at = text.indexOf(marker, at + 1)
  }
  return -1
}

/** `text[from]` 부터 백틱이 정확히 `width` 개인 자리. 더 긴 덩어리는 닫는 짝이 아니다. */
function findBacktickRun(text: string, from: number, width: number): number {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] !== '`') continue
    let end = at
    while (text[end] === '`') end += 1
    if (end - at === width) return at
    at = end - 1
  }
  return -1
}
