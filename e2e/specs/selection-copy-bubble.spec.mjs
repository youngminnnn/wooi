/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 고른 글자 위에 복사 버튼이 뜨고, 누르면 그 글자가 클립보드로 간다.
 *
 * 이 기능은 진짜 창에서만 검증된다 — jsdom 은 드래그로 만들어지는 Selection 도, 버튼을 띄울
 * 좌표를 정하는 레이아웃도 흉내 내지 않는다. 클립보드는 메인 프로세스에서 직접 읽어, "복사됨"
 * 표시가 아니라 실제로 담긴 글자를 단언한다.
 */
// 열 너비를 채워 줄바꿈되는 문단이라야 드래그가 글자 안에서 끝난다. 짧은 한 줄이면 오른쪽
// 끝을 지나쳐 버려, 크로미움이 selection 의 focus 를 대화 밖(컴포저)에 놓는다.
const AGENT_LINE =
  'copy-bubble-agent-body ' +
  'a long wrapping paragraph that fills the column so the drag ends inside it. '.repeat(4)
const COPY = 'Copy'

export default async function 고른_글자_위에_복사_버튼이_뜬다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user-1', type: 'user', text: 'show me the copy bubble', ts: now - 20 },
            { id: 'assistant-1', type: 'assistant', text: AGENT_LINE, ts: now - 19 },
            // 스크롤로 닫히는지 보려면 대화가 실제로 스크롤돼야 한다.
            ...Array.from({ length: 18 }, (_, i) => ({
              id: `filler-${i}`,
              type: 'assistant',
              text: `filler paragraph ${i} — enough body to make the transcript scroll`,
              ts: now - 18 + i
            }))
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        // 긴 본문을 getByText 로 잡으면 두 메시지를 함께 담은 조상이 걸린다 — 항목 id 로
        // 좁힌 뒤 그 안의 문단을 잡는다.
        const target = wooi.win.locator('[data-item-id="assistant-1"] p').first()
        await target.waitFor()
        const bubble = wooi.win.locator('button', { hasText: new RegExp(`^${COPY}$`) })

        // ── 드래그가 끝나면 버튼이 뜬다 ──────────────────────────────────────
        const selected = await dragAcross(wooi.win, target)
        // 어느 줄을 훑었는지가 아니라 "고른 글자가 그대로 복사되는가" 가 계약이다 — 정확한
        // 문자열은 아래에서 클립보드와 맞대 본다.
        if (selected.trim().length < 20) {
          throw new Error(`the drag selected nothing usable: ${JSON.stringify(selected)}`)
        }
        await bubble.waitFor({ timeout: 3000 })
        console.log(`[e2e] screenshot=${await wooi.shot('selection-copy-bubble')}`)

        // ── 누르면 고른 글자가 클립보드로 간다 ───────────────────────────────
        await wooi.app.evaluate(({ clipboard }) => clipboard.writeText('clipboard-before-copy'))
        await bubble.click()
        await wooi.win.waitForTimeout(400)
        const clipboard = await wooi.app.evaluate(({ clipboard }) => clipboard.readText())
        if (clipboard !== selected.trim()) {
          throw new Error(
            `the copy button wrote ${JSON.stringify(clipboard)}, wanted the selection ${JSON.stringify(selected.trim())}`
          )
        }

        // ── Esc 로 닫힌다 ───────────────────────────────────────────────────
        await dragAcross(wooi.win, target)
        await bubble.waitFor({ timeout: 3000 })
        await wooi.win.keyboard.press('Escape')
        await wooi.win.waitForTimeout(300)
        if ((await bubble.count()) > 0) throw new Error('Escape did not close the copy bubble')

        // ── 스크롤에 닫힌다 ─────────────────────────────────────────────────
        // 대화 스크롤러는 window 로 scroll 을 올려 보내지 않는다. 캡처로 듣고 있는지가
        // 여기서 갈린다 — 버블만 남고 글자가 움직이면 엉뚱한 자리를 가리키게 된다.
        await dragAcross(wooi.win, target)
        await bubble.waitFor({ timeout: 3000 })
        const scrolled = await wooi.win.evaluate(() => {
          // 사이드바가 문서에서 먼저 나오므로 클래스만으로는 못 찾는다 — 대화 항목을 담고
          // 있다는 사실로 특정한다.
          const el = globalThis.document
            .querySelector('[data-item-id]')
            ?.closest('.overflow-y-auto')
          if (!el || el.scrollHeight <= el.clientHeight) return false
          el.scrollTop = el.scrollTop + 120
          return true
        })
        if (!scrolled) throw new Error('the transcript did not scroll; the seed is too short')
        await wooi.win.waitForTimeout(300)
        if ((await bubble.count()) > 0) throw new Error('scrolling did not close the copy bubble')

        // ── 대화 밖으로 걸친 선택은 무시한다 ─────────────────────────────────
        // 대화에서 시작해 입력창까지 끌면 selection 의 한쪽 끝이 대화 밖에 남는다. 그 상태로
        // 복사하면 사용자가 보고 있던 것과 다른 글자가 담기므로 버튼을 띄우지 않는다.
        const composer = wooi.win.locator('textarea[placeholder^="Message your agent"]')
        await dragBetween(wooi.win, target, composer)
        await wooi.win.waitForTimeout(400)
        if ((await bubble.count()) > 0) {
          throw new Error('a selection spilling into the composer still offered to copy')
        }

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

