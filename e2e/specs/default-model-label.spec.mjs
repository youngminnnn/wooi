/* global console, Event, process, window */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const CODEX_MODELS = [{ id: 'gpt-e2e', label: 'GPT E2E', isDefault: true }]

export default async function Codex_기본_모델이_모델_선택기에_표시된다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      // 처음부터 Codex 워크스페이스로 열어 전환 확인이나 모델 턴 없이 picker를 관찰한다.
      seed: (scratch) => seedAppState(scratch, { workspace: { agentBackend: 'codex' } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win

      try {
        await openSeededWorkspace(win)

        // 설치된 CLI와 app-server 응답에 기대지 않는다. 이 격리 실행의 catalog만 결정적으로
        // 바꾼 뒤, 실제 앱 전환과 같은 native focus 경로로 renderer refresh를 다시 태운다.
        const backends = await win.evaluate(() => window.api.agent.listBackends())
        await wooi.app.evaluate(
          ({ ipcMain }, payload) => {
            globalThis.__wooiE2eBackends = payload.backends
            globalThis.__wooiE2eModels = payload.models
            ipcMain.removeHandler('agent:listBackends')
            ipcMain.handle('agent:listBackends', () => globalThis.__wooiE2eBackends)
            ipcMain.removeHandler('agent:listModels')
            ipcMain.handle('agent:listModels', (_event, backendId) =>
              backendId === 'codex' ? globalThis.__wooiE2eModels : []
            )
          },
          {
            backends: backends.map((backend) => ({
              ...backend,
              available: true,
              unavailableReason: undefined
            })),
            models: CODEX_MODELS
          }
        )
        const catalog = await win.evaluate(async () => ({
          backends: await window.api.agent.listBackends(),
          models: await window.api.agent.listModels('codex')
        }))
        if (
          catalog.backends.length !== 2 ||
          catalog.backends.some((backend) => !backend.available) ||
          JSON.stringify(catalog.models) !== JSON.stringify(CODEX_MODELS)
        ) {
          throw new Error(`deterministic Codex catalog was not installed: ${JSON.stringify(catalog)}`)
        }
        // store의 카탈로그 갱신은 renderer window focus listener가 소유한다. OS가 이미 이 창을
        // foreground로 보는 CI에서도 같은 경로를 결정적으로 태우도록 DOM focus를 보낸다.
        await win.evaluate(() => window.dispatchEvent(new Event('focus')))

        const modelChip = win.locator('button[title^="Model:"]')
        await modelChip.waitFor({ timeout: 10_000 })
        await modelChip.click()
        const picker = win.locator('div.absolute.bottom-full.max-h-96')
        await picker.getByText('Model for this workspace').waitFor({ timeout: 10_000 })

        const defaultOption = picker
          .getByRole('button')
          .filter({ hasText: 'Default' })
          .filter({ hasText: 'GPT E2E' })
        try {
          await defaultOption.waitFor({ timeout: 10_000 })
        } catch {
          throw new Error(
            `Codex Default option did not show its catalog default GPT E2E: ${JSON.stringify(await picker.innerText())}`
          )
        }

        console.log(`[e2e] screenshot=${await wooi.shot('default-model-label')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
