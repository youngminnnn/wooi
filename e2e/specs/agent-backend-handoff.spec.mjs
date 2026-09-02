/* global console, process, window */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const TRANSCRIPT = [
  { id: 'user-e2e', type: 'user', text: 'Keep the handoff compact.', ts: Date.now() - 1 },
  { id: 'assistant-e2e', type: 'assistant', text: 'The implementation is ready.', ts: Date.now() }
]

export default async function 대화가_있는_워크스페이스는_확인_후_압축_체크포인트로_에이전트를_바꾼다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript: TRANSCRIPT })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win

      try {
        await openSeededWorkspace(win)

        // 설치된 CLI 조합에 기대지 않는다. 등록된 백엔드의 실제 메타데이터를 그대로 쓰되 이
        // 격리 실행에서만 둘 다 선택 가능하게 만든다. 모델 턴은 열지 않는다.
        const backends = await win.evaluate(() => window.api.agent.listBackends())
        await wooi.app.evaluate(
          ({ ipcMain }, payload) => {
            globalThis.__wooiE2eBackends = payload
            globalThis.__wooiE2eAgentSwitch = null
            ipcMain.removeHandler('agent:listBackends')
            ipcMain.handle('agent:listBackends', () => globalThis.__wooiE2eBackends)
            ipcMain.removeHandler('workspace:setAgentBackend')
            ipcMain.handle('workspace:setAgentBackend', (_event, ...args) => {
              globalThis.__wooiE2eAgentSwitch = args
              return {}
            })
          },
          backends.map((backend) => ({ ...backend, available: true, unavailableReason: undefined }))
        )
        const available = await win.evaluate(() => window.api.agent.listBackends())
        if (available.filter((backend) => backend.available).length !== 2) {
          throw new Error(
            `deterministic backend catalog was not installed: ${JSON.stringify(available)}`
          )
        }
        // 실제 앱 전환과 같은 native focus를 만들어 refreshAgents를 다시 태운다.
        await wooi.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.blur()
          window.focus()
        })

        const agentButton = win.locator('button[title^="Agent:"]')
        await agentButton.waitFor({ timeout: 10_000 })
        await agentButton.click()

        const picker = win.locator('div.absolute.bottom-full.max-h-96')
        await picker.getByText('Main agent for this workspace').waitFor()
        await picker.getByRole('button', { name: 'Codex' }).click()

        const heading = win.getByRole('heading', { name: 'Switch this workspace to Codex?' })
        await heading.waitFor()
        await win.getByText('compact workspace checkpoint', { exact: false }).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('agent-handoff-confirm')}`)
        await win.getByRole('button', { name: 'Switch and hand over' }).click()

        await heading.waitFor({ state: 'detached' })
        const switchCall = await wooi.app.evaluate(() => globalThis.__wooiE2eAgentSwitch)
        if (
          switchCall?.[0] !== 'ws-e2e' ||
          switchCall?.[1] !== 'codex' ||
          switchCall?.[2]?.handoff !== true
        ) {
          throw new Error(`approved handoff was not sent to main: ${JSON.stringify(switchCall)}`)
        }

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
