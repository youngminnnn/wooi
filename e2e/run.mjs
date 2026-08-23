/* global console, process */

import { access, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const harness = process.env.WOOI_E2E_HARNESS
const help =
  'Set WOOI_E2E_HARNESS to the oh-my-wooi source checkout at plugins/wooi-run/harness, then run npm run build && npm run e2e.'

// 설정하지 않은 것은 "돌리지 않겠다"는 뜻이므로 건너뛰지만, 설정했는데 경로가 틀리면
// "돌리겠다고 했는데 못 돌렸다"는 뜻이므로 실패로 끊는다. 조용한 exit 0은 CI에서 통과로 읽힌다.
if (!harness || !isAbsolute(harness)) {
  console.log(`[e2e] SKIP: WOOI_E2E_HARNESS is not set to an absolute path. ${help}`)
  process.exit(0)
}

try {
  await access(join(harness, 'index.mjs'))
} catch {
  console.error(
    `[e2e] ERROR: WOOI_E2E_HARNESS exists but has no index.mjs: ${harness}. It must point at the oh-my-wooi source checkout at plugins/wooi-run/harness; the installed plugin snapshot does not contain the harness.`
  )
  process.exit(1)
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
