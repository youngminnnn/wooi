/* global console, process */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 힌트 카드와 그 앵커의 실제 화면 좌표를 함께 잰다.
 *
 * 카드는 `aria-label="Dismiss hint"` 버튼을 품은 fixed 컨테이너다(`Hint.tsx`). 앵커 링은
 * `ring-2` 가 붙은 aria-hidden 오버레이라 클래스로 찾는다 — 링의 존재 자체가 계약이다.
 */
function measure(win) {
  return win.evaluate(() => {
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }
    }
    const dismiss = globalThis.document.querySelector('[aria-label="Dismiss hint"]')
    return {
      cards: globalThis.document.querySelectorAll('[aria-label="Dismiss hint"]').length,
      card: box(dismiss?.closest('div.fixed')),
      anchor: box(globalThis.document.querySelector('[data-tour="work-panel-toggle"]')),
      ring: box(globalThis.document.querySelector('.ring-2[aria-hidden]'))
    }
  })
}

/**
 * 점진적 온보딩 힌트가 **가리키는 컨트롤에 실제로 붙어서** 뜨는지 검증한다.
 *
 * 이건 유닛 테스트로 옮길 수 없다. jsdom 에는 레이아웃 엔진이 없어 `getBoundingClientRect` 가
 * 전부 0 이고, 실제로 났던 사고가 정확히 그 층이었다 — 앵커를 사이드바 섹션·채팅 열 같은
 * **레이아웃 컨테이너**로 잡는 바람에 카드가 빈 화면 한가운데 동떨어져 떴다. 조건 판정
 * (`hints.ts` 의 when)은 전부 초록이었고 아무도 못 잡았다.
 */
export default async function 힌트가_가리키는_버튼에_붙어_뜬다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        // work-panel 힌트의 조건: 변경 파일이 있고 작업 패널이 닫혀 있다.
        await writeFile(join(scratch.worktrees['feature-test'], 'hint-trigger.txt'), 'changed\n')
        await seedAppState(scratch, { settings: { defaultRightPanelOpen: false } })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const win = wooi.win
        await openSeededWorkspace(win)

        // git 상태 조회가 끝나야 changedFiles 가 채워지고 힌트 조건이 참이 된다.
        await win.locator('[aria-label="Dismiss hint"]').waitFor()
        const shown = await measure(win)
        console.log(`[e2e] hint geometry=${JSON.stringify(shown)}`)
        console.log(`[e2e] screenshot=${await wooi.shot('hint-attached')}`)

        // ── 1. 동시에 하나만 ────────────────────────────────────────
        if (shown.cards !== 1) {
          throw new Error(`expected exactly one hint card, found ${shown.cards}`)
        }

        // ── 2. 앵커에 링이 얹힌다 ───────────────────────────────────
        if (!shown.ring || !shown.anchor) {
          throw new Error(`ring or anchor missing: ${JSON.stringify(shown)}`)
        }
        // 링은 앵커를 3px 씩 넉넉히 감싼다(Hint.tsx). **네 변을 다 본다** — 세로만 보면 링이
        // 옆 버튼 위에 얹혀 있어도 통과한다. 실제로 그렇게 놓쳤다: 헤더에 Rebase 버튼이 뒤늦게
        // 붙으며 앵커가 왼쪽으로 밀렸는데 링은 처음 잰 자리에 남았고, 세로 좌표는 그대로라
        // 검사가 초록이었다.
        const wraps =
          shown.ring.top <= shown.anchor.top &&
          shown.ring.bottom >= shown.anchor.bottom &&
          shown.ring.left <= shown.anchor.left &&
          shown.ring.right >= shown.anchor.right
        if (!wraps) {
          throw new Error(
            `ring does not wrap its anchor: ${JSON.stringify({
              ring: shown.ring,
              anchor: shown.anchor
            })}`
          )
        }

        // ── 3. 카드가 앵커에 붙어 있다 ──────────────────────────────
        // 세로로는 겹치고, 가로로는 `anchorStyle` 의 gap(16px) 만큼 떨어져 나란히 서야 한다.
        // 범위를 4~48px 로 잡은 이유: 정상값은 16px 다. 아래로 0 까지 허용하면 카드가 앵커를
        // **덮은** 상태(측정이 낡아 카드가 밀린 경우)가 통과하고, 위로 열어 두면 다른 패널까지
        // 날아간 카드(수백 px)가 통과한다. 뷰포트 클램핑이 카드를 조금 미는 여유만 남긴다.
        const GAP_MIN = 4
        const GAP_MAX = 48
        const overlapsVertically =
          shown.card.top < shown.anchor.bottom && shown.card.bottom > shown.anchor.top
        const gap = Math.max(
          shown.anchor.left - shown.card.right,
          shown.card.left - shown.anchor.right
        )
        if (!overlapsVertically || gap < GAP_MIN || gap > GAP_MAX) {
          throw new Error(
            `hint card is not attached to its anchor (gap=${Math.round(gap)}px, ` +
              `verticalOverlap=${overlapsVertically}): ${JSON.stringify({
                card: shown.card,
                anchor: shown.anchor
              })}`
          )
        }

        // ── 4. 모달이 열리면 DOM 에서 사라진다 ──────────────────────
        // 밑에 깔린 채로 남으면 안 된다 — 보이지도 않으면서 세션 상한만 축낸다.
        await win.evaluate(() =>
          globalThis.window.dispatchEvent(
            new globalThis.CustomEvent('wooi:open-settings', { detail: 'general' })
          )
        )
        await win.locator('[aria-label="Dismiss hint"]').waitFor({ state: 'detached' })
        console.log(`[e2e] screenshot=${await wooi.shot('hint-hidden-behind-settings')}`)

        await win.keyboard.press('Escape')
        // 모달을 닫으면 같은 힌트가 그대로 돌아온다(세션 슬롯을 다시 쓰지 않는다).
        await win.locator('[aria-label="Dismiss hint"]').waitFor()
        const back = await measure(win)
        if (back.cards !== 1) {
          throw new Error(`hint did not return after closing Settings: ${JSON.stringify(back)}`)
        }

        // ── 5. 닫으면 다시 뜨지 않는다 ──────────────────────────────
        await win.locator('[aria-label="Dismiss hint"]').click()
        await win.locator('[aria-label="Dismiss hint"]').waitFor({ state: 'detached' })
        // 작업 패널을 열었다 닫아 조건을 다시 참으로 만들어도 돌아오면 안 된다.
        await win.keyboard.press('Meta+j')
        await win.keyboard.press('Meta+j')
        if (await win.locator('[aria-label="Dismiss hint"]').count()) {
          throw new Error('dismissed hint came back after re-triggering its condition')
        }

        console.log(`[e2e] screenshot=${await wooi.shot('hint-dismissed')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
