/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/** 캐시 배지의 툴팁 앞머리. 남은 시간이 뒤에 붙으므로 접두사로만 고른다. */
const CACHE_TIMER = '[title^="Prompt cache stays warm for"]'

/** 시드 시점 기준으로 남겨 둘 캐시 수명. 앱이 뜨는 데 몇 초 걸리므로 여유를 둔다. */
const REMAINING_AT_SEED_MS = 25_000
const TTL_MS = 5 * 60_000

/**
 * 카드의 프롬프트 캐시 카운트다운.
 *
 * 시드에서 `lastActiveAt` 을 만료 직전으로 밀어 두고, 배지가 사이드바 행과 현황판 카드에
 * 함께 뜬 뒤 **0이 되는 순간 사라지는지** 를 본다. 만료 후에도 남아 있는 타이머는
 * "지금 답하면 캐시 값" 이라는 거짓말이 되므로 사라지는 쪽이 이 기능의 계약이다.
 *
 * 이건 실제 시계가 필요한 검사다 — 공용 틱이 돌고, 만료 시한이 전부 지나면 표시가 걷힌다는
 * 사실은 단위 테스트의 가짜 타이머로는 같은 것을 증명하지 못한다.
 */
export default async function 캐시_카운트다운이_뜨고_만료되면_사라진다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: {
            // 세션이 있어야 캐시에 들어간 프롬프트가 있다는 뜻이 된다.
            sessionId: 'session-e2e-cache',
            status: 'idle',
            lastActiveAt: Date.now() - (TTL_MS - REMAINING_AT_SEED_MS)
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const timers = wooi.win.locator(CACHE_TIMER)
        await timers.first().waitFor({ timeout: 15_000 })

        // 사이드바 행과 현황판 카드 양쪽에 붙는다.
        const count = await timers.count()
        if (count < 2) {
          throw new Error(
            `cache timer was not shown on both the sidebar row and the card: ${count}`
          )
        }

        // 5분짜리 창은 분 단위로만 적으면 절반이 "<1m" 에 몰린다 — 분:초로 적혀야 한다.
        const label = (await timers.first().innerText()).trim()
        if (!/\d:\d\d$/.test(label)) {
          throw new Error(`cache countdown was not written as m:ss: ${JSON.stringify(label)}`)
        }

        const screenshot = await wooi.shot('prompt-cache-timer')

        // 만료. 0이 되면 표시가 걷혀야 한다.
        await timers.first().waitFor({ state: 'detached', timeout: REMAINING_AT_SEED_MS + 15_000 })
        if ((await timers.count()) !== 0) {
          throw new Error('an expired cache timer was left on screen')
        }

        console.log(`[e2e] countdown=${label} timers=${count} screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
