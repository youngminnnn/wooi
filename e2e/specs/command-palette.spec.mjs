/* global console, process */

import {
  dismissToasts,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * ⌘K 는 이제 워크스페이스만 찾지 않는다 — 동작·커맨드·설정을 한 검색창에서 찾아 실행한다.
 *
 * 인덱스 조립과 랭킹은 렌더러 단위 테스트가 경우별로 덮는다(commandPalette.test.ts). 여기서
 * 증명할 것은 **그 목록이 진짜 창에서 진짜 동작에 닿는지** 다. 순수 함수 테스트가 볼 수 없는
 * 구간이 셋 있다:
 *
 * 1. 팔레트가 워크스페이스 말고 다른 종류를 실제로 그리는가.
 * 2. 항목을 고르면 전역 단축키와 **같은 몸통**(`runPaletteAction`)이 돌아 화면이 바뀌는가.
 *    이 PR 의 알맹이가 그 리팩터라, 여기가 끊기면 팔레트는 예쁜 목록일 뿐이다.
 * 3. 지금 불가능한 동작이 **숨지 않고** 이유를 말하는가 — 그리고 그 이유가 단축키가 말하는
 *    문장과 같은가. rebase 행을 고른 이유가 그것이다: ⇧⌘B 토스트와 한 글자도 다르면 안 된다
 *    (rebase-shortcut.spec 이 그 토스트 쪽을 잡고 있다).
 */
export default async function 명령_팔레트가_동작을_찾아_실행한다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        await openSeededWorkspace(win)
        // 시작 안내 토스트를 걷어 낸다 — 팔레트가 화면 위쪽을 덮으므로 자리가 비어야 한다.
        await dismissToasts(win)

        const palette = win.locator('[role="dialog"][aria-label="Command palette"]')
        const query = palette.getByPlaceholder('Search workspaces, actions, commands and settings…')

        // 1. ⌘K — 워크스페이스 말고 다른 종류가 실제로 그려지는가. 섹션 제목이 그 증거다.
        await win.keyboard.press('Meta+K')
        await palette.waitFor()
        for (const section of ['Workspaces', 'Actions', 'Commands', 'Settings']) {
          await palette.getByText(section, { exact: true }).first().waitFor()
        }
        console.log(`[e2e] sections=${await wooi.shot('command-palette-sections')}`)

        // 2. 동작을 골라 실행한다. 이 행의 라벨은 단축키 도움말이 들고 있는 것이고(단일 소스),
        //    Enter 는 전역 ? 키와 같은 함수를 지나야 한다 — 도움말이 뜨면 그 길이 이어진 것이다.
        await query.fill('keyboard shortcuts')
        const helpRow = palette
          .locator('[role="button"]')
          .filter({ hasText: 'Show keyboard shortcuts' })
          .first()
        await helpRow.waitFor()
        await win.keyboard.press('Enter')
        await win.getByText('Keyboard shortcuts', { exact: false }).first().waitFor()
        if (await palette.isVisible()) {
          throw new Error('the palette should close once an action runs')
        }
        console.log(`[e2e] ran=${await wooi.shot('command-palette-ran-action')}`)
        await win.keyboard.press('Escape')

        // 3. 지금 할 수 없는 동작은 목록에서 사라지지 않고 이유를 말한다. 스크래치 워크트리는
        //    main 과 같은 커밋 위에 있으므로 rebase 가 막혀 있고, 그 문장은 ⇧⌘B 를 눌렀을 때
        //    토스트로 나오는 것과 **같아야** 한다 — 판정을 게이트 한 곳에서만 하기 때문이다.
        await win.keyboard.press('Meta+K')
        await palette.waitFor()
        await query.fill('rebase')
        const rebaseRow = palette
          .locator('[role="button"]')
          .filter({ hasText: 'Rebase the workspace onto its base branch' })
          .first()
        await rebaseRow.waitFor()
        if ((await rebaseRow.getAttribute('aria-disabled')) !== 'true') {
          throw new Error('the rebase row should be disabled while the branch is up to date')
        }
        const reason = await rebaseRow.textContent()
        if (!reason?.includes('Already up to date with main.')) {
          throw new Error(
            `the rebase row should say why it is blocked, got ${JSON.stringify(reason)}`
          )
        }
        console.log(`[e2e] disabled=${await wooi.shot('command-palette-disabled-reason')}`)

        // 4. 접두사는 종류를 좁힌다. `#` 이면 설정만 남아야 한다 — 워크스페이스 섹션이 사라지는
        //    것까지 봐야 "좁혔다"가 증명된다.
        await query.fill('#mcp')
        await palette.getByText('Settings', { exact: true }).first().waitFor()
        await palette.getByText('Settings — MCP servers', { exact: false }).first().waitFor()
        if (await palette.getByText('Workspaces', { exact: true }).first().isVisible()) {
          throw new Error('the # prefix should leave only the Settings section')
        }
        console.log(`[e2e] prefix=${await wooi.shot('command-palette-prefix-filter')}`)
        await win.keyboard.press('Escape')

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
