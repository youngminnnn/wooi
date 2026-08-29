/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 오래된 대화는 위로 올라갈 때 한 페이지씩 온다 — 그리고 보던 자리가 튀지 않는다.
 *
 * 스크롤 보정이 이 기능에서 가장 손이 가는 부분이고, 실제 창에서만 증명된다. jsdom 에서는
 * scrollHeight 가 늘 0 이라 "자란 만큼 밀었다" 는 단언 자체가 성립하지 않는다. 여기서는 진짜
 * 스크롤러를 진짜로 끌어 올려, 앞에 200개가 붙은 뒤에도 읽고 있던 문단이 화면 같은 높이에
 * 남아 있는지를 픽셀로 잰다.
 */
// 650 = 초기 300 → 한 페이지 더(500, 아직 더 있음) → 또 한 페이지(700 요청에 650 도착)로
// 머리에 닿는 수. 두 경로(스크롤·버튼)를 한 번의 실행에서 모두 지나간다.
const TOTAL = 650
const INITIAL_LIMIT = 300
const PAGE = 200
const OLDEST = 'msg-0'
const NEWEST = `msg-${TOTAL - 1}`

export default async function 오래된_대화는_한_페이지씩_온다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: Array.from({ length: TOTAL }, (_, i) => ({
            id: `msg-${i}`,
            type: 'assistant',
            text: `paged transcript entry ${i}`,
            ts: now - (TOTAL - i)
          }))
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.locator(`[data-item-id="${NEWEST}"]`).waitFor({ state: 'attached' })

        // ── 첫 페인트는 꼬리만 이고 온다 ────────────────────────────────────
        if ((await countItems(wooi.win)) > INITIAL_LIMIT) {
          throw new Error(
            `the first paint rendered ${await countItems(wooi.win)} items, wanted at most ${INITIAL_LIMIT}`
          )
        }
        await expectAbsent(wooi.win, OLDEST, 'the first paint')
        // 창 밖으로 밀려난 경계 바로 앞 항목도 없어야 한다 — 실수로 전부 왔는데 개수만 맞는
        // 상황을 거른다.
        await expectAbsent(wooi.win, `msg-${TOTAL - INITIAL_LIMIT - 1}`, 'the first paint')
        const loadEarlier = wooi.win.locator('button', { hasText: 'Load earlier messages' })
        await loadEarlier.waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-pagination-first-page')}`)

        // ── 위쪽에 닿으면 알아서 한 페이지 더 온다 ──────────────────────────
        // 읽고 있던 문단을 하나 정해 화면에서의 높이를 기억해 둔다. 앞에 200개가 붙은 뒤에도
        // 같은 높이에 있어야 한다.
        const firstLoaded = TOTAL - INITIAL_LIMIT
        const anchorId = `msg-${firstLoaded + 4}`
        await wooi.win.locator(`[data-item-id="${anchorId}"]`).waitFor()
        await scrollTranscriptToTop(wooi.win)
        const before = await offsetInScroller(wooi.win, anchorId)

        // 앞에 붙은 항목은 뷰포트 밖이다(그게 보정이 한 일이다) — 보이는지가 아니라
        // 붙었는지를 기다린다.
        await wooi.win.locator(`[data-item-id="msg-${TOTAL - INITIAL_LIMIT - PAGE}"]`).waitFor({
          state: 'attached',
          timeout: 10_000
        })
        await wooi.win.waitForTimeout(500)
        const after = await offsetInScroller(wooi.win, anchorId)
        if (Math.abs(after - before) > 4) {
          throw new Error(
            `prepending a page yanked the view: the anchor moved ${before} -> ${after} (px)`
          )
        }
        // 아직 머리에 닿지 않았으므로 버튼은 남아 있다.
        await loadEarlier.waitFor()
        await expectAbsent(wooi.win, OLDEST, 'the second page')
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-pagination-second-page')}`)

        // ── 버튼으로도 같은 동작을 하고, 머리에 닿으면 사라진다 ─────────────
        await loadEarlier.click()
        await wooi.win
          .locator(`[data-item-id="${OLDEST}"]`)
          .waitFor({ state: 'attached', timeout: 10_000 })
        await wooi.win.waitForTimeout(500)
        if ((await loadEarlier.count()) > 0) {
          throw new Error('the whole transcript is loaded but "Load earlier messages" is still up')
        }
        if ((await countItems(wooi.win)) !== TOTAL) {
          throw new Error(
            `after loading everything the list held ${await countItems(wooi.win)} items, wanted ${TOTAL}`
          )
        }
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-pagination-head')}`)

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

function countItems(win) {
  return win.locator('[data-item-id]').count()
}

async function expectAbsent(win, itemId, when) {
  const count = await win.locator(`[data-item-id="${itemId}"]`).count()
  if (count > 0) throw new Error(`${when} already rendered ${itemId}; the read window did nothing`)
}

/**
 * 스크롤러를 맨 위로 올린다 — 위쪽 임계선에 닿으면 다음 페이지가 알아서 붙는다.
 *
 * 스크롤러는 클래스가 아니라 **대화 항목을 담고 있다는 사실**로 찾는다. `.overflow-y-auto` 는
 * 사이드바가 문서에서 먼저 나오므로 그쪽이 잡힌다.
 */
function scrollTranscriptToTop(win) {
  return win.evaluate(() => {
    const el = globalThis.document.querySelector('[data-item-id]')?.closest('.overflow-y-auto')
    if (!el) throw new Error('the transcript scroller was not found')
    el.scrollTop = 0
  })
}

/**
 * 항목이 스크롤 뷰포트 안에서 앉아 있는 높이. 화면(뷰포트) 기준이 아니라 **스크롤러 기준**으로
 * 재는 것이 중요하다 — 대화 위쪽 배너(스택 동기화·아카이브 제안 등)는 git/PR 조회가 끝나면
 * 뒤늦게 뜨면서 채팅 패널 전체를 몇십 px 밀어 내린다. 뷰포트 기준으로 재면 그 배너가 스크롤
 * 보정의 회귀로 둔갑한다.
 */
function offsetInScroller(win, itemId) {
  return win.evaluate((id) => {
    const el = globalThis.document.querySelector(`[data-item-id="${id}"]`)
    const scroller = el?.closest('.overflow-y-auto')
    if (!el || !scroller) throw new Error(`${id} was not in the transcript scroller`)
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    return Math.round(offset * 100) / 100
  }, itemId)
}
