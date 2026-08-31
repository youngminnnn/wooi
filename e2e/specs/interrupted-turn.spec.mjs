/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 사용자가 끊은 턴과 에이전트가 스스로 마친 턴은 둘 다 idle 로 수렴한다. 목록을 훑을 때 둘 다
 * 같은 회색 점이면 재개할 대상을 고를 수 없다 — 그 구분이 실제 화면까지 나오는지 확인한다.
 *
 * 재시작을 거쳐 확인하는 이유가 있다: 표시는 Workspace 에 영속되는 옵셔널 필드이고, 스키마
 * 버전을 올리지 않고 얹었다. 저장된 레코드가 마이그레이션 없이 그대로 읽히는지는 앱을 실제로
 * 다시 띄워 봐야만 증명된다.
 */
const INTERRUPTED_TITLE = 'Stopped by you — the turn did not finish'
const OVERVIEW_BUTTON_TITLE = 'Overview — all active sessions at a glance'
const SESSION_ID = 'session-e2e-seeded'

export default async function 사용자가_끊은_턴은_완료와_다르게_표시된다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: {
            sessionId: SESSION_ID,
            interruptedTurn: { at: Date.now(), sessionId: SESSION_ID }
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await wooi.win.locator(`[title="${INTERRUPTED_TITLE}"]`).first().waitFor()

        // 카드는 상태 글자까지 사실대로 바꾼다 — status 자체는 여전히 idle 이라 글자만 다르다.
        await wooi.win.locator(`[title="${OVERVIEW_BUTTON_TITLE}"]`).click()
        const card = wooi.win.locator('button').filter({ hasText: 'interrupted' }).first()
        await card.waitFor()
        const cardText = await card.innerText()
        if (!cardText.includes('interrupted')) {
          throw new Error(
            `overview card did not call the turn interrupted: ${JSON.stringify(cardText)}`
          )
        }
        if (/\bidle\b/.test(cardText)) {
          throw new Error(
            `overview card still called the interrupted turn idle: ${JSON.stringify(cardText)}`
          )
        }

        console.log(`[e2e] screenshot=${await wooi.shot('interrupted-turn')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
