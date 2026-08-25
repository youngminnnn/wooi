/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const transcript = [
  { id: 'user-e2e', type: 'user', text: 'Seeded Codex conversation', ts: Date.now() - 1 },
  { id: 'assistant-e2e', type: 'assistant', text: 'Ready without a model turn.', ts: Date.now() }
]

function expectIncludes(actual, expected, subject) {
  if (!actual.includes(expected)) {
    throw new Error(
      `${subject}: expected text containing ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

function expectEqual(actual, expected, subject) {
  if (actual !== expected) {
    throw new Error(
      `${subject}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

async function openCard(win, command) {
  const textarea = win.locator('textarea[placeholder^="Message your agent"]')
  await textarea.click()
  await textarea.fill(`${command} `)
  await textarea.press('Enter')
  const card = win.locator('div.absolute.bottom-full.max-h-96')
  await card.waitFor()
  await card.getByText('Loading…').waitFor({ state: 'detached' })
  return card
}

async function closeCard(win) {
  await win.keyboard.press('Escape')
  await win.locator('div.absolute.bottom-full.max-h-96').waitFor({ state: 'detached' })
}

export default async function Codex_대화_제어_명령을_모델_턴_없이_실행한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript, workspace: { agentBackend: 'codex' } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const textarea = wooi.win.locator('textarea[placeholder^="Message your agent"]')
        await textarea.waitFor()

        // 네 명령이 Codex 자동완성에 모두 보인다. /goal은 실제 호출이 app-server 스레드를
        // 열어 외부 로그인 상태에 의존하므로, E2E에서는 노출과 로컬 인터셉트 경계까지만 고정한다.
        await textarea.fill('/')
        const menu = wooi.win.locator('div.absolute.bottom-full').filter({ hasText: '/status' })
        await menu.waitFor()
        const menuText = await menu.innerText()
        for (const command of ['/status', '/goal', '/plan', '/init']) {
          expectIncludes(menuText, command, 'Codex slash command menu')
        }
        await textarea.fill('')

        const statusCard = await openCard(wooi.win, '/status')
        const statusText = await statusCard.innerText()
        expectIncludes(statusText, '/status', '/status card title')
        expectIncludes(statusText, 'Permission mode', '/status permission state')
        expectIncludes(statusText, 'Working directory', '/status cwd state')
        expectIncludes(statusText, 'Plan usage', '/status usage state')
        console.log(`[e2e] screenshot=${await wooi.shot('codex-command-status')}`)
        await closeCard(wooi.win)

        const planCard = await openCard(wooi.win, '/plan')
        expectIncludes(await planCard.innerText(), 'Plan mode is now active.', '/plan card body')
        await wooi.win.locator('span').filter({ hasText: 'plan mode on' }).waitFor()
        const state = await wooi.win.evaluate(() => globalThis.api.getState())
        expectEqual(
          state.workspaces.find((workspace) => workspace.id === 'ws-e2e')?.permissionMode,
          'plan',
          '/plan stored permission mode'
        )
        console.log(`[e2e] screenshot=${await wooi.shot('codex-command-plan')}`)
        await closeCard(wooi.win)

        const agentsPath = join(scratch.worktrees['feature-test'], 'AGENTS.md')
        const initCard = await openCard(wooi.win, '/init')
        expectIncludes(await initCard.innerText(), 'Created', '/init created card')
        expectIncludes(await readFile(agentsPath, 'utf8'), '# AGENTS.md', '/init scaffold')
        await closeCard(wooi.win)

        // 기존 파일을 사용자가 고친 뒤 다시 실행해도 wx 생성이 내용을 보존한다.
        await writeFile(agentsPath, 'keep this exact content\n')
        const existingCard = await openCard(wooi.win, '/init')
        expectIncludes(
          await existingCard.innerText(),
          'no changes were made',
          '/init existing card'
        )
        expectEqual(
          await readFile(agentsPath, 'utf8'),
          'keep this exact content\n',
          '/init existing file contents'
        )
        console.log(`[e2e] screenshot=${await wooi.shot('codex-command-init-existing')}`)

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
