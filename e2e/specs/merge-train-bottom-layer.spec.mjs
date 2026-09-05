/* global console, process, window */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  dismissToasts,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const BOTTOM = 'bottom-e2e'
const TOP = 'top-e2e'

/**
 * 두 층짜리 스택에서 **아래 층** 워크스페이스에 머지 트레인을 건다.
 *
 * 이 자리가 예전에는 "A merge train needs at least two layers." 로 막혀 있었다. 트레인이 훑는
 * 범위는 "스택 뿌리 → 지금 워크스페이스" 라 최하단은 언제나 1층이 되는데, 1층 트레인에도 할 일이
 * 있다 — 그 PR 을 머지하고 위층 전부를 새 base 로 밀어 올린다.
 *
 * 그리고 그 트레인이 CI 를 기다리는 동안 무엇이 보이는지까지 본다. 기다림은 트레인의 일이므로
 * 창을 닫아도 계속 돌아야 하고, 사용자는 그 사실을 알 수 있어야 하며, 멈출 수 있어야 한다.
 */

/** 앱이 부르는 `gh` 를 대본으로 갈아 끼운다. 로그인 셸이 프로필에서 PATH 를 다시 세우므로
 *  ZDOTDIR 의 `.zlogin`(가장 마지막에 읽힌다)에서 덧쓴다. HOME 은 건드리지 않는다 —
 *  백엔드 감지가 로그인 셸의 `command -v claude|codex` 에 의존한다. */
async function installGhStub(root, prs) {
  const binDir = join(root, 'stub-bin')
  const zdotdir = join(root, 'zdotdir')
  const statePath = join(root, 'gh-state.json')
  await mkdir(binDir, { recursive: true })
  await mkdir(zdotdir, { recursive: true })
  await writeFile(statePath, JSON.stringify({ prs }, null, 2))

  const stub = resolve('e2e/stubs/gh.mjs')
  await writeFile(join(binDir, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`)
  await chmod(join(binDir, 'gh'), 0o755)

  for (const [file, extra] of [
    ['.zshenv', ''],
    ['.zprofile', ''],
    ['.zlogin', `export PATH="${binDir}:$PATH"\n`]
  ]) {
    await writeFile(join(zdotdir, file), `[ -f "$HOME/${file}" ] && . "$HOME/${file}"\n${extra}`)
  }
  return { statePath, env: { ZDOTDIR: zdotdir, WOOI_E2E_GH_STATE: statePath } }
}

function prRecord({ number, head, base, checks }) {
  return {
    number,
    url: `https://github.test/pr/${number}`,
    title: `PR ${number}`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: checks === 'pending' ? 'BLOCKED' : 'CLEAN',
    headRefName: head,
    baseRefName: base,
    headRefOid: `${'a'.repeat(39)}${number}`,
    statusCheckRollup:
      checks === 'pending'
        ? [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null }]
        : [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]
  }
}

async function seedStack(scratch) {
  const seeded = await seedAppState(scratch, { workspaceName: BOTTOM })
  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const bottom = state.workspaces[0]
  bottom.prNumber = 1
  state.workspaces.push({
    ...bottom,
    id: `ws-${TOP}`,
    name: TOP,
    displayName: null,
    branch: TOP,
    baseBranch: BOTTOM,
    parentWorkspaceId: bottom.id,
    createdByWorkspaceId: bottom.id,
    prNumber: 2,
    worktreePath: scratch.worktrees[TOP],
    status: 'idle',
    sessionId: null
  })
  await writeFile(file, JSON.stringify(state, null, 2))
  return seeded
}

