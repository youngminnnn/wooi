/* global console, process, document, window */

import {
  E2E_WORKSPACE_DISPLAY_NAME,
  openRowMenuItem,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const WORKTREE = 'feature-test'
// 초기 읽기 창(300)보다 길게 둔다 — 잘려 있다는 표시가 뜨는지 보려면 실제로 잘려야 한다.
const TOTAL = 420
const INITIAL_LIMIT = 300
// 첫 화면 밖(꼬리 300개 = msg-120..msg-419)에 둔 바늘. ⇧⌘K 로 여기 닿으려면 아카이브된
// 대화를 통째로 다시 읽어야 하므로, 검색 점프가 진짜로 살아 있는지가 여기서 갈린다.
const NEEDLE_ID = 'msg-5'
const NEEDLE = 'sunfish-marker-phrase'

/**
 * 아카이브된 워크스페이스의 대화를 읽기 전용으로 열어 본 뒤, 그 자리에서 되살린다.
 *
 * 판정 로직(무엇을 감출지·잘렸다고 말할지)은 유닛 테스트(archivedPreview)가 이미 증명한다.
 * 여기서만 알 수 있는 것은 **그 판정이 사용자의 손에 이어져 있는가** 다 — 사이드바의 아카이브
 * 행이 실제로 눌리는지, 눌렀을 때 입력창 없이 대화가 뜨는지, ⇧⌘K 검색 결과가 아카이브된
 * 대화로 실제로 데려가는지(예전에는 토스트만 띄우는 막다른 길이었다), 그리고 그 화면의
 * Unarchive 가 정말로 worktree 를 다시 만들어 평범한 대화 화면으로 돌아오는지. 마지막 것은
 * jsdom 이 흉내 낼 수 없다 — 진짜 git 이 디렉터리를 지우고 다시 만드는 왕복이기 때문이다.
 */
export default async function 아카이브된_워크스페이스를_읽고_되살린다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: [WORKTREE],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: Array.from({ length: TOTAL }, (_, i) => ({
            id: `msg-${i}`,
            type: 'assistant',
            text: i === 5 ? `archived entry ${i} ${NEEDLE}` : `archived transcript entry ${i}`,
            ts: now - (TOTAL - i)
          }))
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        await openSeededWorkspace(win)

        // ── 1. 아카이브한다 — worktree 만 사라지고 대화는 남는다 ──────────────
        ;(await openRowMenuItem(win, 'Archive workspace')).click()
        await win.getByRole('button', { name: 'Archive', exact: true }).click()
        await win.waitForFunction(() => !document.querySelector('.workspace-header'), undefined, {
          timeout: 15_000
        })

        // ── 2. 사이드바의 아카이브 행을 눌러 읽기 전용으로 연다 ───────────────
        // 예전에는 이 행이 평범한 div 였다. 안을 보려면 먼저 되살려야 했다 — 판단에 필요한
        // 정보를 얻으려면 판단 대상인 행동을 먼저 해야 하는 구조였다.
        await win.locator('button', { hasText: /^Archived \(\d+\)$/ }).click()
        const archivedRow = win.locator(
          `button[title="${E2E_WORKSPACE_DISPLAY_NAME} — ${WORKTREE}"]`
        )
        await archivedRow.waitFor({ timeout: 5000 })
        await archivedRow.click()

        const preview = win.locator('.archived-preview-header')
        await preview.waitFor({ timeout: 10_000 })
        await preview.getByText('Archived', { exact: true }).waitFor()

        // 대화가 실제로 그려진다 — 아카이브는 트랜스크립트를 지우지 않는다.
        await win.locator(`[data-item-id="msg-${TOTAL - 1}"]`).waitFor({ state: 'attached' })
        const rendered = await win.locator('[data-item-id]').count()
        if (rendered === 0 || rendered > INITIAL_LIMIT) {
          throw new Error(
            `the archived preview rendered ${rendered} items, wanted 1..${INITIAL_LIMIT}`
          )
        }

        // 잘려 있다는 사실을 숨기지 않는다 — 이 화면만 보고 되살릴지 정하기 때문이다.
        await win
          .getByText(`Showing the most recent ${rendered} messages`, { exact: false })
          .waitFor({ timeout: 5000 })

        // 읽기 전용이다 — 새 턴을 시작할 수단이 화면에 없어야 한다.
        const composers = await win.locator('textarea').count()
        if (composers > 0) {
          throw new Error(
            `the archived preview still offers ${composers} text input(s) — there is no session to send to`
          )
        }
        await win.getByText('Read-only', { exact: false }).first().waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('archived-preview-readonly')}`)

        // ── 3. ⇧⌘K 검색이 아카이브된 대화로 실제로 데려간다 ──────────────────
        await win.keyboard.press('Meta+Shift+K')
        await win.getByPlaceholder('Search every conversation…').fill(NEEDLE)
        const hit = win.locator('[data-idx="0"]')
        await hit.waitFor({ timeout: 15_000 })
        await hit.click()

        // 첫 화면 밖에 있던 항목이다 — 닿았다는 것은 아카이브된 대화를 끝까지 읽었다는 뜻이다.
        // 붙었는지가 아니라 **화면에 들어왔는지**를 본다: 목적지가 DOM 에만 있고 스크롤이 그대로면
        // 사용자에게는 아무 일도 일어나지 않은 것과 같다(예전 막다른 길과 구별되지 않는다).
        await win.waitForFunction(
          (itemId) => {
            const el = document.querySelector(`[data-item-id="${itemId}"]`)
            if (!el) return false
            const r = el.getBoundingClientRect()
            return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight
          },
          NEEDLE_ID,
          { timeout: 15_000 }
        )
        if ((await win.locator('.archived-preview-header').count()) === 0) {
          throw new Error('jumping from search left the archived preview — the dead end is back')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('archived-preview-search-jump')}`)

        // ── 4. 보고 나서 그 자리에서 되살린다 ────────────────────────────────
        await preview.getByRole('button', { name: 'Unarchive', exact: true }).click()
        await win.locator('.workspace-header').waitFor({ timeout: 30_000 })
        await win.locator('textarea').first().waitFor({ timeout: 10_000 })
        if ((await win.locator('.archived-preview-header').count()) > 0) {
          throw new Error('the workspace was unarchived but the read-only preview is still up')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('archived-preview-unarchived')}`)

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
