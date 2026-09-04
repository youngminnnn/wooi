/* global console, process, setTimeout */

import { seedAppState } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * ⌘Q 를 눌러도 돌던 일을 메뉴 막대에서 계속 굴리는 기능의 사용자 표면을 본다.
 *
 * 유닛 테스트는 electron 을 통째로 목킹하므로 "설정이 실제로 저장되는가"·"IPC 가 정말 등록돼
 * 있는가" 를 검사할 수 없다. 두 가지 모두 목이 아니라 진짜 앱에서만 드러난다 —
 * 실제로 이 기능의 트레이 아이콘 경로 버그도 앱을 띄우고서야 잡혔다.
 *
 * 백그라운드 전환 자체(⌘Q → 다이얼로그 → Tray)는 여기서 다루지 않는다. store 가 기동 시점에
 * 남은 'running' 을 씻어내므로([[main/store]]) 시드만으로는 "도는 일" 을 만들 수 없고, 모델
 * 턴은 e2e 에서 돌리지 않기 때문이다. 대신 그 판정의 **반대쪽**(도는 일이 없으면 막지 않는다)을
 * 실제 종료로 확인한다 — 여기서 잘못 막히면 사용자는 앱을 끌 수 없다.
 */
/** 종료가 teardown 을 마치기까지 기다리는 상한과 확인 주기. */
const QUIT_TIMEOUT_MS = 15_000
const QUIT_POLL_MS = 500

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const KEEP_WORKING_ROW = 'Keep working after you quit'
const ASK_BEFORE_QUIT_ROW = 'Ask before quitting while work is running'

/** 설정 모달을 연다(렌더러의 openSettings 와 같은 경로). */
async function openSettings(win, page) {
  await win.evaluate((target) => {
    globalThis.localStorage.setItem('settings.lastPage', target)
    globalThis.dispatchEvent(new globalThis.CustomEvent('wooi:open-settings'))
  }, page)
}

const settingsOf = (win) => win.evaluate(async () => (await globalThis.api.getState()).settings)

export default async function 백그라운드_계속하기_설정과_대기_승인_조회가_붙어_있다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      let quitCleanly = false
      try {
        // 시드는 이 키를 적지 않는다 — 그런 파일이 올라올 때 기본값 병합이 켜 두는 것이
        // 이 필드의 하위호환 계약이다(schemaVersion 을 올리지 않은 근거이기도 하다).
        const seeded = await settingsOf(wooi.win)
        if (seeded.keepWorkingInBackground !== true) {
          throw new Error(
            `a settings file without keepWorkingInBackground should default to true, got ${JSON.stringify(seeded.keepWorkingInBackground)}`
          )
        }

        // 창이 없는 동안 올라온 승인을 되살리는 조회다. 핸들러나 preload 배선이 빠지면
        // 여기서 거절되고, 그때 사용자는 답할 수 없는 승인 앞에서 영원히 멈춘다.
        const pending = await wooi.win.evaluate(() => globalThis.api.permission.pending())
        if (!Array.isArray(pending)) {
          throw new Error(
            `permission.pending() must return an array, got ${JSON.stringify(pending)}`
          )
        }

        await openSettings(wooi.win, 'general')
        const keepRow = wooi.win.locator(`text=${KEEP_WORKING_ROW}`).first()
        await keepRow.waitFor()
        // 확인을 끄는 스위치는 별도 그룹에 있다 — 설정(무엇을 하는가)과 확인(물어보는가)은
        // 서로 다른 결정이라 한 줄로 합치지 않았다.
        const askRow = wooi.win.locator(`text=${ASK_BEFORE_QUIT_ROW}`).first()
        await askRow.waitFor()
        // 두 행 모두 목록 아래쪽이라 스크롤해 두고 찍는다 — 산출물이 검사한 것을 보여줘야 한다.
        await keepRow.scrollIntoViewIfNeeded()
        console.log(`[e2e] screenshot=${await wooi.shot('keep-working-in-background')}`)

        // 끄면 디스크까지 내려가야 한다 — main 의 종료 가드가 읽는 것이 이 값이다.
        await wooi.win.getByRole('switch', { name: KEEP_WORKING_ROW }).click()
        await wooi.win.waitForTimeout(800)
        const afterToggle = await settingsOf(wooi.win)
        if (afterToggle.keepWorkingInBackground !== false) {
          throw new Error('turning the switch off did not persist keepWorkingInBackground=false')
        }

        // 도는 일이 없으면 ⌘Q 는 그냥 종료해야 한다. 가드가 여기서 막으면 앱이 안 꺼진다.
        // 종료는 teardown(세션·소켓·flush)을 거치므로 한 번 재 보고 끝내지 않고 기다린다.
        await wooi.app.evaluate(({ app }) => app.quit())
        let alive = true
        for (let waited = 0; waited < QUIT_TIMEOUT_MS && alive; waited += QUIT_POLL_MS) {
          await sleep(QUIT_POLL_MS)
          try {
            await wooi.app.evaluate(() => true)
          } catch {
            alive = false
          }
        }
        if (alive) throw new Error('quitting with no running work was blocked')
        quitCleanly = true
      } finally {
        if (!quitCleanly) await wooi.close()
      }
    }
  )
}
