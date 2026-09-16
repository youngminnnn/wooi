/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

// Use the delimiter forms people paste from notebooks and documentation, rather
// than only the dollar-delimited form covered by remark-math's happy path.
const BACKTICK = '`'
const MATH_MESSAGE = String.raw`The display calculation is below:

\[
\begin{aligned}
  \operatorname{veryLongResult} &= \frac{12345678901234567890123456789012345678901234567890}{9876543210987654321098765432109876543210987654321} + \sqrt{abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz} \\
  &= \sum_{n=1}^{100} n^2
\end{aligned}
\]

The inline result is \(a^2 + b^2 = c^2\).

Keep inline code ${BACKTICK}\(not mathematics\)${BACKTICK} literal.

${BACKTICK}${BACKTICK}${BACKTICK}latex
\[
\begin{aligned}
  literal &= source
\end{aligned}
\]
${BACKTICK}${BACKTICK}${BACKTICK}`

export default async function markdown_수식은_렌더링하고_code_안에서는_보존한다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [{ id: 'assistant-math', type: 'assistant', text: MATH_MESSAGE, ts: now }]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const card = wooi.win.locator('[data-item-id="assistant-math"]')
        await card.waitFor()

        const display = card.locator('.katex-display')
        const inline = card.locator('.katex').last()
        await display.waitFor()
        await inline.waitFor()

        const rendered = await card.evaluate((element) => {
          const prose = element.cloneNode(true)
          prose.querySelectorAll('code, pre').forEach((node) => node.remove())
          return {
            prose: prose.textContent,
            inlineCode: element.querySelector('code')?.textContent,
            fencedCode: element.querySelector('pre code')?.textContent
          }
        })
        if (rendered.prose?.includes('\\[') || rendered.prose?.includes('\\]')) {
          throw new Error(`display delimiters leaked into rendered prose: ${JSON.stringify(rendered)}`)
        }
        if (rendered.prose?.includes('\\(') || rendered.prose?.includes('\\)')) {
          throw new Error(`inline delimiters leaked into rendered prose: ${JSON.stringify(rendered)}`)
        }
        if (rendered.inlineCode !== String.raw`\(not mathematics\)`) {
          throw new Error(`inline code was parsed as math or changed: ${JSON.stringify(rendered)}`)
        }
        if (
          rendered.fencedCode !== String.raw`\[
\begin{aligned}
  literal &= source
\end{aligned}
\]
`
        ) {
          throw new Error(`fenced code was parsed as math or changed: ${JSON.stringify(rendered)}`)
        }

        const layout = await display.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const container = element.parentElement?.getBoundingClientRect()
          const style = globalThis.getComputedStyle(element)
          return {
            width: rect.width,
            containerWidth: container?.width,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            overflowX: style.overflowX
          }
        })
        if (!layout.containerWidth || layout.width > layout.containerWidth + 1) {
          throw new Error(`display math escaped its message container: ${JSON.stringify(layout)}`)
        }
        if (layout.scrollWidth <= layout.clientWidth || layout.overflowX !== 'auto') {
          throw new Error(`long display math cannot scroll within its container: ${JSON.stringify(layout)}`)
        }

        console.log(`[e2e] layout=${JSON.stringify(layout)} screenshot=${await wooi.shot('markdown-math')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
