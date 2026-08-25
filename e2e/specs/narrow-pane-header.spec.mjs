/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

export default async function 좁은_pane에서도_워크스페이스_헤더가_남는다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.setViewportSize({ width: 980, height: 720 })
        const layout = await wooi.win.locator('.workspace-header').evaluate((header) => {
          const identity = header.querySelector('.workspace-header-identity')
          const secondary = header.querySelector('.workspace-header-action-secondary')
          if (!identity || !secondary) {
            throw new Error('workspace header regions were not rendered')
          }
          const h = header.getBoundingClientRect()
          const i = identity.getBoundingClientRect()
          return {
            headerWidth: h.width,
            identityWidth: i.width,
            inside: i.left >= h.left && i.right <= h.right,
            secondaryDisplay: globalThis.getComputedStyle(secondary).display
          }
        })
        if (layout.headerWidth > 600)
          throw new Error(`chat pane is not narrow: ${layout.headerWidth}px`)
        if (layout.identityWidth <= 0 || !layout.inside) {
          throw new Error(`workspace identity overflowed the header: ${JSON.stringify(layout)}`)
        }
        if (layout.secondaryDisplay !== 'none') {
          throw new Error(`secondary actions did not collapse: ${JSON.stringify(layout)}`)
        }
        await wooi.win
          .locator('.workspace-header [title^="E2E workspace with a deliberately long name"]')
          .waitFor()
        const screenshot = await wooi.shot('narrow-pane-header')
        console.log(`[e2e] layout=${JSON.stringify(layout)} screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
