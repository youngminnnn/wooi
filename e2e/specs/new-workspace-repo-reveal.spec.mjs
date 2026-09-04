/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

async function seedLongSidebar(scratch) {
  await seedAppState(scratch)
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const template = state.workspaces[0]

  // 리포 헤더가 실제로 스크롤 밖으로 나갈 만큼 행을 만든다. 이 스펙은 렌더러의 목록 동작만
  // 검증하므로 각 행은 같은 격리된 워크트리를 안전하게 공유해도 된다.
  state.workspaces = Array.from({ length: 36 }, (_, index) => ({
    ...template,
    id: `ws-e2e-${index}`,
    name: `feature-${index}`,
    displayName: `Sidebar workspace ${String(index).padStart(2, '0')}`,
    branch: `feature-${index}`,
    createdAt: template.createdAt + index,
    lastActiveAt: template.lastActiveAt + index
  }))
  await writeFile(file, JSON.stringify(state, null, 2))
}

async function sidebarVisibility(locator) {
  return locator.evaluate((element) => {
    const sidebar = element.closest('[data-tour="workspaces"]')
    if (!sidebar) return { visible: false, reason: 'sidebar not found' }
    const itemRect = element.getBoundingClientRect()
    const sidebarRect = sidebar.getBoundingClientRect()
    return {
      visible: itemRect.top >= sidebarRect.top && itemRect.bottom <= sidebarRect.bottom,
      itemTop: itemRect.top,
      itemBottom: itemRect.bottom,
      sidebarTop: sidebarRect.top,
      sidebarBottom: sidebarRect.bottom,
      scrollTop: sidebar.scrollTop
    }
  })
}

export default async function 새_워크스페이스_단축키가_대상_리포를_드러낸다() {
  await withScratchRepo({ worktrees: ['feature-test'], seed: seedLongSidebar }, async (scratch) => {
    const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
    const { win } = wooi
    try {
      const sidebar = win.locator('[data-tour="workspaces"]')
      const repoName = win.getByText('e2e-repo', { exact: true }).first()
      const repoHeader = repoName.locator('..')

      // 사용자가 아래쪽 워크스페이스를 보고 있어 리포 헤더가 보이지 않는 상황을 만든다.
      await sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      if ((await sidebarVisibility(repoHeader)).visible) {
        throw new Error('precondition failed: repository header should start outside the viewport')
      }

      // ⇧⌘N은 대상 헤더를 먼저 노출하고, 새 좌표에서 메뉴를 열어 어느 리포인지 밝혀야 한다.
      await win.keyboard.press('Meta+Shift+N')
      await win.getByText('New workspace in e2e-repo', { exact: true }).waitFor()
      const visibility = await sidebarVisibility(repoHeader)
      if (!visibility.visible) {
        throw new Error(
          `repository header was not revealed before the menu opened: ${JSON.stringify(visibility)}`
        )
      }
      const headerClass = await repoHeader.getAttribute('class')
      if (!headerClass?.includes('ring-[var(--info-500)]/60')) {
        throw new Error(`repository header was not highlighted: ${JSON.stringify(headerClass)}`)
      }

      console.log(`[e2e] screenshot=${await wooi.shot('new-workspace-repo-reveal')}`)
      await waitForInspection(win)
    } finally {
      await wooi.close()
    }
  })
}
