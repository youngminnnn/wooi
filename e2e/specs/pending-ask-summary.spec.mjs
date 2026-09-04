/* global console, process */

import { sendPermissionRequest, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 승인 대기가 방패 아이콘 하나로만 보이면, 다섯 개가 동시에 물을 때 우선순위를 정하려고
 * 다섯 번 열어 봐야 한다. 무엇을 묻는지 한 줄이 실제로 목록까지 나가는지를 앱을 띄워 확인한다.
 *
 * jsdom 으로는 부족하다 — 이 한 줄은 스토어에 쌓인 요청이 IPC 로 들어와 사이드바와 Overview
 * 라는 서로 다른 두 화면에 동시에 닿아야 성립하고, 그 배선이 끊기는 자리가 컴포넌트 밖이다.
 */
const QUESTION = 'Which auth method should we use?'
const OVERVIEW_BUTTON_TITLE = 'Overview — all active sessions at a glance'

/** 같은 문구가 상태 아이콘 툴팁과 글자 줄 양쪽에 붙는다 — 글자가 있는 쪽만 고른다. */
async function visibleText(locator) {
  return (await locator.allInnerTexts()).find((item) => item.trim().length > 0) ?? ''
}

export default async function 입력을_기다리는_워크스페이스는_무엇을_묻는지_목록에_보여_준다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await sendPermissionRequest(wooi.app, {
          requestId: 'req-e2e-question',
          workspaceId: 'ws-e2e',
          toolName: 'AskUserQuestion',
          kind: 'question',
          input: {
            questions: [
              {
                header: 'Auth',
                question: QUESTION,
                options: [
                  { label: 'OAuth', description: 'Delegate to the provider' },
                  { label: 'Session cookies', description: 'Keep it in our own database' }
                ]
              }
            ]
          }
        })

        const summaries = wooi.win.locator(`[title="${QUESTION}"]`)
        await summaries.first().waitFor()

        const sidebarText = await visibleText(summaries)
        if (!sidebarText.includes(QUESTION)) {
          throw new Error(`sidebar row did not show the question: ${JSON.stringify(sidebarText)}`)
        }

        // 카드 쪽도 같은 한 줄을 받아야 한다. 여러 워크스페이스를 훑는 화면이 바로 여기다.
        await wooi.win.locator(`[title="${OVERVIEW_BUTTON_TITLE}"]`).click()
        const cardSummaries = wooi.win.locator(`[title="${QUESTION}"]`)
        await cardSummaries.first().waitFor()
        const cardText = await visibleText(cardSummaries)
        if (!cardText.includes(QUESTION)) {
          throw new Error(`overview card did not show the question: ${JSON.stringify(cardText)}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('pending-ask-summary')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
