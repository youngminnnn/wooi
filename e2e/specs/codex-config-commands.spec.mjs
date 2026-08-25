/* global console, process */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'

function expectIncludes(actual, expected, subject) {
  if (!actual.includes(expected)) {
    throw new Error(
      `${subject}: expected text containing ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

async function submit(win, command) {
  const textarea = win.locator('textarea[placeholder^="Message your agent"]')
  await textarea.fill(`${command} `)
  await textarea.press('Enter')
}

async function openCard(win, command) {
  await submit(win, command)
  const card = win.locator('div.absolute.bottom-full.max-h-96')
  await card.waitFor()
  await card.getByText('Loading…').waitFor({ state: 'detached' })
  return card
}

export default async function Codex_계정_설정_명령이_기존_UI와_명시적_경계를_사용한다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: { agentBackend: 'codex' },
          transcript: [
            { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: Date.now() - 1 },
            { id: 'assistant-e2e', type: 'assistant', text: 'Ready.', ts: Date.now() }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        // 실제 계정 로그아웃과 실제 config 조회를 금지하고, 같은 IPC 경계의 결정적 응답으로 바꾼다.
        await wooi.app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('command:run')
          ipcMain.handle('command:run', (_event, _workspaceId, kind) => {
            if (kind === 'debugConfig') {
              return {
                result: {
                  kind: 'debugConfig',
                  config: { model: 'gpt-e2e', api_key: '[redacted]' },
                  sources: ['/tmp/wooi-e2e/config.toml']
                }
              }
            }
            if (kind === 'experimental') {
              return {
                result: {
                  kind: 'unsupported',
                  command: '/experimental',
                  reason:
                    'Codex app-server 0.146 does not expose experimental-feature metadata or a safe feature-toggle method.'
                }
              }
            }
            return { error: `unexpected command: ${kind}` }
          })
          ipcMain.removeHandler('auth:codexLogout')
          ipcMain.handle('auth:codexLogout', () => undefined)
        })

        await openSeededWorkspace(wooi.win)
        await wooi.win.locator('textarea[placeholder^="Message your agent"]').waitFor()

        const debugCard = await openCard(wooi.win, '/debug-config')
        const debugText = await debugCard.innerText()
        expectIncludes(debugText, '/debug-config', '/debug-config title')
        expectIncludes(debugText, 'gpt-e2e', '/debug-config value')
        expectIncludes(debugText, '[redacted]', '/debug-config redaction')
        expectIncludes(debugText, '/tmp/wooi-e2e/config.toml', '/debug-config source')
        console.log(`[e2e] screenshot=${await wooi.shot('codex-debug-config')}`)
        await wooi.win.keyboard.press('Escape')

        const experimentalCard = await openCard(wooi.win, '/experimental')
        const experimentalText = await experimentalCard.innerText()
        expectIncludes(experimentalText, '/experimental', '/experimental title')
        expectIncludes(experimentalText, 'app-server 0.146', '/experimental boundary')
        expectIncludes(experimentalText, 'safe feature-toggle method', '/experimental boundary')
        console.log(`[e2e] screenshot=${await wooi.shot('codex-experimental-unsupported')}`)
        await wooi.win.keyboard.press('Escape')

        await submit(wooi.win, '/logout')
        await wooi.win.getByRole('heading', { name: 'Sign out of Codex?' }).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('codex-logout-confirm')}`)
        await wooi.win.getByRole('button', { name: 'Sign out' }).click()
        await wooi.win.getByRole('heading', { name: 'Integrations' }).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('codex-logout-integrations')}`)
        await wooi.win.getByRole('button', { name: 'Close settings' }).click()
        await wooi.win.getByRole('heading', { name: 'Integrations' }).waitFor({ state: 'detached' })

        await submit(wooi.win, '/plugins')
        await wooi.win.getByRole('heading', { name: 'Plugins' }).waitFor()
        expectIncludes(
          await wooi.win.locator('main').innerText(),
          'INSTALLED IN CODEX',
          '/plugins page'
        )
        console.log(`[e2e] screenshot=${await wooi.shot('codex-plugins-settings')}`)

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
