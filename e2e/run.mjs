/* global console, process */

import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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
const outputDir = resolve('.wooi-e2e')
const reportPath = join(outputDir, 'report.json')
const allSpecs = (await readdir(specsDir)).filter((name) => name.endsWith('.spec.mjs')).sort()
const args = process.argv.slice(2)
const onlyPatterns = []
let hold = false

function addOnlyPatterns(value) {
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
  if (patterns.length === 0) {
    console.error('[e2e] --only requires a spec name or pattern')
    process.exit(1)
  }
  onlyPatterns.push(...patterns)
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--hold') {
    hold = true
  } else if (arg === '--only') {
    const value = args[++index]
    if (!value || value.startsWith('--')) {
      console.error('[e2e] --only requires a spec name or pattern')
      process.exit(1)
    }
    addOnlyPatterns(value)
  } else if (arg.startsWith('--only=')) {
    addOnlyPatterns(arg.slice('--only='.length))
  } else {
    console.error(`[e2e] unknown option: ${arg}`)
    process.exit(1)
  }
}

const matches = (name, pattern) => {
  const normalizedName = name.toLowerCase()
  const stem = name.replace(/\.spec\.mjs$/i, '').toLowerCase()
  const normalizedPattern = pattern.toLowerCase()
  return normalizedName === normalizedPattern || stem.includes(normalizedPattern)
}
const unmatched = onlyPatterns.filter((pattern) => !allSpecs.some((name) => matches(name, pattern)))
const specs =
  onlyPatterns.length === 0
    ? allSpecs
    : allSpecs.filter((name) => onlyPatterns.some((pattern) => matches(name, pattern)))
let failed = 0
const suiteStart = performance.now()
const startedAt = new Date().toISOString()
const results = []

await mkdir(outputDir, { recursive: true })

async function writeReport() {
  const durationMs = Math.round(performance.now() - suiteStart)
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        startedAt,
        durationMs,
        passed: results.filter((spec) => spec.status === 'passed').length,
        failed: results.filter((spec) => spec.status === 'failed').length,
        total: results.length,
        specs: results
      },
      null,
      2
    )}\n`
  )
}

if (unmatched.length > 0) {
  console.error(`[e2e] --only patterns matched no specs: ${unmatched.join(', ')}`)
  await writeReport()
  process.exit(1)
}

let harnessModule
try {
  harnessModule = await import('./harness.mjs')
} catch (error) {
  console.error(
    `[e2e] FAIL: Could not load the wooi-run harness from ${harness}. Its dependencies may not be installed; run npm install in the WOOI_E2E_HARNESS directory.`
  )
  console.error(error)
  await writeReport()
  process.exit(1)
}
process.env.WOOI_E2E_HOLD = hold ? '1' : '0'

for (const name of specs) {
  const start = performance.now()
  const specName = name.replace(/\.spec\.mjs$/i, '')
  const shotsDir = join(outputDir, 'shots', specName)
  process.env.WOOI_E2E_SPEC_NAME = specName
  process.env.WOOI_E2E_SHOTS_DIR = shotsDir
  harnessModule.resetRecordedShots()
  await rm(shotsDir, { recursive: true, force: true })
  try {
    const spec = await import(pathToFileURL(join(specsDir, name)).href)
    if (typeof spec.default !== 'function')
      throw new Error('default export must be an async function')
    await spec.default()
    const durationMs = Math.round(performance.now() - start)
    results.push({
      name: specName,
      status: 'passed',
      durationMs,
      shots: harnessModule.getRecordedShots()
    })
    console.log(`[e2e] PASS ${name} (${(durationMs / 1000).toFixed(1)}s)`)
  } catch (error) {
    failed++
    const durationMs = Math.round(performance.now() - start)
    const message = String(error?.message ?? error)
      .split(/\r?\n/, 1)[0]
      .slice(0, 500)
    const frame =
      String(error?.stack ?? '')
        .split(/\r?\n/)
        .find((line) => /(?:e2e\/|wooi-run\/harness\/)/.test(line))
        ?.trim() ?? ''
    results.push({
      name: specName,
      status: 'failed',
      durationMs,
      shots: harnessModule.getRecordedShots(),
      error: { message, frame }
    })
    console.error(`[e2e] FAIL ${name} (${(durationMs / 1000).toFixed(1)}s)`)
    console.error(error)
  }
  await writeReport()
}

console.log(
  `[e2e] ${specs.length - failed} passed, ${failed} failed (${((performance.now() - suiteStart) / 1000).toFixed(1)}s)`
)
await writeReport()
process.exitCode = failed === 0 ? 0 : 1
