import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { transform } from 'sucrase'
import { compile } from 'tailwindcss'
import { ARTIFACT_ALLOWED_IMPORTS } from '@shared/types'

/**
 * 아티팩트를 **main 에서** 컴파일한다 — 게스트 안이 아니라.
 *
 * 이 파일의 존재 이유는 보안이 아니라 **에러의 청중**이다. JSX 트랜스파일·import 해석·
 * Tailwind 생성을 게스트에서 하면, 실패는 샌드박스 안 콘솔에 갇혀 아무도 안 읽는다. 여기서
 * 하면 실패가 그 턴의 도구 에러가 되어 모델이 곧바로 고친다([[agent/tools/artifact]]).
 *
 * 덤으로 게스트에서 사라지는 것들: 트랜스파일러 번들, `blob:` URL, import map,
 * 그리고 CSP 의 `'unsafe-eval'`.
 */

/**
 * 아티팩트가 import 할 수 있는 것 전부. **이 표가 곧 허용 목록이다** — 여기 없는 지정자는
 * 조용히 404 가 되는 대신 도구 에러가 된다.
 *
 * `react/jsx-runtime` 은 모델이 쓰지 않는데도 반드시 있어야 한다. sucrase 의 automatic
 * 런타임이 JSX 를 그 지정자로 컴파일하기 때문이다 — 빼면 **모든** React 아티팩트가 모델이
 * 본 적 없는 이름을 못 찾아 죽는다.
 */
const VENDOR: Record<string, string> = {
  react: '/v/react.js',
  'react/jsx-runtime': '/v/react-jsx-runtime.js',
  'react-dom/client': '/v/react-dom-client.js',
  'lucide-react': '/v/lucide-react.js',
  recharts: '/v/recharts.js'
}

/**
 * 모델에게 보여 줄 목록은 [[shared/types]] 에 있다 — 이 모듈이 sucrase·tailwindcss 를 끌어오는
 * 탓에, 그 목록을 쓰려고 카탈로그가 여기를 import 하면 Codex 툴 shim 번들이 오염된다.
 * 이 표(`VENDOR`)가 그 목록을 전부 덮는지는 `artifactBuild.test.ts` 가 확인한다.
 */

/**
 * import/export 문의 지정자만 골라낸다.
 *
 * 코드 전체에서 `from "…"` 를 찾으면 문자열 리터럴 안의 같은 모양까지 잡는다. 그래서 문
 * **시작 위치**(줄머리 또는 `;`)에서 시작하는 것만 본다.
 */
