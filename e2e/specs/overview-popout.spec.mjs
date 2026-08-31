/* global console, process */

import { E2E_WORKSPACE_DISPLAY_NAME, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 현황판을 별도 창으로 뗀다.
 *
 * jsdom 으로는 증명할 수 없는 두 가지를 본다. 첫째, 두 번째 **실제 BrowserWindow** 가 뜨고
 * 그 창이 자기 스토어를 채워 보드를 그린다 — 팝아웃의 고전적인 실패는 창은 떴는데 상태가
 * 없어 빈 화면이 남는 것이라, 창의 존재가 아니라 창 안의 카드를 확인한다.
 * 둘째, 메인 창이 여전히 보드를 그린다 — 현황판은 work/scripts 와 달리 이동이 아니라
 * 복제이고, 그게 "보조 모니터에 띄워 두고 메인에서 계속 일한다" 는 이 기능의 전부다.
 */
export default async function 현황판을_별도_창으로_뗀다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        // 워크스페이스를 고르지 않은 상태가 현황판이다 — 시드 직후가 그 상태다.
        const detach = wooi.win.locator('[aria-label="Open the overview in a separate window"]')
        await detach.waitFor()

        const opened = wooi.app.waitForEvent('window')
        await detach.click()
        const pane = await opened
        await pane.waitForLoadState('domcontentloaded')

        const url = pane.url()
        if (!url.includes('pane=overview')) {
          throw new Error(`popout window did not open as the overview pane: ${url}`)
        }

        // 창이 뜬 것만으로는 부족하다. 카드가 그려져야 스토어가 실제로 채워진 것이다.
        await pane.locator(`[title="${E2E_WORKSPACE_DISPLAY_NAME}"]`).waitFor({ timeout: 15_000 })
        const paneBody = await pane.locator('body').innerText()
        if (paneBody.includes('Loading…')) {
          throw new Error('popout window is still on the loading placeholder')
        }
        // 현황판은 워크스페이스에 매이지 않는다 — 제목에 세션 이름을 달면 안 된다.
        if (!paneBody.includes('Overview')) {
          throw new Error(
            `popout window did not render the overview board: ${paneBody.slice(0, 200)}`
          )
        }

        // 복제이므로 메인 창의 보드는 그대로 남아야 한다(이동이면 여기가 비어 있을 것이다).
        await wooi.win.locator(`[title="${E2E_WORKSPACE_DISPLAY_NAME}"]`).first().waitFor()
        if (!(await detach.isVisible())) {
          throw new Error('main window collapsed its overview after the popout opened')
        }

        const screenshot = await wooi.shot('overview-popout-main')
        console.log(`[e2e] paneUrl=${url} screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