function clearSelection(win) {
  return win.evaluate(() => globalThis.getSelection()?.removeAllRanges())
}

/**
 * 첫 줄 안에서 가로로 훑는다.
 *
 * 문단의 오른쪽 끝을 지나치면 안 된다 — 크로미움은 글자가 끝난 지점 너머에서 selection 의
 * focus 를 다음 선택 가능한 자리(여기서는 입력창)로 보내고, 그러면 "대화 안에서 고른 글자"
 * 라는 조건이 깨져 버블이 뜨지 않는다. 사람이 문장 일부를 고르는 손짓이 이쪽이다.
 */
async function dragAcross(win, locator) {
  await clearSelection(win)
  const box = await stableBox(win, locator)
  // 문단의 첫 줄이 아니라 세로 가운데를 훑는다. 스크롤러 가장자리에서 6px 떨어진 자리에
  // 마우스를 누르면 크로미움이 드래그 중 자동 스크롤을 걸어, 위쪽의 다른 메시지까지 고른다.
  const y = box.y + box.height / 2
  await win.mouse.move(box.x + 2, y)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width * 0.6, y, { steps: 20 })
  await win.mouse.up()
  await win.waitForTimeout(250)
  return win.evaluate(() => globalThis.getSelection()?.toString() ?? '')
}

/** 한 요소에서 시작해 다른 요소 위에서 손을 떼는 드래그. */
async function dragBetween(win, from, to) {
  const start = await stableBox(win, from)
  const startY = start.y + start.height / 2
  const end = await to.boundingBox()
  if (!end) throw new Error('the drag destination was not on screen')
  await clearSelection(win)
  await win.mouse.move(start.x + 2, startY)
  await win.mouse.down()
  await win.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 })
  await win.mouse.up()
  await win.waitForTimeout(300)
}

/**
 * 자리가 멎을 때까지 기다린 뒤의 상자.
 *
 * 두 가지를 함께 처리한다. 대화는 열리자마자 맨 아래로 붙으므로 대상이 화면 밖일 수 있고
 * (boundingBox 는 뷰포트 밖에서도 값을 준다), 대화 위쪽 배너는 git/PR 조회가 끝나면 뒤늦게
 * 떠서 채팅 패널을 통째로 몇십 px 밀어 내린다. 재고 나서 밀리면 엉뚱한 메시지를 끌게 된다.
 */
async function stableBox(win, locator) {
  // 가장자리가 아니라 한가운데로 데려온다 — 위 참조.
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  let last = null
  for (let i = 0; i < 20; i++) {
    const box = await locator.boundingBox()
    if (!box) throw new Error('the drag target was not on screen')
    if (last && Math.abs(box.y - last.y) < 0.5 && Math.abs(box.x - last.x) < 0.5) return box
    last = box
    await win.waitForTimeout(150)
  }
  throw new Error('the drag target never settled into a stable position')
}
