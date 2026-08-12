/**
 * 요소 픽커가 모은 것을 컴포저에 넣을 텍스트로 만든다.
 *
 * 순수 함수로 떼어 둔 이유는 이 형식이 **에이전트가 읽는 프롬프트**이기 때문이다. 사람 눈에
 * 예쁘게 보이는 것보다, 모델이 "무엇을 고쳐야 하는지" 를 헤매지 않는 순서가 중요하다:
 * 소스 위치 → 선택자 → HTML → 적용된 CSS. 앞의 둘이 "어디" 이고 뒤의 둘이 "무엇" 이다.
 */

/** 픽커가 모아 오는 것(main 이 만들고 renderer 가 실어 나른다). */
export interface PickedElement {
  /** 페이지에서 이 요소를 다시 찾을 수 있는 CSS 선택자. */
  selector: string
  /** 요소의 outerHTML(길면 잘림). */
  html: string
  htmlTruncated: boolean
  /** 이 요소에 실제로 적용된 저자 규칙 요약(길면 잘림). */
  css: string
  cssTruncated: boolean
  /** React dev 빌드에서만 — 이 요소를 만든 소스 위치(`src/Foo.tsx:42`). 없으면 null. */
  source: string | null
  /** 요소만 잘라낸 PNG(base64). 못 자르면 없음. */
  cropBase64?: string
}

/** 잘린 블록에 붙이는 꼬리표. 모델이 "이게 전부" 로 오해하지 않게 명시한다. */
const TRUNCATED = '\n/* … truncated */'

/**
 * 컴포저 초안에 붙일 블록을 만든다.
 *
 * 코드 펜스로 감싸는 이유는 HTML·CSS 가 마크다운으로 해석돼 대화창에서 무너지지 않게 하기
 * 위한 것만은 아니다 — 펜스 언어 태그(`html`/`css`)가 모델에게 이 덩어리의 성격을 알려 준다.
 */
export function formatPickedElement(picked: PickedElement, pageUrl: string): string {
  const lines: string[] = ['Picked this element in the preview:', '']

  lines.push(`- page: ${pageUrl}`)
  lines.push(`- selector: \`${picked.selector}\``)
  // 소스 위치가 있으면 선택자보다 강한 단서다 — 있을 때만, 그리고 눈에 띄게 적는다.
  if (picked.source) lines.push(`- source: \`${picked.source}\``)

  lines.push('', '```html', picked.html + (picked.htmlTruncated ? TRUNCATED : ''), '```')
  lines.push('', 'Author CSS that applies to it:', '```css')
  lines.push(picked.css + (picked.cssTruncated ? TRUNCATED : ''))
  lines.push('```')

  return lines.join('\n')
}
