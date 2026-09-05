import { describe, expect, it } from 'vitest'
import { ARTIFACT_ALLOWED_IMPORTS } from '@shared/types'
import {
  ArtifactBuildError,
  compileCss,
  compileReact,
  extractCandidates,
  injectStylesheet,
  rewriteImports
} from './artifactBuild'

describe('rewriteImports', () => {
  it('points every allowed specifier at the vendor bundle', () => {
    const out = rewriteImports(
      [
        `import { useState } from 'react'`,
        `import { createRoot } from "react-dom/client"`,
        `import { Check } from 'lucide-react'`,
        `import { LineChart } from 'recharts'`,
        `export { x } from 'react'`
      ].join('\n')
    )
    expect(out).toContain(`from '/v/react.js'`)
    expect(out).toContain(`from "/v/react-dom-client.js"`)
    expect(out).toContain(`from '/v/lucide-react.js'`)
    expect(out).toContain(`from '/v/recharts.js'`)
    // bare 지정자가 하나도 남으면 게스트에서 404 가 된다.
    expect(out).not.toMatch(/from ['"](?!\/v\/)/)
  })

  // sucrase 의 automatic 런타임이 심는 지정자. 모델은 쓴 적이 없지만 반드시 풀려야 한다.
  it('resolves the jsx runtime the compiler injects', () => {
    expect(rewriteImports(`import { jsx } from "react/jsx-runtime"`)).toContain(
      '/v/react-jsx-runtime.js'
    )
  })

  it('refuses an unknown package and says what is available instead', () => {
    expect(() => rewriteImports(`import * as d3 from 'd3'`)).toThrow(ArtifactBuildError)
    try {
      rewriteImports(`import * as d3 from 'd3'`)
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('d3')
      for (const allowed of ARTIFACT_ALLOWED_IMPORTS) expect(message).toContain(allowed)
    }
  })

  // 모델에게 보여 주는 목록(@shared/types)과 실제 해석표(이 모듈의 VENDOR)는 서로 다른 파일에
  // 산다 — shim 번들 오염을 피하려고 갈라 놨다. 그래서 둘이 어긋나지 않는지를 행동으로 잠근다.
  it('resolves every import the tool description promises', () => {
    for (const spec of ARTIFACT_ALLOWED_IMPORTS) {
      const out = rewriteImports(`import x from '${spec}'`)
      expect(out, spec).toMatch(/from '\/v\/[a-z-]+\.js'/)
    }
  })

  it('leaves already-resolved specifiers alone', () => {
    const src = `import App from './module.js'\nimport x from '/v/react.js'`
    expect(rewriteImports(src)).toBe(src)
  })

  // 코드 전체에서 `from "…"` 를 찾으면 문자열 안의 같은 모양까지 잡아 엉뚱하게 거절한다.
  it('does not mistake a string literal for an import statement', () => {
    const src = `const note = 'copied from "d3" docs'\nconst q = "imported from 'lodash'"`
    expect(rewriteImports(src)).toBe(src)
  })
})

describe('compileReact', () => {
  const APP = `import { useState } from 'react'
export default function App() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>{n}</button>
}`

  it('turns JSX into runnable ESM with vendor URLs', () => {
    const out = compileReact(APP)
    expect(out).not.toContain('<button')
    expect(out).toContain('/v/react.js')
    expect(out).toContain('/v/react-jsx-runtime.js')
    expect(out).toContain('export default')
  })

  it('accepts TypeScript annotations', () => {
    const out = compileReact(`export default function App(): JSX.Element { return <p>hi</p> }`)
    expect(out).toContain('export default')
  })

  // 이게 없으면 문서의 부트스트랩이 undefined 를 렌더하고 사용자는 흰 화면을 본다.
  it('refuses a module with no default export, and says what to write', () => {
    expect(() => compileReact(`export function App() { return <p>hi</p> }`)).toThrow(
      /export default/
    )
  })

  it('reports a syntax error instead of shipping a broken module', () => {
    expect(() => compileReact(`export default function App() { return <p>unclosed }`)).toThrow(
      ArtifactBuildError
    )
  })

  it('refuses a disallowed import that the component actually uses', () => {
    expect(() =>
      compileReact(`import d3 from 'd3'\nexport default () => <p>{d3.version}</p>`)
    ).toThrow(/Cannot import "d3"/)
  })

  // sucrase 의 TypeScript 변환이 쓰이지 않는 import 를 지우므로(import elision) 거절할 대상
  // 자체가 사라진다. 결과가 옳다 — 안 쓰는 import 는 게스트에서 404 를 낼 일이 없다.
  it('silently drops a disallowed import that is never used', () => {
    const out = compileReact(`import d3 from 'd3'\nexport default () => <p>hi</p>`)
    expect(out).not.toContain('d3')
  })
})

describe('compileCss', () => {
  it('emits the utilities the artifact actually used, arbitrary values included', async () => {
    const css = await compileCss(extractCandidates('<div class="flex gap-4 p-[13px]">'), {
      preflight: false
    })
    expect(css).toContain('.flex')
    expect(css).toContain('.gap-4')
    expect(css).toContain('p-\\[13px\\]')
  })

  it('keeps preflight out of html artifacts and puts it into react ones', async () => {
    const candidates = extractCandidates('<div class="flex">')
    const bare = await compileCss(candidates, { preflight: false })
    const reset = await compileCss(candidates, { preflight: true })
    // preflight 의 표식. html 아티팩트에 이게 끼면 모델이 쓴 <style> 위로 리셋이 얹힌다.
    expect(bare).not.toContain('box-sizing: border-box')
    expect(reset).toContain('box-sizing: border-box')
  })

  it('runs without the native oxide scanner', async () => {
    // 후보를 직접 넘기므로 @source 파일시스템 스캔 경로를 타지 않는다 — 네이티브가 없어도 된다.
    await expect(compileCss(['flex'], { preflight: false })).resolves.toContain('.flex')
  })
})

describe('injectStylesheet', () => {
  it('puts the link inside an existing head', () => {
    const out = injectStylesheet('<html><head><title>x</title></head><body>y</body></html>')
    expect(out).toContain('<title>x</title><link rel="stylesheet" href="./style.css"></head>')
  })

  it('handles a head with attributes and no close tag', () => {
    const out = injectStylesheet('<html><head lang="en"><body>y')
    expect(out).toContain('<head lang="en"><link rel="stylesheet"')
  })

  it('prepends when the document is a bare fragment', () => {
    expect(injectStylesheet('<div>hi</div>')).toBe(
      '<link rel="stylesheet" href="./style.css"><div>hi</div>'
    )
  })

  it('does not disturb the rest of the document', () => {
    const html = '<html><head></head><body><p>keep me</p></body></html>'
    expect(injectStylesheet(html)).toContain('<p>keep me</p>')
  })
})

describe('extractCandidates', () => {
  it('finds utility-shaped tokens including variants and arbitrary values', () => {
    const found = extractCandidates('<div class="flex hover:bg-blue-600 p-[13px]">')
    expect(found).toContain('flex')
    expect(found).toContain('hover:bg-blue-600')
    expect(found).toContain('p-[13px]')
  })
})
