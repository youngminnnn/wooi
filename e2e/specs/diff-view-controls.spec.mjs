/* global console, process */

import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** 랩 여부를 눈이 아니라 레이아웃으로 판정하기 위한 표적. 접히지 않으면 화면 밖으로 나간다. */
const PROBE = `WRAP_PROBE_${'w'.repeat(400)}`

/**
 * 스택 한 층 위에 얹힌 워크스페이스를 만든다 — 비교 기준 토글은 선택지가 둘일 때만 뜬다.
 *
 * - `main` — `src/app.ts` 원본.
 * - `feature-parent` — 그 위에 `src/parent-only.ts` 를 더한다. 이 워크스페이스의 base 다.
 * - `feature-test` — 부모를 따라온 뒤 `src/app.ts` 를 전부 고치고 `src/deep/nested/util.ts` 를 더한다.
 *
 * 그래서 base 를 부모에서 기본 브랜치로 바꾸면 `parent-only.ts` 가 목록에 **나타난다**. 라벨
 * 문구가 아니라 그 차이로 "정말 다른 기준으로 다시 떴는지" 를 본다.
 */
async function seedStackedBranch(scratch) {
  const repo = scratch.repoPath
  const parent = scratch.worktrees['feature-parent']
  const worktree = scratch.worktrees['feature-test']

  await mkdir(join(repo, 'src'), { recursive: true })
  const original = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
  await writeFile(join(repo, 'src/app.ts'), `${original}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base: app.ts')

  // 부모 층: 기본 브랜치에는 없는 커밋 하나.
  git(parent, 'merge', '-q', '--ff-only', 'main')
  await writeFile(join(parent, 'src/parent-only.ts'), 'export const fromParent = true\n')
  git(parent, 'add', '-A')
  git(parent, 'commit', '-qm', 'parent: only on the parent layer')

  // 이 워크스페이스: 부모 위에 쌓는다.
  git(worktree, 'merge', '-q', '--ff-only', 'feature-parent')
  const edited = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${(i + 1) * 10}`).join(
    '\n'
  )
  await writeFile(join(worktree, 'src/app.ts'), `${edited}\nconst probe = '${PROBE}'\n`)
  await mkdir(join(worktree, 'src/deep/nested'), { recursive: true })
  await writeFile(join(worktree, 'src/deep/nested/util.ts'), 'export const util = 1\n')
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'edits')

  return seedAppState(scratch, {
    workspaceName: 'feature-test',
    workspace: { baseBranch: 'feature-parent' }
  })
}

/** 변경 파일 목록(파일 블록에 달린 표적으로 읽는다 — 트리와 같은 경로 문자열이다). */
function changedFiles(win) {
  return win.evaluate(() =>
    [...globalThis.document.querySelectorAll('[data-diff-file]')].map((el) =>
      el.getAttribute('data-diff-file')
    )
  )
}

/**
 * 긴 줄이 실제로 접혔는지를 계산된 스타일과 진짜 스크롤 폭으로 읽는다.
 * jsdom 은 레이아웃을 계산하지 않으므로 이 판정은 e2e 만 할 수 있다.
 */
function wrapProbe(win) {
  return win.evaluate(() => {
    const block = globalThis.document.querySelector('[data-diff-file="src/app.ts"]')
    if (!block) return null
    const span = [...block.querySelectorAll('span')].find((el) =>
      el.textContent?.includes('WRAP_PROBE')
    )
    if (!span) return null
    const scrollsSideways = !!globalThis.__wooiHScroller(span, block)
    return {
      whiteSpace: globalThis.getComputedStyle(span).whiteSpace,
      scrollsSideways,
      // 접히면 한 줄짜리 글자가 여러 줄 높이를 차지한다.
      tall: span.getBoundingClientRect().height > 30
    }
  })
}

/** 이 코드 줄이 사는 행의 코멘트 버튼. 진짜 마우스로 끌기 위한 표적이다. */
function commentAnchor(win, text) {
  return win
    .getByText(text, { exact: true })
    .locator('xpath=..')
    .locator('[aria-label="Comment on this line"]')
}

