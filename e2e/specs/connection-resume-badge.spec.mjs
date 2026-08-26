/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 연결이 끊겨 걸린 예약을 "rate limit" 이라고 부르면 사용자는 있지도 않은 제한이 풀리기를
 * 기다린다. 예약 레코드의 cause 가 존재하는 이유가 이 한 줄이므로, 사이드바가 실제로 무엇을
 * 그리는지 앱을 띄워 확인한다.
 */
const CONNECTION_TITLE =
  'Paused — no connection to the API — waiting for a network connection to continue'

export default async function 연결이_끊겨_멈춘_워크스페이스는_제한이_아니라_연결을_기다린다고_말한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: {
            sessionId: 'session-e2e-seeded',
            pendingRateLimitResume: {
              backend: 'claude',
              sessionId: 'session-e2e-seeded',
              detectedAt: Date.now(),
              retryAt: Date.now() + 30_000,
              attempt: 0,
              blocked: 'offline',
              cause: 'connection'
            }
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        // 같은 툴팁이 두 곳에 붙는다 — 행 왼쪽의 상태 아이콘(글자 없음)과 메타 줄의 배지.
        // 문구를 검사할 것은 뒤쪽이므로 글자가 있는 쪽을 고른다.
        const badges = wooi.win.locator(`[title="${CONNECTION_TITLE}"]`)
        await badges.first().waitFor()

        const text = (await badges.allInnerTexts()).find((item) => item.trim().length > 0) ?? ''
        if (!text.includes('no connection')) {
          throw new Error(`sidebar badge did not name the connection: ${JSON.stringify(text)}`)
        }
        // 사용량 제한이 아니다 — 그렇게 말하면 사용자는 없는 제한을 기다린다.
        if (text.includes('rate limit')) {
          throw new Error(`sidebar badge still called it a rate limit: ${JSON.stringify(text)}`)
        }
        // 연결이 언제 돌아올지는 우리가 모른다 — 카운트다운은 거짓말이 된다.
        if (text.includes('resumes in')) {
          throw new Error(`sidebar badge counted down to an unknown time: ${JSON.stringify(text)}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('connection-resume-badge')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
