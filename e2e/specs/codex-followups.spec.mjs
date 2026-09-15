/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const TRANSCRIPT = [
  { id: 'user-e2e', type: 'user', text: 'Prepare the repository.', ts: Date.now() - 1 },
  {
    id: 'assistant-e2e',
    type: 'assistant',
    text: 'Done.\n- :codex-followup[Run checks]{prompt="Run npm run typecheck"}',
    ts: Date.now()
  }
]

export default async function Codex_후속_제안은_모델_턴_없이_같은_대화로_전송한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, { transcript: TRANSCRIPT, workspace: { agentBackend: 'codex' } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win

      try {
        // 제안 버튼은 실제 chat:send 경로를 타되 모델 턴은 열지 않게 한다. 이 격리 앱의
        // handler만 바꾸고 호출 인자를 main process 전역에 남긴다.
        await wooi.app.evaluate(({ ipcMain }) => {
          globalThis.__wooiE2eChatSend = null
          ipcMain.removeHandler('chat:send')
          ipcMain.handle('chat:send', (_event, ...args) => {
            globalThis.__wooiE2eChatSend = args
          })
        })

        await openSeededWorkspace(win)

        const followups = win.locator('[aria-label="Suggested follow-ups"]')
        await followups.waitFor()
        const runChecks = followups.getByRole('button', { name: 'Run checks' })
        if ((await runChecks.count()) !== 1) {
          throw new Error(`expected exactly one Run checks follow-up, found ${await runChecks.count()}`)
        }
        if ((await win.getByText(':codex-followup', { exact: false }).count()) !== 0) {
          throw new Error('raw :codex-followup markup was rendered in the message body')
        }

        await runChecks.click()
        await win.waitForTimeout(50)
        const sendArgs = await wooi.app.evaluate(() => globalThis.__wooiE2eChatSend)
        if (sendArgs?.[0] !== 'ws-e2e' || sendArgs?.[1] !== 'Run npm run typecheck') {
          throw new Error(`follow-up was not sent through chat:send: ${JSON.stringify(sendArgs)}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('codex-followups')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
