/* global console, process */

import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

const harness = process.env.WOOI_E2E_HARNESS
if (!harness || !isAbsolute(harness)) {
  throw new Error('WOOI_E2E_HARNESS must be an absolute wooi-run harness directory')
}

const realHarness = await import(pathToFileURL(join(harness, 'index.mjs')).href)
const recordedShots = []

export const withScratchRepo = realHarness.withScratchRepo

export function resetRecordedShots() {
  recordedShots.length = 0
}

export function getRecordedShots() {
  return [...recordedShots]
}

export async function launchWooi(options) {
  // scratch 컨텍스트를 통째로 펼치면 임시 shotsPath도 따라온다. 그 기본값만 실행기가 정한
  // 영구 경로로 바꾸고, 호출자가 별도 경로를 넘긴 경우에는 그대로 존중한다.
  const scratchShotsPath = options.root ? join(resolve(options.root), 'shots') : null
  const hasCustomShotsPath = options.shotsPath && resolve(options.shotsPath) !== scratchShotsPath
  const shotsPath = hasCustomShotsPath
    ? options.shotsPath
    : (process.env.WOOI_E2E_SHOTS_DIR ?? options.shotsPath)
  const wooi = await realHarness.launchWooi({
    ...options,
    ...(shotsPath ? { shotsPath } : {})
  })
  const realShot = wooi.shot
  const realClose = wooi.close

  return {
    ...wooi,
    shot: async (...args) => {
      const path = await realShot(...args)
      recordedShots.push(path)
      return path
    },
    close: async () => {
      if (process.env.WOOI_E2E_HOLD === '1' && process.stdin.isTTY) {
        const spec = process.env.WOOI_E2E_SPEC_NAME ?? 'spec'
        console.log(`[e2e] holding ${spec} open — press Enter to close`)
        const input = createInterface({ input: process.stdin, output: process.stdout })
        try {
          await input.question('')
        } finally {
          input.close()
        }
      }
      await realClose()
    }
  }
}
