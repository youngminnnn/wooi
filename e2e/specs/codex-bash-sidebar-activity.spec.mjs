/* global console, process */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openSeededWorkspace, seedAppState } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

async function sendAgents(app, agents) {
  const typesSource = await readFile(resolve('src/shared/types.ts'), 'utf8')
  const channel = typesSource.match(/evtChat:\s*'([^']+)'/)?.[1]
  if (!channel) throw new Error('evtChat channel not found')
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no window to deliver the chat event to')
      win.webContents.send(payload.channel, {
        workspaceId: 'ws-e2e',
        event: { type: 'agents', agents: payload.agents }
      })
    },
    { channel, agents }
  )
}

export default async function Codex_bash_activity가_sidebar에_나타났다가_완료_후_사라진다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, { workspace: { agentBackend: 'codex', status: 'running' } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await sendAgents(wooi.app, [
          {
            taskId: 'command-1',
            taskType: 'bash',
            agentType: 'bash',
            description: 'npm test',
            startedAt: Date.now()
          }
        ])

        await wooi.win.getByText('1 running').waitFor()
        await wooi.win.getByText('npm test').waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('codex-bash-sidebar-activity')}`)

        await sendAgents(wooi.app, [])
        await wooi.win.getByText('1 running').waitFor({ state: 'detached' })
      } finally {
        await wooi.close()
      }
    }
  )
}
