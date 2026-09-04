/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * Wooi 가 사용자 대신 넣은 턴은 기본이 접힘이다([[shared/types]] WooiTurnOrigin).
 *
 * 이 턴들은 감추지 않는다 — 사용자가 치지 않았는데 토큰을 쓰므로 왜 돌았는지가 대화에 남아야
 * 한다. 다만 지시문 자체는 상용구 몇 줄이라, 펼쳐 둔 채로는 정작 읽어야 할 앞뒤 대화를 밀어낸다.
 *
 * 여기서 볼 것은 세 가지다.
 *
 * - 접힌 줄이 **무엇을 왜 시켰는지** 말하는가(label + Wooi 배지). 이게 없으면 사용자는 자기가
 *   치지도 않은 턴을 보고 "이건 왜 돌았지" 를 물을 데가 없다.
 * - 지시문 전문이 처음에는 화면에 **없는가.** 접힘의 목적이 이것이다.
 * - 눌러서 펼치면 전문이 그대로 있는가. 접는 것과 감추는 것의 차이가 여기서 갈린다.
 *
 * 사용자가 직접 친 턴은 그대로 말풍선이어야 한다 — 함께 확인한다. 접기 판정은 origin 하나로
 * 갈리므로, 그 갈림이 실제 화면에서 지켜지는지는 렌더러 단위 테스트가 아니라 여기서 증명된다.
 */
const TYPED = 'make the parser strict'
const LABEL = 'Continuing after the usage limit'
const CONTINUATION =
  'The previous turn stopped because the provider usage limit was reached. Inspect the current conversation and workspace state, then continue the unfinished task. Do not repeat work that is already complete.'
// 전문에만 있고 접힌 줄에는 없는 조각이라, 펼침 여부를 이 한 문장으로 가른다.
const CONTINUATION_TAIL = 'Do not repeat work that is already complete.'

export default async function wooi가_넣은_턴은_접힌_채로_뜬다() {
  const now = Date.now()
  const transcript = [
    { id: 'user-typed', type: 'user', text: TYPED, ts: now - 3 },
    { id: 'assistant-1', type: 'assistant', text: 'Working on it.', ts: now - 2 },
    {
      id: 'user-wooi',
      type: 'user',
      text: CONTINUATION,
      origin: { kind: 'wooi', label: LABEL },
      ts: now - 1
    },
    { id: 'assistant-2', type: 'assistant', text: 'Picking it back up.', ts: now }
  ]

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const win = wooi.win
        await win.locator('[data-item-id="assistant-2"]').waitFor()

        const card = win.locator('[data-item-id="user-wooi"]')

        // ── 접힌 줄이 무엇을 왜 시켰는지 말한다 ────────────────────────────────
        await expectText(win, LABEL, 'the folded label')
        await expectText(win, 'Wooi', 'the badge marking an unrequested turn')

        // ── 전문은 아직 화면에 없다 ───────────────────────────────────────────
        await expectNoText(win, CONTINUATION_TAIL, 'the continuation prompt')

        // 사용자가 직접 친 턴은 접히지 않는다 — 갈림이 origin 하나로 지켜지는지 함께 본다.
        await expectText(win, TYPED, 'the turn the user actually typed')

        const button = card.locator('button[aria-expanded]').first()
        if ((await button.getAttribute('aria-expanded')) !== 'false') {
          throw new Error('the Wooi turn was not collapsed on first render')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('wooi-turn-folded')}`)

        // ── 눌러서 펼치면 전문이 그대로 있다 ──────────────────────────────────
        await button.click()
        await expectText(win, CONTINUATION_TAIL, 'the expanded continuation prompt')
        if ((await button.getAttribute('aria-expanded')) !== 'true') {
          throw new Error('clicking the Wooi turn did not expand it')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('wooi-turn-expanded')}`)

        // ── 다시 누르면 접힌다 ────────────────────────────────────────────────
        await button.click()
        await expectNoText(win, CONTINUATION_TAIL, 'the re-folded continuation prompt')

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}

async function expectText(win, text, what) {
  try {
    await win.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 })
  } catch {
    throw new Error(`${what} was not on screen (looked for ${JSON.stringify(text)})`)
  }
}

async function expectNoText(win, text, what) {
  if ((await win.getByText(text, { exact: false }).count()) > 0) {
    throw new Error(`${what} was on screen but should not have been`)
  }
}
