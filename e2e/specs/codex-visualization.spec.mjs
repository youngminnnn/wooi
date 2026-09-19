/* global console, process */

import { mkdir, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const PARTITION = 'wooi-artifact-ws-e2e'
const MARKER = 'visualization rendered inside Wooi'

export default async function Codex_visualize_출력이_격리된_탭에서_열린다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        const dir = join(scratch.worktrees['feature-test'], 'visualizations')
        const path = join(dir, 'stack-frame.html')
        await mkdir(dir, { recursive: true })
        await writeFile(
          path,
          `<section id="visualization-marker" style="color:#f5f5f5;padding:24px"><h1>${MARKER}</h1></section>`
        )
        await seedAppState(scratch, {
          workspace: { agentBackend: 'codex' },
          transcript: [
            {
              id: 'assistant-visualization',
              type: 'assistant',
              text: `Stack trace:\n\uE200visualize\uE202${JSON.stringify({ path, title: 'Stack frame' })}\uE201`,
              ts: Date.now()
            }
          ]
        })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        const card = wooi.win.locator('[aria-label="Visualizations"]')
        await card.getByText('Stack frame', { exact: true }).waitFor()
        if ((await wooi.win.getByText('\uE200visualize\uE202', { exact: false }).count()) !== 0) {
          throw new Error('raw visualize markup was rendered in the assistant message')
        }
        await card.getByRole('button', { name: 'Open' }).click()

        let seen
        for (let attempt = 0; attempt < 40; attempt++) {
          seen = await wooi.app.evaluate(async ({ webContents, session }, partition) => {
            const guest = webContents
              .getAllWebContents()
              .find((wc) => wc.session === session.fromPartition(partition))
            if (!guest || guest.isDestroyed()) return null
            return {
              url: guest.getURL(),
              marker: await guest.executeJavaScript(
                `document.getElementById('visualization-marker')?.textContent`
              )
            }
          }, PARTITION)
          if (seen?.marker?.includes(MARKER)) break
          await wooi.win.waitForTimeout(250)
        }

        if (!seen?.url?.startsWith('wooi-artifact://a/visualization/')) {
          throw new Error(`visualization did not use an opaque hosted URL: ${JSON.stringify(seen)}`)
        }
        if (!seen.marker.includes(MARKER)) {
          throw new Error(`visualization fragment did not render: ${JSON.stringify(seen)}`)
        }

        // Playwright의 창 screenshot은 main-owned WebContentsView를 합성하지 않는다. 게스트를
        // 직접 캡처해 빈 DOM을 "렌더 성공"으로 오판하지 않게 한다.
        let guestPng = ''
        for (let attempt = 0; attempt < 40 && !guestPng; attempt++) {
          guestPng = await wooi.app.evaluate(async ({ webContents, session }, partition) => {
            const guest = webContents
              .getAllWebContents()
              .find((wc) => wc.session === session.fromPartition(partition))
            if (!guest) return ''
            return (await guest.capturePage()).toPNG().toString('base64')
          }, PARTITION)
          if (!guestPng) await wooi.win.waitForTimeout(100)
        }
        if (!guestPng) throw new Error('visualization guest rendered DOM but produced an empty frame')
        const shotDir = join(process.cwd(), '.wooi-e2e', 'shots', 'codex-visualization')
        await mkdir(shotDir, { recursive: true })
        const guestShot = join(shotDir, 'visualization-guest.png')
        await writeFile(guestShot, Buffer.from(guestPng, 'base64'))
        console.log(`[e2e] guest-screenshot=${guestShot}`)
        console.log(`[e2e] screenshot=${await wooi.shot('codex-visualization')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