const SPECIFIER_RE =
  /(^|[\n;])(\s*(?:import|export)\b[^;'"]*?\bfrom\s*)(['"])([^'"]+)\3|(^|[\n;])(\s*import\s*)(['"])([^'"]+)\7/g

/** 이미 URL·경로인 지정자(우리가 심은 것)는 다시 손대지 않는다. */
function isResolved(spec: string): boolean {
  return spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')
}

export class ArtifactBuildError extends Error {}

/**
 * bare 지정자를 벤더 URL 로 바꾸고, 목록 밖은 거절한다.
 *
 * 거절 문구가 이 함수의 산출물 절반이다 — 모델은 `d3` 를 습관적으로 집으므로, "없다" 가
 * 아니라 "대신 이것들을 쓸 수 있다" 고 말해야 다음 시도가 맞는다.
 *
 * 여기 도달하는 것은 sucrase 를 **거친 뒤**의 코드다. sucrase 의 TypeScript 변환이 쓰이지
 * 않는 import 를 지우므로(import elision), 모델이 `d3` 를 적어 놓고 안 쓰면 그 줄은 여기
 * 오기 전에 사라진다. 그래도 결과는 옳다 — 안 쓰는 import 는 게스트에서 404 를 낼 일이 없다.
 */
export function rewriteImports(code: string): string {
  return code.replace(SPECIFIER_RE, (match, ...groups) => {
    // 두 갈래(from 있는 것 / bare side-effect import) 중 매치된 쪽을 고른다.
    const [lead1, head1, q1, spec1, lead2, head2, q2, spec2] = groups as string[]
    const lead = lead1 ?? lead2
    const head = head1 ?? head2
    const quote = q1 ?? q2
    const spec = spec1 ?? spec2
    if (spec === undefined) return match
    if (isResolved(spec)) return match

    const url = VENDOR[spec]
    if (!url)
      throw new ArtifactBuildError(
        `Cannot import "${spec}" — artifacts have no package manager and no network. ` +
          `Available imports: ${ARTIFACT_ALLOWED_IMPORTS.join(', ')}. ` +
          'Write anything else inline in the artifact itself.'
      )
    return `${lead}${head}${quote}${url}${quote}`
  })
}

/** JSX/TSX 소스를 게스트가 그대로 실행할 수 있는 ESM 으로 만든다. */
export function compileReact(source: string): string {
  let code: string
  try {
    code = transform(source, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: 'artifact.tsx'
    }).code
  } catch (err) {
    // sucrase 는 줄·열이 담긴 문구를 준다. 그대로 넘겨야 모델이 어디를 고칠지 안다.
    throw new ArtifactBuildError(
      `The artifact does not parse as JSX: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!/\bexport\s+default\b/.test(code))
    throw new ArtifactBuildError(
      'A react artifact must `export default` the component to render, for example ' +
        '`export default function App() { … }`.'
    )
  return rewriteImports(code)
}

const require_ = createRequire(import.meta.url)

/**
 * Tailwind 엔트리 두 벌.
 *
 * `tailwindcss/index.css` 를 그대로 쓰지 않고 조립하는 이유는 **preflight** 때문이다.
 * preflight 는 브라우저 기본 스타일을 통째로 리셋한다 — `react` 아티팩트에는 그게 맞지만
 * (모델이 문서를 안 쓰고 컴포넌트만 쓴다), `html` 아티팩트에는 재앙이다. 거기서는 모델이
 * `<style>` 까지 직접 쓴 완성된 문서를 넘기는데, 우리가 리셋을 얹으면 모델이 본 적 없는
 * 레이아웃이 나온다.
 *
 * preflight 를 뺀 쪽은 theme(= CSS 커스텀 프로퍼티)와 utilities 뿐이라, 모델이 Tailwind 를
 * 안 썼어도 링크해 두는 것이 무해하다. 그래서 "썼는지 판별해서 조건부로 붙이기" 같은
 * 휴리스틱이 필요 없다.
 */
const ENTRY_WITH_PREFLIGHT = `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);`

const ENTRY_NO_PREFLIGHT = `@layer theme, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);`

/**
 * Tailwind 를 main 에서 굽는다.
 *
 * `@tailwindcss/browser` 를 게스트에 싣는 대신 여기서 부르는 이유는 이 파일 첫 주석과 같다.
 * 후보 클래스를 **직접 넘기므로** `@source` 파일시스템 스캔이 필요 없고, 따라서 네이티브
 * `@tailwindcss/oxide` 도 타지 않는다 — `tailwindcss` 코어는 의존성이 0개다.
 *
 * 사전 컴파일 + 세이프리스트가 아니라 **매번 굽는** 것이 요점이다. 아티팩트의 유틸리티
 * 클래스는 무한집합이라 세이프리스트로는 덮을 수 없고, 못 덮은 클래스는 에러 없이 레이아웃만
 * 조용히 깨진다.
 */
export async function compileCss(
  candidates: string[],
  opts: { preflight: boolean }
): Promise<string> {
  const root = dirname(require_.resolve('tailwindcss/package.json'))
  const compiler = await compile(opts.preflight ? ENTRY_WITH_PREFLIGHT : ENTRY_NO_PREFLIGHT, {
    base: root,
    loadStylesheet: async (id: string, base: string) => {
      const name = id.replace(/^tailwindcss\/?/, '') || 'index.css'
      const file = name.endsWith('.css') ? name : `${name}.css`
      return { base, path: file, content: readFileSync(join(root, file), 'utf-8') }
    }
  })
  return compiler.build(candidates)
}

/**
 * 소스에서 Tailwind 후보로 볼 만한 토큰을 뽑는다.
 *
 * 넉넉하게 잡는다 — 후보가 아닌 것이 섞여도 Tailwind 가 무시할 뿐이고, 빠지면 그 클래스만
 * 조용히 안 나온다. 비용이 비대칭이라 과다 포함 쪽으로 기운다.
 */
export function extractCandidates(source: string): string[] {
  return [...new Set(source.match(/[A-Za-z0-9][A-Za-z0-9:_/\\[\].,%#()-]*/g) ?? [])]
}

/**
 * 모델이 쓴 문서에 우리 스타일시트 링크를 끼워 넣는다.
 *
 * 모델의 HTML 을 고치는 일이라 최소로 한다 — `<head>` 가 있으면 그 안, 없으면 문서 맨 앞.
 * 이미 `</head>` 가 있는 정상 문서가 대부분이고, 조각만 넘어온 경우에도 브라우저가
 * 암묵적 head 를 만들어 주므로 맨 앞에 두면 동작한다.
 */
export function injectStylesheet(html: string): string {
  const link = '<link rel="stylesheet" href="./style.css">'
  const close = html.search(/<\/head\s*>/i)
  if (close >= 0) return html.slice(0, close) + link + html.slice(close)
  const open = html.match(/<head\b[^>]*>/i)
  if (open?.index !== undefined) {
    const at = open.index + open[0].length
    return html.slice(0, at) + link + html.slice(at)
  }
  return link + html
}

/** 문서에 넣을 값을 HTML 로 안전하게 만든다(제목처럼 우리가 조립하는 자리에만 쓴다). */
function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/**
 * React 아티팩트의 문서.
 *
 * 부트스트랩을 인라인 모듈 스크립트로 둔 이유: 사용자 코드(`module.js`)의 `export default`
 * 를 건드리지 않고 그대로 두려면, 마운트하는 쪽이 그것을 **import 하는** 별개의 모듈이어야
 * 한다. 코드를 재작성해 마운트를 덧붙이면 모델이 쓴 export 모양마다 깨진다.
 *
 * 렌더 에러를 화면에 적는 것도 일부러다. 게스트 콘솔은 아무도 안 보므로, 안 적으면 사용자는
 * 흰 화면만 본다.
 */
export function reactDocument(title: string, hasCss: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
${hasCss ? '<link rel="stylesheet" href="./style.css">' : ''}
<style>html,body,#root{margin:0;min-height:100%}</style>
</head><body><div id="root"></div>
<script type="module">
import { createElement } from '/v/react.js'
import { createRoot } from '/v/react-dom-client.js'
const root = document.getElementById('root')
try {
  const mod = await import('./module.js')
  createRoot(root).render(createElement(mod.default))
} catch (err) {
  root.innerHTML = ''
  const pre = document.createElement('pre')
  pre.style.cssText = 'white-space:pre-wrap;padding:16px;font:12px ui-monospace,monospace;color:#b91c1c'
  pre.textContent = 'This artifact failed to render:\\n\\n' + (err && err.stack || err)
  root.appendChild(pre)
}
</script></body></html>
`
}

/** Mermaid 아티팩트의 문서. 다이어그램 원문은 렌더 대상이지 코드가 아니므로 textContent 로 넣는다. */
export function mermaidDocument(title: string, diagram: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#fff}
#d{display:flex;align-items:center;justify-content:center;height:100%}
#d svg{max-width:100%;max-height:100%}</style>
</head><body><div id="d"></div>
<script type="module">
import mermaid from '/v/mermaid.js'
const src = ${JSON.stringify(diagram)}
const d = document.getElementById('d')
try {
  mermaid.initialize({ startOnLoad: false })
  const { svg } = await mermaid.render('artifact-diagram', src)
  d.innerHTML = svg
} catch (err) {
  const pre = document.createElement('pre')
  pre.style.cssText = 'white-space:pre-wrap;padding:16px;font:12px ui-monospace,monospace;color:#b91c1c'
  pre.textContent = 'This diagram failed to render:\\n\\n' + (err && err.message || err)
  d.appendChild(pre)
}
</script></body></html>
`
}

/** SVG 아티팩트의 문서. */
export function svgDocument(svg: string, hasCss = false): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>artifact</title>
${hasCss ? '<link rel="stylesheet" href="./style.css">' : ''}
<style>html,body{margin:0;height:100%;background:#fff}
body{display:flex;align-items:center;justify-content:center}
svg{max-width:100%;max-height:100%;height:auto;width:auto}</style>
</head><body>
${svg}
</body></html>
`
}
