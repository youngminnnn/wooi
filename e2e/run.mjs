/* global console, process */

import { access, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const harness = process.env.WOOI_E2E_HARNESS
const help =
  'Set WOOI_E2E_HARNESS to the absolute wooi-run harness directory, then run npm run build && npm run e2e.'

if (!harness || !isAbsolute(harness)) {
  console.log(`[e2e] SKIP: WOOI_E2E_HARNESS is not set to an absolute path. ${help}`)
  process.exit(0)
}

try {
  await access(join(harness, 'index.mjs'))
} catch {
  console.log(`[e2e] SKIP: WOOI_E2E_HARNESS does not contain index.mjs: ${harness}. ${help}`)
  process.exit(0)
}

const specsDir = resolve('e2e/specs')
const specs = (await readdir(specsDir)).filter((name) => name.endsWith('.spec.mjs')).sort()
let failed = 0
const suiteStart = performance.now()

for (const name of specs) {
  const start = performance.now()
  try {
    const spec = await import(pathToFileURL(join(specsDir, name)).href)
    if (typeof spec.default !== 'function')
      throw new Error('default export must be an async function')
    await spec.default()
    console.log(`[e2e] PASS ${name} (${((performance.now() - start) / 1000).toFixed(1)}s)`)
  } catch (error) {
    failed++
    console.error(`[e2e] FAIL ${name} (${((performance.now() - start) / 1000).toFixed(1)}s)`)
    console.error(error)
  }
}

console.log(
  `[e2e] ${specs.length - failed} passed, ${failed} failed (${((performance.now() - suiteStart) / 1000).toFixed(1)}s)`
)
process.exitCode = failed === 0 ? 0 : 1
