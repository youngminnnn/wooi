/* global console, process */

import {
  dismissToasts,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * ⇧⌘B 는 헤더의 Rebase 칩과 **같은 판정** 위에서 동작한다.
 *
 * 게이트 자체는 렌더러 단위 테스트가 경우별로 덮는다(rebaseGate.test.ts). 여기서 증명할 것은
 * 그 판정이 진짜 창에서 이어지는지다 — 진짜 워크트리의 git 상태가 읽히고, 진짜 키가 App 의
 * 전역 핸들러를 지나, 칩이 회색인 것과 **같은 이유**로 막히며 그 이유를 소리 내어 말하는 경로.
 *
 * 막히는 쪽을 고른 이유는 그것이 이 단축키의 위험한 절반이기 때문이다. restackOnto 는 rebase 가
 * 필요 없어도 리모트를 force-push 하므로, 여기서 조용히 통과하면 히스토리가 이유 없이 다시 쓰인다.
 */
export default async function 리베이스_단축키가_칩과_같은_판정을_따른다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        await openSeededWorkspace(win)

        // 1. 칩이 떴다는 것은 이 워크트리의 git 상태를 실제로 읽었다는 뜻이다(git 이 없으면
        //    ChatView 가 아예 렌더하지 않는다). 스크래치 워크트리는 main 과 같은 커밋 위에 있다.
        const chip = win.locator('.workspace-header-basesync button').first()
        await chip.waitFor()
        const title = await chip.getAttribute('title')
        if (title !== 'Up to date with main') {
          throw new Error(`chip should report the up-to-date state, got ${JSON.stringify(title)}`)
        }
        if (await chip.isEnabled()) {
          throw new Error('chip should be disabled while the branch is up to date')
        }

        // 2. 시작 안내 토스트를 걷어 낸다 — 아래에서 우리 토스트만 남는지 보려면 자리가 비어야 한다.
        await dismissToasts(win)

        // 3. ⇧⌘B — 칩이 눌리지 않는 상태이므로 단축키도 같은 답을 내야 하고, 화면에 회색으로
        //    말할 자리가 없으므로 이유를 토스트로 말해야 한다.
        await win.keyboard.press('Meta+Shift+B')
        await win.locator('[role="alert"]').getByText('Already up to date with main.').waitFor()
        console.log(`[e2e] blocked=${await wooi.shot('rebase-shortcut-up-to-date')}`)

        // 4. 단축키가 도움말에도 실려 있어야 한다 — 아무도 모르는 단축키는 없는 것과 같다.
        await dismissToasts(win)
        await win.keyboard.press('?')
        const help = win.getByText('Keyboard shortcuts', { exact: false })
        await help.waitFor()
        const row = win
          .locator('div')
          .filter({ hasText: /^Rebase the workspace onto its base branch/ })
          .last()
        await row.waitFor()
        if (!(await row.textContent())?.includes('⇧⌘B')) {
          throw new Error('the shortcut help does not list ⇧⌘B next to the rebase row')
        }
        console.log(`[e2e] help=${await wooi.shot('rebase-shortcut-help')}`)
        await win.keyboard.press('Escape')

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
