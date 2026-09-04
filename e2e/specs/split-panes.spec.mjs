/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissToasts, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const BASE = 'split-base'
const MID = 'split-mid'
const TOP = 'split-top'
const OUTSIDER = 'split-outsider'

/**
 * 세 층짜리 스택 하나와, 그 스택 **밖의** 워크스페이스 하나.
 *
 * 바깥 워크스페이스가 있어야 이 기능의 경계를 밟을 수 있다 — 분할은 임의의 두 개를 붙이는
 * 레이아웃이 아니라 "관계 있는 둘" 만 세우는 판정이고, 거절하는 쪽이 그 판정의 절반이다.
 */
async function seedStackAndOutsider(scratch) {
  await seedAppState(scratch, { workspaceName: BASE })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const template = state.workspaces[0]
  // 시드 기본 표시 이름은 길어서 행 텍스트 매칭을 흐린다 — 층 이름 그대로 읽히게 비운다.
  template.displayName = null

  const make = (name, parentWorkspaceId, baseBranch) => ({
    ...template,
    id: `ws-${name}`,
    name,
    displayName: null,
    branch: name,
    baseBranch,
    parentWorkspaceId,
    createdByWorkspaceId: parentWorkspaceId,
    worktreePath: scratch.worktrees[name],
    status: 'idle',
    sessionId: null
  })

  state.workspaces = [
    template,
    make(MID, template.id, BASE),
    make(TOP, `ws-${MID}`, MID),
    make(OUTSIDER, null, 'main')
  ]
  await writeFile(file, JSON.stringify(state, null, 2))
}

const row = (win, name) => win.locator('[role="button"]').filter({ hasText: name }).first()
const pane = (win, slot) => win.locator(`[data-pane="${slot}"]`)

/** 그 칸이 지금 누구의 대화를 비추고 있나. 칸 안의 대화 헤더 이름을 그대로 읽는다. */
async function paneWorkspace(win, slot) {
  const header = pane(win, slot).locator('.workspace-header')
  await header.waitFor()
  return ((await header.textContent()) ?? '').trim()
}

export default async function 관계_있는_두_개를_나란히_놓고_본다() {
  await withScratchRepo(
    { worktrees: [BASE, MID, TOP, OUTSIDER], seed: seedStackAndOutsider },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        // 1. 평범하게 한 층을 연다. 여기까지는 예전과 똑같이 칸이 하나뿐이어야 한다 —
        //    분할을 들이면서 기존 화면이 달라지지 않았다는 것이 이 기능의 전제다.
        await row(win, BASE).click()
        await win.locator('.workspace-header').waitFor()
        if ((await pane(win, 'main').count()) !== 0) {
          throw new Error('a single workspace should not render pane frames')
        }

        // 2. ⌘+클릭 — 같은 스택의 다른 층을 옆에 편다. 두 대화가 **동시에** 살아 있어야 한다.
        await row(win, MID).click({ modifiers: ['Meta'] })
        await pane(win, 'split').waitFor()
        const opened = [await paneWorkspace(win, 'main'), await paneWorkspace(win, 'split')]
        if (!opened[0].includes(BASE) || !opened[1].includes(MID)) {
          throw new Error(`panes should show ${BASE} | ${MID}, got ${JSON.stringify(opened)}`)
        }
        // 옆에 세우는 것이지 옮겨 가는 것이 아니다 — 왼쪽은 그대로 남아야 한다.
        if ((await pane(win, 'split').getAttribute('data-pane-focused')) !== 'true') {
          throw new Error('the newly opened pane should take focus')
        }
        if ((await pane(win, 'main').getAttribute('data-pane-focused')) !== null) {
          throw new Error('only one pane may be focused at a time')
        }
        console.log(`[e2e] split=${await wooi.shot('split-panes-open')}`)

        // 3. 분할 중 사이드바 클릭은 **포커스된 칸**만 갈아 끼운다. 이것이 "고르면 전체 화면을
        //    닫는다" 라는 기존 규칙의 유일한 예외다 — 아니면 클릭 한 번에 짝이 무너진다.
        await row(win, TOP).click()
        await pane(win, 'split').locator(`.workspace-header:has-text("${TOP}")`).waitFor()
        const swapped = [await paneWorkspace(win, 'main'), await paneWorkspace(win, 'split')]
        if (!swapped[0].includes(BASE) || !swapped[1].includes(TOP)) {
          throw new Error(
            `selecting should replace only the focused pane, got ${JSON.stringify(swapped)}`
          )
        }

        // 4. 왼쪽을 누르면 포커스가 넘어오고, 그 다음 선택은 왼쪽을 갈아 끼운다.
        await pane(win, 'main').click({ position: { x: 8, y: 200 } })
        if ((await pane(win, 'main').getAttribute('data-pane-focused')) !== 'true') {
          throw new Error('clicking inside a pane should give it focus')
        }
        console.log(`[e2e] focus=${await wooi.shot('split-panes-focus-moved')}`)

        // 5. 관계 없는 워크스페이스는 세우지 않는다 — 그리고 조용히 무시하지 않고 이유를 말한다.
        //    말없이 아무 일도 안 일어나면 ⌘+클릭이 고장 난 것으로 읽힌다.
        await dismissToasts(win)
        await row(win, OUTSIDER).click({ modifiers: ['Meta'] })
        await win
          .locator('[data-toast]')
          .getByText('Side by side is for two layers of the same stack', { exact: false })
          .waitFor()
        const refused = [await paneWorkspace(win, 'main'), await paneWorkspace(win, 'split')]
        if (!refused[0].includes(BASE) || !refused[1].includes(TOP)) {
          throw new Error(`a refused pairing must not disturb the panes, got ${refused}`)
        }
        console.log(`[e2e] refused=${await wooi.shot('split-panes-refused')}`)

        // 6. ⇧⌘W 로 포커스된 칸(지금은 왼쪽)을 닫으면 **남긴 칸**이 그 자리로 올라온다.
        //    닫은 쪽이 남으면 "닫았다" 는 말이 거짓이 된다.
        await dismissToasts(win)
        await win.keyboard.press('Meta+Shift+W')
        await pane(win, 'split').waitFor({ state: 'detached' })
        const remaining = ((await win.locator('.workspace-header').textContent()) ?? '').trim()
        if (!remaining.includes(TOP)) {
          throw new Error(`closing the focused pane should keep the other one, got ${remaining}`)
        }
        console.log(`[e2e] closed=${await wooi.shot('split-panes-closed')}`)

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
