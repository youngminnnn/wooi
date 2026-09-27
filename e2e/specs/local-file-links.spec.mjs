/* global console, process */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openSeededWorkspace, seedAppState } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

export default async function local_file_links_reach_the_OS_opener() {
  await withScratchRepo(
    {
      worktrees: ['file-links'],
      seed: async (scratch) => {
        const file = join(scratch.worktrees['file-links'], 'My Report.md')
        await writeFile(file, '# Local report\n')
        await seedAppState(scratch, {
          transcript: [
            {
              id: 'assistant-links',
              type: 'assistant',
              ts: Date.now(),
              text: [
                `[Absolute](<${file}:12:3>)`,
                `[File URL](${pathToFileURL(file).href}#L12)`,
                '[Website](https://example.com/report#L12)',
                `[Missing](<${join(scratch.worktrees['file-links'], 'missing.md')}>)`
              ].join('\n\n')
            }
          ]
        })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        // Keep the real renderer -> preload -> IPC route. Stub only the OS boundary
        // so the test never launches a browser or another desktop application.
        await wooi.app.evaluate(({ shell }) => {
          globalThis.__fileLinkCalls = []
          shell.openPath = async (path) => {
            globalThis.__fileLinkCalls.push({ kind: 'file', target: path })
            return path.endsWith('/missing.md') ? 'File not found' : ''
          }
          shell.openExternal = async (url) => {
            globalThis.__fileLinkCalls.push({ kind: 'web', target: url })
          }
        })
        await openSeededWorkspace(wooi.win)
        const card = wooi.win.locator('[data-item-id="assistant-links"]')
        await card.waitFor()
        const originalUrl = wooi.win.url()
        const file = join(scratch.worktrees['file-links'], 'My Report.md')
        const expected = [
          ['Absolute', { kind: 'file', target: file }],
          ['File URL', { kind: 'file', target: file }],
          ['Website', { kind: 'web', target: 'https://example.com/report#L12' }],
          ['Missing', { kind: 'file', target: join(scratch.worktrees['file-links'], 'missing.md') }]
        ]
        for (const [index, [label, call]] of expected.entries()) {
          await card.getByRole('link', { name: label, exact: true }).click()
          let calls
          for (let attempt = 0; attempt < 100; attempt++) {
            calls = await wooi.app.evaluate(() => globalThis.__fileLinkCalls)
            if (calls.length > index) break
            await setTimeout(50)
          }
          assert.deepEqual(
            calls,
            expected.slice(0, index + 1).map(([, entry]) => entry),
            label
          )
          assert.deepEqual(calls[index], call)
          assert.equal(wooi.win.url(), originalUrl, 'click must not navigate the app')
        }
        await wooi.win.getByText(/Could not open link:.*File not found/).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('local-file-links')}`)
      } finally {
        await wooi.close()
      }
    }
  )
}
