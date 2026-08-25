/* global console, process */

import {
  openRowMenuItem,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 이어받을 대화가 없으면 분기 입구는 **막히되 보여야** 한다.
 *
 * 감추면 아무것도 가르치지 못하고, 열어 두면 "New workspace" 와 구별되지 않는 빈 워크스페이스가
 * 생기는데 사용자는 기록이 딸려 왔다고 믿는다. 그래서 항목은 남기고 이유를 붙인다.
 * 사이드바 메뉴로 확인하는 이유는 헤더 보조 액션이 좁은 pane 에서 접히기 때문이다
 * ([[narrow-pane-header.spec]]) — 폭과 무관한 경로라야 이 스펙이 창 크기에 흔들리지 않는다.
 */
export default async function 대화가_없으면_분기_입구가_이유와_함께_막힌다() {
  await withScratchRepo(
    // 트랜스크립트를 주지 않으면 시드가 sessionId 를 null 로 둔다 = 이어받을 대화가 없는 상태.
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const item = await openRowMenuItem(wooi.win, 'Fork conversation')

        const disabled = await item.isDisabled()
        const reason = await item.getAttribute('title')
        if (!disabled) throw new Error('fork stayed clickable without a conversation to fork')
        if (reason !== 'No conversation to fork yet') {
          throw new Error(`fork was disabled without saying why: ${JSON.stringify(reason)}`)
        }

        const screenshot = await wooi.shot('conversation-fork-guard')
        console.log(`[e2e] forkDisabledReason=${JSON.stringify(reason)} screenshot=${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