/** 표적 한가운데 좌표. 여기서는 스크롤하지 않는다 — 이미 맞춰 둔 화면을 흔들면 안 된다. */
async function centerOf(locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('could not measure a drag target')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** diff 를 담은 스크롤 상자의 scrollTop. 점프가 진짜 움직였는지 보는 값이다. */
function diffScrollTop(win) {
  return win.evaluate(() => {
    const block = globalThis.document.querySelector('[data-diff-file]')
    if (!block) return null
    let el = block.parentElement
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    return el ? el.scrollTop : null
  })
}

/**
 * 페이지에 가로 스크롤러 탐색기를 심는다.
 *
 * `scrollWidth > clientWidth` 만으로는 부족하다 — 넘치기만 하고 스스로 구르지는 않는 상자가
 * 중간에 여럿 있어서, 거기에 scrollLeft 를 써 봐야 0 에서 꿈쩍하지 않는다. 진짜 스크롤러는
 * overflow-x 가 auto/scroll 인 것뿐이다.
 */
async function installScrollerProbe(win) {
  await win.evaluate(() => {
    globalThis.__wooiHScroller = (from, stopAt) => {
      let box = from.parentElement
      while (box && box !== stopAt.parentElement) {
        const overflowX = globalThis.getComputedStyle(box).overflowX
        if ((overflowX === 'auto' || overflowX === 'scroll') && box.scrollWidth > box.clientWidth) {
          return box
        }
        box = box.parentElement
      }
      return null
    }
  })
}

export default async function diff_표시_조작() {
  await withScratchRepo(
    { worktrees: ['feature-parent', 'feature-test'], seed: seedStackedBranch },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await installScrollerProbe(wooi.win)
        await wooi.win.locator('.workpanel-tabs button[title="Changes"]').click()
        await wooi.win.locator('[data-diff-file="src/app.ts"]').waitFor()

        // ── 1. 파일 트리 + 이름 검색 ──────────────────────────────────────
        await wooi.win.locator('[aria-label="Show the file tree"]').click()
        const filter = wooi.win.locator('[aria-label="Filter changed files by name"]')
        await filter.waitFor()

        // 외자식 디렉터리는 한 행으로 합쳐진다 — src/deep 과 src/deep/nested 가 따로 서면
        // 정작 파일이 보일 자리가 없다.
        await wooi.win.locator('button[title="src/deep/nested"]').waitFor()

        // 검색은 경로 어디에 걸려도 통한다.
        await filter.fill('util')
        await wooi.win.locator('button[title="src/deep/nested/util.ts"]').waitFor()
        const filteredOut = await wooi.win.locator('button[title="src/app.ts"]').count()
        if (filteredOut !== 0) {
          throw new Error(`filter kept a non-matching file: ${filteredOut} rows for src/app.ts`)
        }
        await filter.fill('')

        // 점프는 진짜 스크롤이라야 값이 있다.
        const beforeJump = await diffScrollTop(wooi.win)
        if (beforeJump === null) throw new Error('could not find the diff scroll container')
        await wooi.win.locator('button[title="src/deep/nested/util.ts"]').click()
        await wooi.win.waitForTimeout(400)
        const afterJump = await diffScrollTop(wooi.win)
        if (!(afterJump > beforeJump)) {
          throw new Error(
            `clicking the tree did not scroll the diff: ${beforeJump} -> ${afterJump}`
          )
        }

        const treeShot = await wooi.shot('diff-view-controls-tree')

        // ── 2. 워드랩 토글 ────────────────────────────────────────────────
        // 기본은 켜짐 — 지금까지의 동작이 그것이라, 토글을 만진 적 없는 화면은 그대로여야 한다.
        const wrapped = await wrapProbe(wooi.win)
        if (!wrapped) throw new Error('could not find the long line used as the wrap probe')
        if (wrapped.whiteSpace !== 'pre-wrap' || wrapped.scrollsSideways || !wrapped.tall) {
          throw new Error(`long line was not wrapped by default: ${JSON.stringify(wrapped)}`)
        }

        await wooi.win.locator('[aria-label="Wrap long diff lines"]').click()
        await wooi.win.waitForTimeout(200)
        const unwrapped = await wrapProbe(wooi.win)
        if (unwrapped?.whiteSpace !== 'pre' || !unwrapped.scrollsSideways || unwrapped.tall) {
          throw new Error(`turning wrap off did not align the row: ${JSON.stringify(unwrapped)}`)
        }

        // 랩을 끈 채 가로로 밀어도 코멘트 히트 테스트가 어긋나지 않는다. 좌표가 아니라 행
        // 인덱스로 잡기 때문인데, 그 사실은 진짜 마우스로 끌어 봐야 증명된다.
        //
        // 추가된 줄을 고른다 — 삭제 줄만 고르면 새 파일에 자리가 없어 앵커가 한 점으로 모이므로
        // (그게 옳은 동작이다) 범위가 생겼는지 확인할 수 없다.
        // 끌 구간을 통째로 화면 가운데로 보내 둔다. hover() 로 시작 행만 맞추면 그 스크롤이
        // 목표 행을 화면 밖으로 밀어내, 드래그가 중간 행에서 끊긴다(L5-8 이 L5-6 이 된다).
        await wooi.win.evaluate(() => {
          const row = [...globalThis.document.querySelectorAll('span')].find(
            (el) => el.textContent === 'const line7 = 70'
          )
          row?.scrollIntoView({ block: 'center' })
        })
        await wooi.win.waitForTimeout(300)

        const from = await centerOf(commentAnchor(wooi.win, 'const line5 = 50'))
        const to = await centerOf(commentAnchor(wooi.win, 'const line8 = 80'))
        await wooi.win.mouse.move(from.x, from.y)
        await wooi.win.mouse.down()
        // 중간 행을 실제로 지나가야 진짜 드래그다 — 한 번에 건너뛰면 사람 손과 다르다.
        await wooi.win.mouse.move(to.x, to.y, { steps: 12 })
        await wooi.win.mouse.up()
        const draft = wooi.win.getByPlaceholder('What should the agent change here?')
        await draft.waitFor()
        await draft.fill('check this range')
        await wooi.win.getByRole('button', { name: 'Add comment' }).click()

        // 카드가 말하는 줄 범위가 실제로 고른 네 줄이어야 한다.
        const card = wooi.win.getByText('L5-8', { exact: true })
        const rangeCount = await card.count()
        if (rangeCount !== 1) {
          const seen = await wooi.win.locator('.group\\/card span.font-mono').allInnerTexts()
          throw new Error(`dragging across unwrapped rows lost the range: ${JSON.stringify(seen)}`)
        }

        const wrapShot = await wooi.shot('diff-view-controls-nowrap')

        // ── 3. 비교 기준 토글 ─────────────────────────────────────────────
        const before = await changedFiles(wooi.win)
        if (before.includes('src/parent-only.ts')) {
          throw new Error(`parent-only file leaked into the stacked diff: ${before.join(', ')}`)
        }

        await wooi.win.locator('[aria-label="Change what this diff is compared against"]').click()
        await wooi.win.getByRole('menuitemradio', { name: /main/ }).click()
        await wooi.win.locator('[data-diff-file="src/parent-only.ts"]').waitFor()

        const after = await changedFiles(wooi.win)
        if (!after.includes('src/parent-only.ts')) {
          throw new Error(
            `comparing against the default branch changed nothing: ${after.join(', ')}`
          )
        }

        // ⚠️ 표시만 바뀐다. PR base 와 rebase 대상은 부모 브랜치 그대로여야 한다 — 이 경계가
        // 무너지면 사용자가 "그냥 견줘 보려던" 행동이 스택 전체를 옮긴 것이 된다.
        const stillParent = await wooi.win.evaluate(async () => {
          const state = await globalThis.api.getState()
          return state.workspaces.find((w) => w.id === 'ws-e2e')?.baseBranch
        })
        if (stillParent !== 'feature-parent') {
          throw new Error(`compare base leaked into the real base: ${JSON.stringify(stillParent)}`)
        }

        console.log(
          `[e2e] files=${before.length}->${after.length} wrap=${wrapped.whiteSpace}->${unwrapped.whiteSpace} ` +
            `range=L5-8 screenshots=${treeShot},${wrapShot},${await wooi.shot('diff-view-controls-base')}`
        )
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
