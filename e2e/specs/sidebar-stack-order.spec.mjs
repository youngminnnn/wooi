/* global console, document, process, window */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const ROOT_A = 'stack-alpha'
const CHILD_A = 'stack-alpha-child'
const ROOT_B = 'stack-beta'
const CHILD_B = 'stack-beta-child'

async function seedSidebarStacks(scratch) {
  await seedAppState(scratch, { workspaceName: ROOT_A })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const template = state.workspaces[0]
  template.displayName = null

  const make = (name, parentWorkspaceId = null) => ({
    ...template,
    id: `ws-${name}`,
    name,
    displayName: null,
    branch: name,
    baseBranch: parentWorkspaceId ? ROOT_A : 'main',
    parentWorkspaceId,
    createdByWorkspaceId: parentWorkspaceId,
    worktreePath: scratch.worktrees[name],
    sessionId: null
  })

  state.workspaces = [
    template,
    make(CHILD_A, template.id),
    make(ROOT_B),
    make(CHILD_B, `ws-${ROOT_B}`)
  ]
  // beta 자식의 실제 base 는 beta 부모다.
  state.workspaces[3].baseBranch = ROOT_B
  await writeFile(file, JSON.stringify(state, null, 2))
}

function row(win, name) {
  return win.locator('[role="button"]').filter({ hasText: name }).first()
}

async function visibleWorkspaceOrder(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[role="button"]')]
      .map((element) => element.textContent ?? '')
      .filter((text) =>
        ['stack-alpha', 'stack-alpha-child', 'stack-beta', 'stack-beta-child'].some((name) =>
          text.includes(name)
        )
      )
      .map((text) =>
        ['stack-alpha-child', 'stack-beta-child', 'stack-alpha', 'stack-beta'].find((name) =>
          text.includes(name)
        )
      )
      .filter(Boolean)
  )
}

export default async function 사이드바가_stack_단위로_고정되고_드래그된다() {
  await withScratchRepo(
    {
      worktrees: [ROOT_A, CHILD_A, ROOT_B, CHILD_B],
      seed: seedSidebarStacks
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        // 1. 새 설정의 기본값은 켜짐이다. 저장 파일에 키가 없어도 main 기본값 병합으로 채워진다.
        const initial = await win.evaluate(() => window.api.getState())
        if (initial.settings.autoSortWorkspacesByActivity !== true) {
          throw new Error('recently active workspace sorting should default to enabled')
        }

        // 2. 자식 행에서 고정해도 stack 뿌리에 저장되고, 부모 행에 핀 표시가 나타난다.
        await row(win, CHILD_B).click({ button: 'right' })
        await win.getByRole('menuitem', { name: 'Pin stack to top' }).click()
        await row(win, ROOT_B).locator('[aria-label="Pinned to top"]').waitFor()
        const pinned = await win.evaluate(() => window.api.getState())
        const beta = pinned.workspaces.find((workspace) => workspace.id === `ws-${ROOT_B}`)
        const betaChild = pinned.workspaces.find((workspace) => workspace.id === `ws-${CHILD_B}`)
        if (!beta?.sidebarPinned || betaChild?.sidebarPinned) {
          throw new Error('pin should be stored only on the stack root')
        }

        // 3. 같은 자식 행에서 해제할 수 있다. 그래야 자동 정렬 영역 안에서 다시 드래그할 수 있다.
        await row(win, CHILD_B).click({ button: 'right' })
        await win.getByRole('menuitem', { name: 'Unpin stack from top' }).click()
        await row(win, ROOT_B)
          .locator('[aria-label="Pinned to top"]')
          .waitFor({ state: 'detached' })

        // 4. beta의 자식을 alpha의 자식 앞으로 끌면, 자식만 떨어지지 않고 beta stack 전체가 간다.
        await row(win, CHILD_B).dragTo(row(win, CHILD_A), {
          targetPosition: { x: 30, y: 2 }
        })
        await win.waitForFunction(
          () => {
            const state = document.body.innerText
            return state.includes('stack-alpha') && state.includes('stack-beta')
          },
          undefined,
          { timeout: 5000 }
        )
        const order = await visibleWorkspaceOrder(win)
        const expected = [ROOT_B, CHILD_B, ROOT_A, CHILD_A]
        if (JSON.stringify(order) !== JSON.stringify(expected)) {
          throw new Error(`dragging a child should move its whole stack: ${JSON.stringify(order)}`)
        }

        const persisted = await win.evaluate(() => window.api.getState())
        const roots = persisted.workspaces
          .filter((workspace) => workspace.parentWorkspaceId === null)
          .map((workspace) => workspace.name)
        if (JSON.stringify(roots) !== JSON.stringify([ROOT_B, ROOT_A])) {
          throw new Error(`main did not persist the dragged stack order: ${JSON.stringify(roots)}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('sidebar-stack-order')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
