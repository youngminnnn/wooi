/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * ⌘+ / ⌘- / ⌘0 은 **대화만** 키우고 줄인다.
 *
 * 이 기능의 존재 이유가 "앱 전체가 아니라 채팅 표면만" 이므로, 단언도 거기에 걸어야 한다 —
 * 대화 글자는 커지고 사이드바는 그대로여야 한다. 둘 다 실제 레이아웃을 재야 알 수 있는 사실이라
 * 렌더러 단위 테스트로는 증명할 수 없다(jsdom 은 모든 상자가 0×0 이다).
 */
const AGENT_LINE = 'font-scale measured paragraph'

export default async function 대화_글자_크기는_채팅_표면에만_걸린다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user-1', type: 'user', text: 'measure me', ts: now - 1 },
            { id: 'assistant-1', type: 'assistant', text: AGENT_LINE, ts: now }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const message = wooi.win.locator('[data-item-id="assistant-1"]')
        await message.waitFor()
        const sidebarRow = wooi.win.locator('[role="button"]').first()

        const baseMessage = await height(message, 'the seeded message')
        const baseSidebar = await height(sidebarRow, 'the sidebar row')

        // ── ⌘+ 는 대화만 키운다 ─────────────────────────────────────────────
        await wooi.win.keyboard.press('Meta+=')
        await wooi.win.waitForTimeout(300)
        const grown = await height(message, 'the seeded message')
        if (grown <= baseMessage) {
          throw new Error(`⌘+ did not enlarge the conversation: ${baseMessage} -> ${grown}`)
        }
        const sidebarAfter = await height(sidebarRow, 'the sidebar row')
        if (Math.abs(sidebarAfter - baseSidebar) > 1) {
          throw new Error(
            `⌘+ leaked outside the chat surface — the sidebar row went ${baseSidebar} -> ${sidebarAfter}`
          )
        }
        console.log(`[e2e] screenshot=${await wooi.shot('chat-font-scale-larger')}`)

        // ── ⌘0 은 원래대로 되돌린다 ─────────────────────────────────────────
        await wooi.win.keyboard.press('Meta+0')
        await wooi.win.waitForTimeout(300)
        const reset = await height(message, 'the seeded message')
        if (Math.abs(reset - baseMessage) > 1) {
          throw new Error(`⌘0 did not restore the default scale: ${baseMessage} -> ${reset}`)
        }

        // ── ⌘- 는 줄이고, 바닥에서 멈춘다 ───────────────────────────────────
        await wooi.win.keyboard.press('Meta+-')
        await wooi.win.waitForTimeout(300)
        const shrunk = await height(message, 'the seeded message')
        if (shrunk >= baseMessage) {
          throw new Error(`⌘- did not shrink the conversation: ${baseMessage} -> ${shrunk}`)
        }
        // 최소 배율(0.8)까지는 두 스텝이면 닿는다. 그 뒤로는 더 줄지 않아야 한다.
        for (let i = 0; i < 6; i++) await wooi.win.keyboard.press('Meta+-')
        await wooi.win.waitForTimeout(300)
        const floor = await height(message, 'the seeded message')
        for (let i = 0; i < 3; i++) await wooi.win.keyboard.press('Meta+-')
        await wooi.win.waitForTimeout(300)
        const stillFloor = await height(message, 'the seeded message')
        if (Math.abs(stillFloor - floor) > 1) {
          throw new Error(`the scale kept shrinking past its floor: ${floor} -> ${stillFloor}`)
        }
        console.log(`[e2e] screenshot=${await wooi.shot('chat-font-scale-smaller')}`)

        // ── 기억은 다음 실행까지 간다 ───────────────────────────────────────
        await wooi.win.keyboard.press('Meta+0')
        await wooi.win.waitForTimeout(300)
        const remembered = await wooi.win.evaluate(() =>
          globalThis.localStorage.getItem('wooi.chatFontScale')
        )
        if (remembered !== '1') {
          throw new Error(`the reset scale was not remembered: ${JSON.stringify(remembered)}`)
        }

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

async function height(locator, what) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${what} was not on screen`)
  return Math.round(box.height * 100) / 100
}
