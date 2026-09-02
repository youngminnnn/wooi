/* global console, process */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const KEPT = 'const line25 = 250'
const DISCARDED = 'const line3 = 30'

/**
 * 에이전트가 한 커밋 안에서 파일 양끝을 고친 상태를 만든다 — hunk 가 둘로 갈라지도록 멀찍이.
 *
 * 커밋까지 해 두는 것이 핵심이다. 버리기의 약속은 "워킹 트리만 되돌리고 이력은 그대로"인데,
 * 미커밋 변경만으로 재면 그 약속의 절반(커밋을 건드리지 않는다)이 아예 시험되지 않는다.
 */
async function seedTwoHunks(scratch) {
  const repo = scratch.repoPath
  const worktree = scratch.worktrees['feature-test']

  await mkdir(join(repo, 'src'), { recursive: true })
  const original = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
  await writeFile(join(repo, 'src/app.ts'), `${original}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base: app.ts')

  git(worktree, 'merge', '-q', '--ff-only', 'main')
  const edited = original.replace('const line3 = 3', DISCARDED).replace('const line25 = 25', KEPT)
  await writeFile(join(worktree, 'src/app.ts'), `${edited}\n`)
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'agent: touch both ends of app.ts')

  return seedAppState(scratch)
}

/**
 * hunk 하나를 그 자리에서 버린다.
 *
 * 유닛 테스트는 patch 조립을, `diffPatch.apply.test.ts` 는 그 patch 를 받은 git 의 행동을 잰다.
 * 여기서만 잴 수 있는 것은 그 둘 사이 — **화면에서 누른 버튼이 디스크의 파일까지 닿는지**, 그리고
 * 되돌린 뒤 diff 가 스스로 다시 떠서 방금 지운 줄을 더는 보여 주지 않는지다. 그 경로가 끊기면
 * 사용자는 지워지지 않은 줄 앞에서 버튼을 한 번 더 누르게 된다.
 */
export default async function hunk_를_그_자리에서_버린다() {
  await withScratchRepo({ worktrees: ['feature-test'], seed: seedTwoHunks }, async (scratch) => {
    const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
    const win = wooi.win
    const worktree = scratch.worktrees['feature-test']
    const filePath = join(worktree, 'src/app.ts')

    try {
      await openSeededWorkspace(win)
      await win.locator('.workpanel-tabs button[title="Changes"]').click()
      await win.locator('[data-diff-file="src/app.ts"]').waitFor()

      // 출발점: 두 hunk 가 다 떠 있다.
      await win.getByText(DISCARDED, { exact: true }).waitFor()
      await win.getByText(KEPT, { exact: true }).waitFor()

      const buttons = win.getByLabel('Discard this hunk in src/app.ts')
      const hunkCount = await buttons.count()
      if (hunkCount !== 2) {
        throw new Error(`expected one discard button per hunk, saw ${hunkCount}`)
      }

      // ── 1. 되돌리기는 확인을 거친다 ───────────────────────────────────
      await buttons.first().click()
      await win.getByText('Discard this change in src/app.ts?').waitFor()
      // "다시 묻지 않기" 체계에 편입돼 있어야 한다 — 없으면 Settings 에서 되켤 자리도 없다.
      await win.getByLabel("Don't ask again").waitFor()

      const beforeDiscard = await readFile(filePath, 'utf8')
      if (!beforeDiscard.includes(DISCARDED)) {
        throw new Error('the seeded edit was not on disk before discarding')
      }

      // ── 2. 승인하면 디스크의 파일이 실제로 되돌아간다 ──────────────────
      await win.getByRole('button', { name: 'Discard', exact: true }).click()

      // 화면이 스스로 따라와야 한다. 사라지기를 기다리는 것이 곧 그 단언이다.
      await win.getByText(DISCARDED, { exact: true }).waitFor({ state: 'detached' })
      await win.getByText(KEPT, { exact: true }).waitFor()

      const afterDiscard = await readFile(filePath, 'utf8')
      if (afterDiscard.includes(DISCARDED)) {
        throw new Error('the diff refreshed but the file on disk still has the discarded line')
      }
      if (!afterDiscard.includes('const line3 = 3\n')) {
        throw new Error('the discarded hunk did not go back to the original line')
      }
      // 고르지 않은 hunk 는 살아 있어야 한다 — 여기가 무너지면 "hunk 단위"가 거짓말이 된다.
      if (!afterDiscard.includes(KEPT)) {
        throw new Error('discarding one hunk also reverted the other one')
      }

      // ── 3. 이력은 그대로다 ────────────────────────────────────────────
      const head = git(worktree, 'log', '--oneline', '-1')
      if (!head.includes('touch both ends')) {
        throw new Error(`discarding rewrote history: ${head}`)
      }
      const status = git(worktree, 'status', '--porcelain')
      if (!status.includes('src/app.ts')) {
        throw new Error(`the revert was not left as an uncommitted change: ${status || '(clean)'}`)
      }

      // 남은 hunk 의 버튼은 그대로 있다 — 리뷰는 계속된다.
      const left = await buttons.count()
      if (left !== 1) throw new Error(`expected one hunk left to discard, saw ${left}`)

      console.log(
        `[e2e] hunks=2->1 head=${JSON.stringify(head)} screenshot=${await wooi.shot('diff-hunk-discard')}`
      )
      await waitForInspection(win)
    } finally {
      await wooi.close()
    }
  })
}
