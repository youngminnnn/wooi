/* global console, process, document */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E_WORKSPACE_DISPLAY_NAME, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const BRANCHES = ['nav-one', 'nav-two', 'nav-three']
// 첫 워크스페이스만 시드가 displayName 을 붙인다 — 나머지는 worktree 이름 그대로 뜬다.
const HEADINGS = [E2E_WORKSPACE_DISPLAY_NAME, 'nav-two', 'nav-three']

/**
 * ⌘1–9 · ⌘[ · ⌘] · ⇧⌘T 가 실제 창에서 실제로 워크스페이스를 옮기는지 본다.
 *
 * 스택 계산 자체는 유닛 테스트(workspaceHistory · reopenArchived)가 이미 증명한다. 여기서만
 * 알 수 있는 것은 **그 순수 함수가 사용자의 키에 이어져 있는가** 다 — 전역 keydown 이 키를
 * 집어내는지, 사이드바 번호와 ⌘n 이 같은 순서를 가리키는지, 그리고 ⇧⌘T 가 정말로 worktree 를
 * 다시 만들어 워크스페이스를 되살리는지. 마지막 것은 jsdom 이 흉내 낼 수 없다 — 진짜 git 이
 * 디렉터리를 지우고 다시 만드는 왕복이기 때문이다.
 */
async function seedThreeWorkspaces(scratch) {
  const seeded = await seedAppState(scratch, { workspaceName: BRANCHES[0] })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const first = state.workspaces[0]

  // 나머지는 첫 워크스페이스를 템플릿으로 만든다 — Workspace 필수 필드가 늘어도 따라간다.
  // 스택이 아니라 형제로 둔다(parentWorkspaceId: null): 사이드바 순서가 배열 순서와 같아야
  // "위에서 n번째 = ⌘n" 을 그대로 검사할 수 있다.
  state.workspaces.push(
    ...BRANCHES.slice(1).map((branch) => ({
      ...first,
      id: `ws-${branch}`,
      name: branch,
      displayName: null,
      branch,
      worktreePath: scratch.worktrees[branch],
      sessionId: null
    }))
  )
  await writeFile(file, JSON.stringify(state, null, 2))
  return seeded
}

/** 지금 열려 있는 워크스페이스의 헤더 이름. 아무것도 열려 있지 않으면 null. */
function openWorkspaceName(win) {
  return win.evaluate(() => {
    const el = document.querySelector('.workspace-header-identity')
    return el ? el.innerText.trim() : null
  })
}

/** 헤더가 기대한 워크스페이스를 가리킬 때까지 기다린다. 실패하면 실제로 열린 것을 알려 준다. */
async function expectOpen(win, expected, step) {
  try {
    await win.waitForFunction(
      (name) => {
        const el = document.querySelector('.workspace-header-identity')
        return !!el && el.innerText.includes(name)
      },
      expected,
      { timeout: 10_000 }
    )
  } catch {
    throw new Error(
      `${step}: expected "${expected}" to be open, but the header showed ${JSON.stringify(
        await openWorkspaceName(win)
      )}`
    )
  }
}

export default async function 워크스페이스_방문_이력과_다시_열기() {
  await withScratchRepo({ worktrees: BRANCHES, seed: seedThreeWorkspaces }, async (scratch) => {
    const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
    const { win } = wooi
    try {
      // 0. 도움말에 등재돼 있다 — 보이지 않는 단축키는 없는 것과 같다.
      await win.keyboard.press('Shift+Slash')
      await win.getByText('Keyboard shortcuts').first().waitFor({ timeout: 5000 })
      for (const key of ['⌘[', '⌘]', '⇧⌘T']) {
        const listed = await win.locator('kbd', { hasText: key }).count()
        if (listed === 0) {
          throw new Error(`shortcuts help does not list ${key} — an unlisted shortcut is invisible`)
        }
      }
      await win.keyboard.press('Escape')
      await win.getByText('Keyboard shortcuts').first().waitFor({ state: 'hidden', timeout: 5000 })

      // 1. 사이드바 번호와 ⌘n 이 같은 순서를 가리킨다.
      for (const [i, branch] of BRANCHES.entries()) {
        const row = win.locator('[role="button"]').filter({ hasText: branch }).first()
        const badge = row.locator(`kbd[title="Switch with ⌘${i + 1}"]`)
        if ((await badge.count()) === 0) {
          throw new Error(
            `sidebar row "${branch}" is not numbered ⌘${i + 1} — ⌘n would not match "위에서 n번째"`
          )
        }
      }

      // 2. ⌘1 → ⌘2 → ⌘3 으로 방문 이력을 쌓는다.
      for (const [i, heading] of HEADINGS.entries()) {
        await win.keyboard.press(`Meta+${i + 1}`)
        await expectOpen(win, heading, `⌘${i + 1}`)
      }

      // 3. ⌘[ 로 방문한 순서를 거슬러 올라간다.
      await win.keyboard.press('Meta+BracketLeft')
      await expectOpen(win, HEADINGS[1], '⌘[ 한 번')
      await win.keyboard.press('Meta+BracketLeft')
      await expectOpen(win, HEADINGS[0], '⌘[ 두 번')

      // 4. ⌘] 로 물러난 만큼 정확히 되짚어 온다. 앞으로가기가 없던 동안은 이 길이 없었다.
      await win.keyboard.press('Meta+BracketRight')
      await expectOpen(win, HEADINGS[1], '⌘] 한 번')
      await win.keyboard.press('Meta+BracketRight')
      await expectOpen(win, HEADINGS[2], '⌘] 두 번')
      console.log(`[e2e] screenshot=${await wooi.shot('nav-history-forward')}`)

      // 5. 아카이브하면 사이드바에서 사라지고 Overview 로 빠진다.
      const target = win.locator('[role="button"]').filter({ hasText: BRANCHES[2] }).first()
      await target.click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Archive workspace' }).click()
      await win.getByRole('button', { name: 'Archive', exact: true }).click()
      await win.waitForFunction(
        () => !document.querySelector('.workspace-header-identity'),
        undefined,
        { timeout: 15_000 }
      )

      // 6. ⇧⌘T 가 그 워크스페이스를 되살려 연다 — worktree 를 다시 만드는 진짜 왕복이다.
      await win.keyboard.press('Meta+Shift+T')
      await expectOpen(win, HEADINGS[2], '⇧⌘T')
      console.log(`[e2e] screenshot=${await wooi.shot('nav-reopen-archived')}`)

      await waitForInspection(win)
    } finally {
      await wooi.close()
    }
  })
}
