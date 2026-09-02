/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 종료로 끊긴 턴을 "rate limit" 이나 그냥 idle 로 그리면 사용자는 있지도 않은 제한이 풀리기를
 * 기다리거나, 이어질 일이 없다고 믿고 같은 지시를 다시 친다. 두 예약은 필드도 모듈도 다른데
 * 화면 문구는 한 사다리(workspaceStatus)를 공유하므로, 한쪽 문구를 재사용하는 실수가 유닛
 * 테스트를 통과한 채 화면까지 흘러갈 수 있다. 그래서 앱을 띄워 실제로 무엇을 그리는지 본다.
 *
 * 모델 턴은 돌리지 않는다 — pendingShutdownResume 은 정본이 Workspace 필드라 시드로 만든다.
 */
const SHUTDOWN_TITLE = 'Interrupted by shutdown'

export default async function 종료로_끊긴_턴은_제한이_아니라_메시지를_기다린다고_말한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: {
            sessionId: 'session-e2e-seeded',
            pendingShutdownResume: {
              backend: 'claude',
              sessionId: 'session-e2e-seeded',
              at: Date.now() - 60_000,
              reason: 'update',
              handled: true
            }
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        // 같은 툴팁이 두 곳에 붙는다 — 행 왼쪽의 상태 아이콘(글자 없음)과 메타 줄의 배지.
        // 문구를 검사할 것은 뒤쪽이므로 글자가 있는 쪽을 고른다.
        const badges = wooi.win.locator(`[title="${SHUTDOWN_TITLE}"]`)
        await badges.first().waitFor()

        const text = (await badges.allInnerTexts()).find((item) => item.trim().length > 0) ?? ''
        if (!text.includes('interrupted by shutdown') || !text.includes('send a message')) {
          throw new Error(`sidebar badge did not explain how to continue: ${JSON.stringify(text)}`)
        }
        // 사용량 제한이 아니다 — 그렇게 말하면 사용자는 없는 제한이 풀리기를 기다린다.
        if (text.includes('rate limit') || text.includes('usage limit')) {
          throw new Error(`sidebar badge called it a usage limit: ${JSON.stringify(text)}`)
        }
        // 언제 다시 열지는 사용자가 정한다 — 카운트다운은 거짓말이 된다.
        if (text.includes('resumes in')) {
          throw new Error(`sidebar badge counted down to an unknown time: ${JSON.stringify(text)}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('shutdown-resume-badge')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
