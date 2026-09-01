/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const PARENT = 'parent-e2e'
const CHILD = 'child-e2e'

/**
 * 두 층짜리 모델 A 스택을 시드하되, **위 층의 base 를 일부러 어긋나게** 둔다.
 *
 * 스택 화면이 존재하는 이유가 이것이다 — 사이드바 들여쓰기는 "자식이다" 라고만 말하고,
 * 그 자식이 정작 `main` 위에 서 있어 아래 층 변경을 제 diff 로 삼키는 중이라는 것은 말해 주지
 * 않는다. 그래서 부모-자식 링크(`parentWorkspaceId`)는 맞게 두고 `baseBranch` 만 틀리게 만든다.
 */
async function seedDriftedStack(scratch) {
  const seeded = await seedAppState(scratch, { workspaceName: PARENT })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const parent = state.workspaces[0]

  // 자식은 부모를 템플릿으로 만든다 — Workspace 필수 필드가 늘어도 시드가 같이 따라간다.
  state.workspaces.push({
    ...parent,
    id: `ws-${CHILD}`,
    name: CHILD,
    displayName: null,
    branch: CHILD,
    // 부모 위에 쌓였다고 기록돼 있지만 base 는 main 이다. 이것이 화면이 잡아내야 할 어긋남이다.
    baseBranch: 'main',
    parentWorkspaceId: parent.id,
    createdByWorkspaceId: parent.id,
    worktreePath: scratch.worktrees[CHILD],
    status: 'idle',
    sessionId: null
  })
  await writeFile(file, JSON.stringify(state, null, 2))
  return seeded
}

export default async function 스택_화면이_층과_base_어긋남을_한_눈에_보여_준다() {
  await withScratchRepo({ worktrees: [PARENT, CHILD], seed: seedDriftedStack }, async (scratch) => {
    const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
    const { win } = wooi
    try {
      // 1. 진입점은 **아래 층이 있는 행에만** 붙는다. 꼭대기 층에도 뜨면 펼칠 것 없는 지도를
      //    여는 버튼이 생긴다.
      const entry = win.locator('[aria-label="Show this stack"]')
      await entry.first().waitFor()
      const entryCount = await entry.count()
      if (entryCount !== 1) {
        throw new Error(
          `stack entry point should exist only on the parent row, found ${entryCount}`
        )
      }

      await entry.first().click()

      // 2. 스택 전체가 한 화면에 바닥부터 펼쳐진다.
      const layers = win.locator('[data-stack-layer]')
      await layers.first().waitFor()
      await win.getByText('Layer 1 of 2').waitFor()
      await win.getByText('Layer 2 of 2').waitFor()
      const order = await layers.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-stack-layer'))
      )
      if (order.length !== 2 || order[0] !== 'ws-e2e') {
        throw new Error(`layers should be listed bottom first, got ${JSON.stringify(order)}`)
      }

      // 3. 어긋남이 층과 머리글 양쪽에 뜬다 — 층은 "어디가", 머리글은 "몇 개가" 를 답한다.
      // exact — 머리글의 "1 base drifted" 요약과 층의 "Base drifted" 칩을 갈라 놓는다.
      const drift = win.getByText('Base drifted', { exact: true })
      await drift.waitFor()
      const summary = win.locator('[title="Layers whose base is not the layer below them"]')
      await summary.waitFor()
      const summaryText = (await summary.textContent())?.trim()
      if (summaryText !== '1 base drifted') {
        throw new Error(`stack summary did not count the drift: ${JSON.stringify(summaryText)}`)
      }
      console.log(`[e2e] summary=${summaryText}`)

      // 4. 층별 읽기가 실제로 끝난다. 스피너가 남아 있으면 지도는 영영 절반만 그려진 채다 —
      //    스크래치 리포의 층에는 커밋이 없으므로 그렇게 말하는 자리까지 도달해야 한다.
      await win.getByText('Reading this layer…').first().waitFor({ state: 'detached' })
      const emptyLayers = await win.getByText('No commits in this layer.').count()
      if (emptyLayers !== 2) {
        throw new Error(`both layers should report their commits, got ${emptyLayers}`)
      }
      console.log(`[e2e] open=${await wooi.shot('stack-view-drift')}`)

      // 5. 닫으면 원래 보던 자리로 돌아온다(전체 화면 축이므로 대화가 다시 나타난다).
      await win.locator('[aria-label="Close the stack view"]').click()
      await layers.first().waitFor({ state: 'detached' })
      console.log(`[e2e] closed=${await wooi.shot('stack-view-closed')}`)
      await waitForInspection(win)
    } finally {
      await wooi.close()
    }
  })
}
