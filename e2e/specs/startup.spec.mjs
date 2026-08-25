/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

export default async function 앱이_시드된_대화로_사용_가능한_화면에_도달한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: Date.now() - 1 },
            {
              id: 'assistant-e2e',
              type: 'assistant',
              text: 'Ready without a model turn.',
              ts: Date.now()
            }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const state = await wooi.win.evaluate(() => globalThis.api.getState())
        if (!state.workspaces.some((workspace) => workspace.id === 'ws-e2e')) {
          throw new Error('seeded workspace was not returned through main-process IPC')
        }
        await openSeededWorkspace(wooi.win)
        await wooi.win
          .locator('.workspace-header [title^="E2E workspace with a deliberately long name"]')
          .waitFor()
        await wooi.win.getByText('Ready without a model turn.').waitFor()
        await wooi.win.locator('textarea[placeholder^="Message your agent"]').waitFor()
        const screenshot = await wooi.shot('startup-usable')
        console.log(`[e2e] screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
