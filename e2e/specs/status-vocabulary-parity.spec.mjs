/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const BASE = 'parity-base'
const RATE_LIMITED = 'rate-limited-ws'
const STACK_WAITING = 'stack-waiting-ws'

/**
 * 사이드바와 현황판이 **같은 상태를 같은 어휘로** 그리는지 본다.
 *
 * 왜 이 스펙이 있나: 상태 사다리가 두 벌 복제돼 있었고 길이가 달랐다. 사이드바는 11단,
 * 현황판은 5단이었고, 빠진 다섯 중에 rate limit 과 스택 대기가 있었다. 그래서 사용량 한도로
 * 멈춘 워크스페이스가 **모든 세션을 한눈에 훑으라고 만든 바로 그 화면에서만** 회색 idle 점으로
 * 보였다. 복제본은 지웠지만, 지웠다는 사실만으로는 다시 갈라지는 것을 막지 못한다.
 *
 * 그래서 개수를 센다 — 두 표면이 동시에 화면에 있으므로(사이드바는 왼쪽, 현황판은 본문)
 * 같은 aria-label 이 **정확히 두 번** 나와야 한다. 한 번만 나오면 한쪽이 그 단을 잃은 것이다.
 * `workspaceStatus.test.ts` 가 판단 함수의 우선순위를 잠근다면, 이 스펙은 두 화면이 실제로
 * 그 함수를 쓰는지를 잠근다 — 유닛 테스트로는 "현황판이 몰래 자기 사다리를 다시 만드는 것" 을
 * 볼 수 없다.
 *
 * 모델 턴은 돌리지 않는다. 두 상태 모두 정본이 Workspace 필드라 시드로 그대로 만들 수 있다.
 */
async function seedTwoStates(scratch) {
  const seeded = await seedAppState(scratch, { workspaceName: BASE })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const base = state.workspaces[0]
  const now = Date.now()

  // 형제는 시드된 워크스페이스를 템플릿으로 만든다 — Workspace 필수 필드가 늘어도 따라간다.
  const sibling = (name, over) => ({
    ...base,
    id: `ws-${name}`,
    name,
    displayName: null,
    branch: name,
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    worktreePath: scratch.worktrees[name],
    status: 'idle',
    ...over
  })

  state.workspaces.push(
    // resetsAt 이 지나면 activeRateLimitPause 가 걸러 버린다 — 스펙이 도는 동안 유효하도록 넉넉히.
    sibling(RATE_LIMITED, {
      rateLimited: { backend: 'claude', detectedAt: now - 60_000, resetsAt: now + 60 * 60_000 }
    }),
    sibling(STACK_WAITING, {
      awaitingStackedWork: {
        targets: [{ workspaceId: base.id, seenReportAt: null }],
        until: 'all-reported',
        startedAt: now - 60_000,
        deadlineAt: now + 60 * 60_000,
        sessionId: null
      }
    })
  )

  await writeFile(file, JSON.stringify(state, null, 2))
  return seeded
}

export default async function 사이드바와_현황판이_같은_상태를_같은_어휘로_그린다() {
  await withScratchRepo(
    { worktrees: [BASE, RATE_LIMITED, STACK_WAITING], seed: seedTwoStates },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        // 워크스페이스를 고르지 않은 상태가 현황판이다 — 시드 직후가 그 상태다.
        // 사이드바는 그 옆에 계속 있으므로 두 표면이 한 화면에 함께 있다.
        await win.locator('[aria-label="Open the overview in a separate window"]').waitFor()

        for (const [aria, label] of [
          ['Paused by usage limit', 'Rate limited'],
          ['Waiting for stacked work', 'Waiting on stack']
        ]) {
          const marks = win.locator(`[aria-label="${aria}"]`)
          await marks.first().waitFor()
          const count = await marks.count()
          if (count !== 2) {
            throw new Error(
              `"${aria}" 는 사이드바와 현황판에 각각 한 번씩, 정확히 두 번 나와야 한다 — ${count} 번 나왔다. ` +
                '한 번이면 한쪽 표면이 이 단을 잃은 것이다(현황판이 5단으로 되돌아간 회귀).'
            )
          }
          // 아이콘만으로는 부족하다 — 현황판 카드는 상태를 글자로도 적는다.
          await win.getByText(label, { exact: true }).first().waitFor()
        }

        // 예전에는 여기에 enum 이 날것으로 찍혔다(`idle`·`error`). 사람이 읽는 라벨이어야 한다.
        const board = await win.locator('main, body').first().innerText()
        for (const raw of ['\nidle\n', '\nrunning\n', '\nerror\n']) {
          if (board.includes(raw)) {
            throw new Error(
              `현황판이 상태 enum 을 날것으로 찍고 있다: ${JSON.stringify(raw.trim())}. ` +
                'describeWorkspaceStatus 의 label 을 써야 한다.'
            )
          }
        }

        console.log(`[e2e] screenshot=${await wooi.shot('status-vocabulary-parity')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
