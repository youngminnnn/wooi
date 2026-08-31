/* global console, process */

import {
  openRowMenuItem,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const SKIP_LABEL = "Don't ask again"
const SKIP_TOAST = "Wooi won't ask again before archiving a workspace."
const SETTINGS_SWITCH = 'Ask before archiving a workspace'

/**
 * "다시 묻지 않기" 는 **되돌릴 길과 함께**여야 쓸 만하다.
 *
 * 스킵만 저장하고 끝내면 사용자는 실수로 끈 확인을 되살릴 방법을 영영 못 찾는다. 그래서 이
 * 스펙이 지키는 것은 체크박스가 뜨는지가 아니라 **끈 직후의 되돌리는 경로가 실제로 이어지는지**다
 * — 저장 → 토스트 → "Open settings" → 다시 켤 스위치까지 한 줄로 확인한다.
 *
 * 취소했을 때 저장하지 않는 것도 같이 못박는다. 승인한 적 없는 동작을 앞으로 자동 승인하게
 * 되는 회귀는 화면만 봐서는 드러나지 않고, 다음 아카이브 때 조용히 나타난다.
 */
export default async function 확인을_끄면_되돌릴_길이_함께_주어진다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win
      const skipBox = win.getByLabel(SKIP_LABEL)
      const confirmButton = win.getByRole('button', { name: 'Archive', exact: true })
      const savedSkips = () =>
        win.evaluate(async () => (await globalThis.api.getState()).settings.confirmSkips ?? {})

      try {
        await openSeededWorkspace(win)

        // ── 1. 체크했더라도 취소하면 아무것도 저장하지 않는다 ──────────────────
        ;(await openRowMenuItem(win, 'Archive workspace')).click()
        await skipBox.waitFor()
        await skipBox.check()
        await win.getByRole('button', { name: 'Cancel' }).click()
        await skipBox.waitFor({ state: 'detached' })

        const afterCancel = await savedSkips()
        if (afterCancel.archiveWorkspace) {
          throw new Error('cancelling the dialog still saved the skip preference')
        }

        // ── 2. 다시 열면 체크박스는 꺼진 채로 돌아온다 ────────────────────────
        ;(await openRowMenuItem(win, 'Archive workspace')).click()
        await skipBox.waitFor()
        if (await skipBox.isChecked()) {
          throw new Error('the skip checkbox stayed checked when the dialog reopened')
        }

        // ── 3. 체크하고 승인하면 저장되고, 되돌릴 자리로 데려가는 토스트가 뜬다 ──
        await skipBox.check()
        await confirmButton.click()

        const toast = win.getByText(SKIP_TOAST)
        await toast.waitFor()

        const afterConfirm = await savedSkips()
        if (afterConfirm.archiveWorkspace !== true) {
          throw new Error(
            `the skip preference was not persisted through main: ${JSON.stringify(afterConfirm)}`
          )
        }
        // 하나를 껐다고 다른 확인까지 꺼지면 안 된다 — 종류별로 따로 저장하는 이유다.
        if (afterConfirm.archiveReview) {
          throw new Error('skipping one confirmation also disabled another kind')
        }

        // ── 4. 토스트의 버튼이 실제로 다시 켤 자리로 데려간다 ──────────────────
        await win.getByRole('button', { name: 'Open settings' }).click()

        const reEnable = win.getByRole('switch', { name: SETTINGS_SWITCH })
        await reEnable.waitFor()
        const asking = await reEnable.getAttribute('aria-checked')
        if (asking !== 'false') {
          throw new Error(`settings did not show the confirmation as turned off: ${asking}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('confirmation-skip-settings')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
