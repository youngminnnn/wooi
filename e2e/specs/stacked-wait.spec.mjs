/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_WORKSPACE_DISPLAY_NAME, seedAppState, waitForInspection } from '../fixtures.mjs'

const PARENT = 'parent-e2e'
const CHILDREN = ['child-one', 'child-two']
const WAIT_MINUTES = 60

/**
 * 부모가 `await_stacked_work` 로 대기를 걸어 둔 상태를 시드하고, 사용자가 보는 두 자리
 * (사이드바 표시 · 대화 상단 배너)와 **취소가 실제로 먹히는지**까지 확인한다.
 *
 * 모델 턴은 돌리지 않는다. 예약의 정본이 Workspace 필드라 대기 상태는 시드로 그대로 만들 수 있고,
 * 이 스펙이 묻는 것은 "그 상태가 화면에 보이고 사용자가 빠져나올 수 있는가" 하나다.
 */
async function seedWaitingParent(scratch) {
  const seeded = await seedAppState(scratch, { workspaceName: PARENT })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const parent = state.workspaces[0]

  // 자식은 부모를 템플릿으로 만든다 — Workspace 필수 필드가 늘어도 시드가 같이 따라간다.
  state.workspaces.push(
    ...CHILDREN.map((name, i) => ({
      ...parent,
      id: `ws-${name}`,
      name,
      displayName: null,
      branch: name,
      baseBranch: parent.branch,
      parentWorkspaceId: parent.id,
      createdByWorkspaceId: parent.id,
      worktreePath: scratch.worktrees[name],
      // 하나는 아직 돌고 하나는 유휴 — 정지 판정이 "하나라도 진행 가능하면 아니다" 이므로
      // 이 조합이면 스펙이 도는 동안 예약이 저절로 풀리지 않는다.
      status: i === 0 ? 'running' : 'idle',
      sessionId: null,
      awaitingStackedWork: null
    }))
  )
  parent.awaitingStackedWork = {
    targets: CHILDREN.map((name) => ({ workspaceId: `ws-${name}`, seenReportAt: null })),
    until: 'all-reported',
    startedAt: Date.now(),
    deadlineAt: Date.now() + WAIT_MINUTES * 60_000,
    sessionId: parent.sessionId
  }
  await writeFile(file, JSON.stringify(state, null, 2))
  return seeded
}

export default async function 스택_대기가_화면에_보이고_사용자가_취소할_수_있다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )
  await withScratchRepo(
    { worktrees: [PARENT, ...CHILDREN], seed: seedWaitingParent },
    async (scratch) => {
      // 기본 스크래치 루트는 실행이 끝나면 통째로 지워져 PNG 도 함께 사라진다. 사람이 눈으로
      // 확인해야 할 때만 WOOI_E2E_SHOTS 로 살아남는 경로를 준다.
      const wooi = await launchWooi({
        appDir: process.cwd(),
        ...scratch,
        ...(process.env.WOOI_E2E_SHOTS ? { shotsPath: process.env.WOOI_E2E_SHOTS } : {})
      })
      const { win } = wooi
      try {
        // 1. 사이드바 — 기다리는 중임이 표시된다. 아무 표시가 없으면 사용자는 죽은 줄 안다.
        await win.locator('[aria-label="Waiting for stacked work"]').first().waitFor()
        await win
          .getByText(/waiting on 2/)
          .first()
          .waitFor()

        // 2. 대화 상단 배너 — 무엇을 기다리는지와 빠져나갈 버튼.
        await win.locator(`[title="${E2E_WORKSPACE_DISPLAY_NAME}"]`).last().click()
        await win.locator('.workspace-header').waitFor()
        const banner = win.getByText(/Waiting for all of/)
        await banner.waitFor()
        const stop = win.getByRole('button', { name: 'Stop waiting' })
        await stop.waitFor()
        console.log(`[e2e] banner=${(await banner.textContent())?.trim()}`)
        console.log(`[e2e] before=${await wooi.shot('stacked-wait-waiting')}`)

        // 3. 취소가 실제로 먹히는가 — 불변식 4 의 사용자 쪽 절반이다.
        await stop.click()
        await banner.waitFor({ state: 'detached' })
        const after = await win.evaluate(() => globalThis.api.getState())
        const parent = after.workspaces.find((w) => w.id === 'ws-e2e')
        if (parent.awaitingStackedWork) {
          throw new Error('Stop waiting left the reservation in place')
        }
        if (await win.locator('[aria-label="Waiting for stacked work"]').count()) {
          throw new Error('sidebar still shows the waiting state after cancelling')
        }
        console.log(`[e2e] after=${await wooi.shot('stacked-wait-cancelled')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
