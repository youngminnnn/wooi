/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const UNREAD_BADGE_TITLE = 'Completed response — unread'

export default async function 재시작해도_읽지_않은_워크스페이스_배지가_유지된다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { unreadWorkspaceIds: ['ws-e2e'] })
    },
    async (scratch) => {
      const first = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await first.win.locator(`[title="${UNREAD_BADGE_TITLE}"]`).waitFor()
      } finally {
        await first.close()
      }

      const restarted = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await restarted.win.locator(`[title="${UNREAD_BADGE_TITLE}"]`).waitFor()
        const state = await restarted.win.evaluate(() => globalThis.api.getState())
        if (!state.unreadWorkspaceIds?.includes('ws-e2e')) {
          throw new Error('persisted unread workspace was not restored through main-process IPC')
        }
        console.log(`[e2e] screenshot=${await restarted.shot('unread-after-restart')}`)
        await waitForInspection(restarted.win)
      } finally {
        await restarted.close()
      }
    }
  )
}
