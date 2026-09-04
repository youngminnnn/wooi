/* global console, process */

import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** 상한(200만 자)을 넘기는 한 줄짜리 번들. 줄 수로는 절대 못 잡는 모양이다. */
const MINIFIED_BUNDLE = `${'x'.repeat(2_100_000)}\n`

/**
 * 브랜치가 딱 이만큼 바뀐 상태를 만든다.
 *
 * - `src/app.ts` — base 에 이미 있고 **떨어진 두 곳**을 고친다 → hunk 2개(이동할 자리).
 * - `src/app.test.ts` — 테스트 몫 +10.
 * - `package-lock.json` — 생성 몫 +40.
 * - `public/app.min.js` — 생성 몫 +1 이지만 문자 수가 상한을 넘겨 렌더를 포기해야 한다.
 *
 * 그래서 화면에 나와야 할 숫자는 사람이 쓴 +2 −2 이고, 나머지 51 줄은 내역으로 빠진다.
 */
async function seedBranchChanges(scratch) {
  const repo = scratch.repoPath
  const worktree = scratch.worktrees['feature-test']

  // base(main)에 원본을 심는다 — 파일이 base 에 있어야 "수정" 이 되고 hunk 가 갈린다.
  await mkdir(join(repo, 'src'), { recursive: true })
  const original = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
  await writeFile(join(repo, 'src/app.ts'), `${original}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base: app.ts')

  // 워크트리를 base 까지 따라오게 한 뒤 그 위에서 고친다.
  git(worktree, 'merge', '-q', '--ff-only', 'main')
  const edited = original
    .replace('const line3 = 3', 'const line3 = 300')
    .replace('const line25 = 25', 'const line25 = 2500')
  await writeFile(join(worktree, 'src/app.ts'), `${edited}\n`)

  await mkdir(join(worktree, 'public'), { recursive: true })
  await writeFile(join(worktree, 'public/app.min.js'), MINIFIED_BUNDLE)
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'edits')

  // 추적하지 않은 신규 파일도 Changes 에 "추가됨" 으로 합쳐진다.
  await writeFile(
    join(worktree, 'package-lock.json'),
    `${Array.from({ length: 40 }, (_, i) => `  "dep-${i}": "1.0.0"`).join('\n')}\n`
  )
  await writeFile(
    join(worktree, 'src/app.test.ts'),
    `${Array.from({ length: 10 }, (_, i) => `test('case ${i}', () => {})`).join('\n')}\n`
  )

  return seedAppState(scratch)
}

/** 첫 hunk 헤더가 사는 스크롤 컨테이너의 scrollTop. 진짜 레이아웃이라야 나오는 값이다. */
function diffScrollTop(win) {
  return win.evaluate(() => {
    const header = globalThis.document.querySelector('div[class*="--diff-hunk"]')
    if (!header) return null
    let el = header.parentElement
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    return el ? el.scrollTop : null
  })
}

export default async function diff_리뷰_표면() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: seedBranchChanges },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // Changes 가 기본 탭이지만, 탭을 눌러 두면 다른 기본값에서도 스펙이 성립한다.
        await wooi.win.locator('.workpanel-tabs button[title="Changes"]').click()
        await wooi.win.locator('div[class*="--diff-hunk"]').first().waitFor()

        // ── 1. 대용량 diff 폴백 ───────────────────────────────────────────
        // 200만 자를 그리려 들면 렌더러가 언다. 대신 왜 안 보이는지를 숫자로 말해야 한다.
        const notice = wooi.win.getByText("This file's diff is too large to display safely.")
        await notice.waitFor()
        const card = wooi.win.locator('div', { has: notice }).last()
        const cardText = (await card.innerText()).replace(/\s+/g, ' ')
        for (const expected of [
          'Character count is over the safe display limit',
          '2,000,000 characters',
          '20,000 lines per side'
        ]) {
          if (!cardText.includes(expected)) {
            throw new Error(`large-diff card was missing ${expected}: ${cardText}`)
          }
        }
        // 본문은 한 글자도 그리지 않는다.
        const drewBundle = await wooi.win.evaluate(() =>
          globalThis.document.body.innerText.includes('x'.repeat(200))
        )
        if (drewBundle) throw new Error('the oversized patch was rendered instead of the card')

        // ── 2. 브랜치 총 변경 줄수 칩 ─────────────────────────────────────
        const chip = wooi.win.locator('[role="group"]').first()
        const shown = await chip.innerText()
        if (shown.replace(/\s+/g, '') !== '+2−2') {
          throw new Error(`chip showed churn instead of authored lines: ${JSON.stringify(shown)}`)
        }
        const label = await chip.getAttribute('aria-label')
        for (const expected of [
          'Source: 2 lines added, 2 lines deleted',
          'tests: 10 lines added, 0 lines deleted',
          'generated: 41 lines added, 0 lines deleted',
          'branch total: 53 lines added, 2 lines deleted'
        ]) {
          if (!label?.includes(expected)) {
            throw new Error(`chip label was missing ${expected}: ${JSON.stringify(label)}`)
          }
        }

        // 칩과 카드가 함께 잡히는 자리에서 한 장 남긴다 — 스크롤한 뒤 찍으면 둘 다 화면 밖이다.
        const topShot = await wooi.shot('diff-review-surface-top')

        // ── 3. 변경 지점 간 이동 ──────────────────────────────────────────
        const next = wooi.win.locator('[aria-label="Next change"]')
        const title = await next.getAttribute('title')
        // app.ts 2개 + package-lock 1개 + app.test.ts 1개. 상한에 걸린 파일은 세지 않는다.
        if (title !== 'Next change (F7) — 4 changes in view') {
          throw new Error(`unexpected change count: ${JSON.stringify(title)}`)
        }

        const before = await diffScrollTop(wooi.win)
        if (before === null) throw new Error('could not find the diff scroll container')
        // 마지막 덩어리까지 내려간다. 부드러운 스크롤이라 멈출 때까지 기다린다.
        for (let i = 0; i < 4; i++) {
          await next.click()
          await wooi.win.waitForTimeout(250)
        }
        await wooi.win.waitForTimeout(400)
        const after = await diffScrollTop(wooi.win)
        if (!(after > before)) {
          throw new Error(`next-change did not scroll the diff: ${before} -> ${after}`)
        }

        // ⇧F7 도 같은 배선을 쓴다. 덩어리 수만큼 되감으면 한 바퀴 돌아 제자리이므로 두 칸만 올라간다.
        for (let i = 0; i < 2; i++) {
          await wooi.win.keyboard.press('Shift+F7')
          await wooi.win.waitForTimeout(250)
        }
        await wooi.win.waitForTimeout(400)
        const rewound = await diffScrollTop(wooi.win)
        if (!(rewound < after)) {
          throw new Error(`Shift+F7 did not walk back up: ${after} -> ${rewound}`)
        }

        console.log(
          `[e2e] chip=${JSON.stringify(shown)} scroll=${before}->${after}->${rewound} ` +
            `screenshots=${topShot},${await wooi.shot('diff-review-surface')}`
        )
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