export default async function 최하단에서_건_머지_트레인이_CI_를_기다린다() {
  await withScratchRepo({ worktrees: [BOTTOM, TOP], seed: seedStack }, async (scratch) => {
    // 아래 층 PR 은 CI 가 도는 중이다 — 예전에는 계획 단계에서 바로 막혔고, 실행은 즉시 멈췄다.
    const gh = await installGhStub(scratch.root, [
      prRecord({ number: 1, head: BOTTOM, base: 'main', checks: 'pending' }),
      prRecord({ number: 2, head: TOP, base: BOTTOM, checks: 'pending' })
    ])
    const wooi = await launchWooi({ appDir: process.cwd(), ...scratch, env: gh.env })
    const { win } = wooi
    try {
      // 헤더 칩은 좁은 폭에서 접힌다 — 스택 칩을 눌러야 하므로 넉넉히 벌려 둔다.
      await win.setViewportSize({ width: 1600, height: 1000 })

      // 1. 게이트. 최하단(1층)에서도 계획이 선다.
      const plan = await win.evaluate(() => window.api.stack.trainPlan('ws-e2e'))
      console.log(`[e2e] bottom plan=${JSON.stringify(plan)}`)
      if (plan.error) throw new Error(`bottom-layer plan was refused: ${plan.error}`)
      if (plan.layers.length !== 1) {
        throw new Error(`bottom layer should plan exactly itself, got ${plan.layers.length}`)
      }
      if (plan.mergeableCount !== 1) {
        throw new Error(
          `checks-pending layer should still be mergeable, got ${plan.mergeableCount}`
        )
      }

      // 2. 그 계획을 사용자가 보는 화면으로 연다.
      await openSeededWorkspace(win)
      await dismissToasts(win)
      const stackChip = win.locator('button[title^="Stacked PRs in this stack"]')
      await stackChip.first().waitFor({ timeout: 20000 })
      await stackChip.first().click()
      const mergeStack = win.getByRole('menuitem', { name: 'Merge stack' })
      await mergeStack.waitFor({ timeout: 15000 })
      await mergeStack.click()
      await win.getByText('The train will wait.').first().waitFor({ timeout: 15000 })
      console.log(`[e2e] plan=${await wooi.shot('merge-train-plan-bottom-layer')}`)

      // 3. 실행. CI 가 도는 동안 트레인은 기다린다.
      await win.getByRole('button', { name: 'Start merge train' }).click()
      await win.getByText('Checks are still running.').first().waitFor({ timeout: 20000 })
      const cancel = win.getByRole('button', { name: 'Cancel merge train' })
      await cancel.waitFor()
      if (await win.getByText('Merge train in progress').count()) {
        throw new Error('the dead "Merge train in progress" button is still there')
      }
      if (!(await cancel.isEnabled())) throw new Error('cancel button should be clickable')
      console.log(`[e2e] waiting=${await wooi.shot('merge-train-waiting-for-checks')}`)

      // 4. 닫아도 계속 돈다. 그 사실이 타이틀바와 사이드바에 남는다.
      await win.getByRole('button', { name: 'Run in background' }).click()
      const chip = win.locator('button[title^="Merge train running"]')
      await chip.waitFor({ timeout: 10000 })
      await win.getByTitle('A merge train is running from this workspace').first().waitFor()
      console.log(`[e2e] background=${await wooi.shot('merge-train-running-in-background')}`)

      // 5. 다시 열면 계획이 아니라 진행 화면으로 돌아온다. 거기서 멈출 수 있다.
      await chip.click()
      await stackChip.first().click()
      await win.getByRole('menuitem', { name: 'Merge stack' }).click()
      await win.getByRole('button', { name: 'Cancel merge train' }).click()
      // exact — 같은 문장이 결과 화면·토스트·라이브 리전 세 곳에 동시에 뜬다.
      await win.getByText('Merge train canceled.', { exact: true }).waitFor({ timeout: 20000 })
      console.log(`[e2e] canceled=${await wooi.shot('merge-train-canceled')}`)

      // 취소를 "complete" 라고 적으면 사용자는 다 됐다고 읽는다.
      await win.getByText('Merge train canceled', { exact: true }).first().waitFor()

      const after = JSON.parse(await readFile(gh.statePath, 'utf8'))
      if (after.prs.some((pr) => pr.state === 'MERGED')) {
        throw new Error('the train must not merge while checks are pending')
      }
      await waitForInspection(win)
    } finally {
      await wooi.close()
    }
  })
}
