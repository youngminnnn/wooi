/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const transcript = [
  { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: Date.now() - 1 },
  {
    id: 'assistant-e2e',
    type: 'assistant',
    text: 'Ready without a model turn.',
    ts: Date.now()
  }
]

/** 입력창에 치고 Enter 로 보낸 뒤, 뜬 토스트 문구를 돌려준다. */
async function sendAndReadToast(win, text) {
  const textarea = win.locator('textarea[placeholder^="Message your agent"]')
  await textarea.click()
  await textarea.fill(text)
  await textarea.press('Enter')
  // 토스트는 `[data-toast]` 로 집는다 — 예전엔 role="alert" 로 집었지만, 그 속성은 떼었다
  // (토스트 내용은 LiveRegion 이 polite 로 한 번만 읽는다). ARIA 를 셀렉터로 겸용하면
  // 접근성 결정을 바꾸는 순간 스펙이 조용히 엉뚱한 요소를 읽는다.
  const toast = win.locator('[data-toast]').last()
  await toast.waitFor()
  return (await toast.innerText()).trim()
}

/** 다음 단언이 지난 토스트를 읽지 않도록 열린 토스트를 모두 닫는다. */
async function dismissToasts(win) {
  const dismissButtons = win.locator('[data-toast] button[aria-label="Dismiss"]')
  while ((await dismissButtons.count()) > 0) await dismissButtons.first().click()
  await win.locator('[data-toast]').waitFor({ state: 'detached' })
}

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

async function workspaceStatus(win) {
  const state = await win.evaluate(() => globalThis.api.getState())
  return state.workspaces.find((workspace) => workspace.id === 'ws-e2e')?.status
}

export default async function 슬래시_명령이_실제_앱에서_입력과_상태를_올바르게_처리한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const textarea = wooi.win.locator('textarea[placeholder^="Message your agent"]')
        await textarea.waitFor()
        await dismissToasts(wooi.win)

        const stopToast = await sendAndReadToast(wooi.win, '/stop ')
        expectIncludes(stopToast, 'Nothing is running.', '/stop idle toast')
        expectEqual(await textarea.inputValue(), '', '/stop composer value')

        await dismissToasts(wooi.win)

        const subtaskToast = await sendAndReadToast(wooi.win, '/subtask ship the thing')
        expectIncludes(subtaskToast, '/wooi:team', '/subtask Solo toast')
        expectEqual(
          await textarea.inputValue(),
          '/subtask ship the thing',
          '/subtask Solo composer value'
        )
        expectEqual(await workspaceStatus(wooi.win), 'idle', 'Solo workspace status')

        const screenshot = await wooi.shot('slash-commands-solo')
        console.log(`[e2e] screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript, workspace: { multiAgent: true } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const textarea = wooi.win.locator('textarea[placeholder^="Message your agent"]')
        await textarea.waitFor()
        await dismissToasts(wooi.win)

        const usageToast = await sendAndReadToast(wooi.win, '/subtask ')
        expectIncludes(usageToast, 'Usage: /subtask <task>', '/subtask usage toast')
        expectEqual(await textarea.inputValue(), '/subtask ', '/subtask usage composer value')
        expectEqual(await workspaceStatus(wooi.win), 'idle', 'agent team workspace status')

        const screenshot = await wooi.shot('slash-commands-team')
        console.log(`[e2e] screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
