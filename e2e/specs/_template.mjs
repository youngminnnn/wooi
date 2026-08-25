/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

export default async function 새_스펙() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const header = await openSeededWorkspace(wooi.win)

        // 이 단언을 검증할 동작과 관찰값으로 바꾼다.
        const observed = await header.getAttribute('class')
        if (!observed?.includes('workspace-header')) {
          throw new Error(`workspace header class was not rendered: ${JSON.stringify(observed)}`)
        }

        // 스크린샷 이름을 스펙에 맞게 바꾼다.
        console.log(`[e2e] screenshot=${await wooi.shot('new-spec')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
