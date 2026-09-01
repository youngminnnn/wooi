/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const MINE = 'feature-test'
const NEIGHBOUR = 'other-task'

/**
 * 같은 리포에 워크스페이스 둘을 놓는다. 시드는 하나만 쓰므로(`seedAppState`) 그 결과를 템플릿
 * 삼아 이웃을 하나 더 적는다 — `sidebar-stack-order.spec.mjs` 와 같은 방식이다. 이웃의
 * displayName 을 비우는 것도 그쪽과 같은 이유다: `openSeededWorkspace` 가
 * E2E_WORKSPACE_DISPLAY_NAME 으로 행을 집으므로 그 이름은 한 행에만 있어야 한다.
 */
async function seedTwoWorkspaces(scratch) {
  // 이 워크스페이스에 "아직 안 내려간 일" 을 만든다. 커밋 대신 추적되지 않는 파일이면 ahead 는
  // 0 으로 남아 open-pr 이 참이 되지 않는다 — 후보를 스택 힌트 하나로 좁힌다.
  await writeFile(join(scratch.worktrees[MINE], 'stack-trigger.txt'), 'changed\n')
  // 작업 패널은 기본값(열림) 그대로 둔다. 닫아 두면 work-panel 힌트(우선순위 40)가 스택
  // 힌트(45)를 이겨 이 스펙이 다른 카드를 보게 된다.
  await seedAppState(scratch, { workspaceName: MINE })

  const file = join(scratch.userDataPath, 'wooi.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const template = state.workspaces[0]
  state.workspaces = [
    template,
    {
      ...template,
      id: `ws-${NEIGHBOUR}`,
      name: NEIGHBOUR,
      displayName: null,
      branch: NEIGHBOUR,
      worktreePath: scratch.worktrees[NEIGHBOUR],
      sessionId: null
    }
  ]
  await writeFile(file, JSON.stringify(state, null, 2))
}

/** 힌트 카드와 앵커 링의 유무·좌표를 잰다(`progressive-hints.spec.mjs` 의 measure 와 같은 뼈대). */
function measure(win) {
  return win.evaluate(() => {
    const dismiss = globalThis.document.querySelector('[aria-label="Dismiss hint"]')
    const card = dismiss?.closest('div.fixed')
    const r = card?.getBoundingClientRect()
    return {
      cards: globalThis.document.querySelectorAll('[aria-label="Dismiss hint"]').length,
      text: card?.textContent ?? null,
      card: r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : null,
      // 앵커형 힌트만 그리는 링. 인라인 힌트에는 **없어야** 한다.
      rings: globalThis.document.querySelectorAll('.ring-2[aria-hidden]').length,
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight }
    }
  })
}

/**
 * 스택 힌트가 **옆에 다른 일이 있을 때** 뜨고, 인라인 카드로 사이드바 밑에 자리 잡는지 본다.
 *
 * 유닛 테스트가 못 보는 두 가지가 여기 있다.
 *
 * 1. **트리거의 재료가 진짜인지.** 이 힌트는 `check_related_work` 의 파일 겹침 검사를 쓰지
 *    않는다(비용 때문에 on-demand 로 내려간 기능이라 상시로 되돌릴 수 없다). 대신 상시로 이미
 *    아는 신호 — 같은 리포의 활성 워크스페이스 수와 부모/자식 관계 — 만 본다. 그 값들이 실제
 *    메인 프로세스 상태에서 제대로 흘러오는지는 진짜 앱을 띄워야 알 수 있다.
 * 2. **인라인 카드의 자리.** jsdom 에는 레이아웃이 없어 `getBoundingClientRect` 가 전부 0 이다.
 *    이 스위트가 생긴 이유가 정확히 그 층이었다 — 앵커를 레이아웃 컨테이너로 잡는 바람에 카드가
 *    빈 화면 한가운데 떴는데 `when` 판정은 전부 초록이었다. 인라인 카드는 앵커가 아예 없으므로
 *    그 사고가 다른 모습으로 온다: 화면 아무 데나 뜨는 것. 좌하단에 붙어 있는지를 직접 잰다.
 */
export default async function 스택_힌트가_사이드바_아래에_인라인으로_뜬다() {
  await withScratchRepo(
    {
      // 같은 리포에 두 갈래 일. 하나뿐이면 이 힌트는 정의상 뜨지 않는다(쌓을 상대가 없다).
      worktrees: [MINE, NEIGHBOUR],
      seed: seedTwoWorkspaces
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const win = wooi.win
        await openSeededWorkspace(win)

        // git 상태 조회가 끝나야 changedFiles 가 채워지고 힌트 조건이 참이 된다.
        await win.locator('[aria-label="Dismiss hint"]').waitFor()
        const shown = await measure(win)
        console.log(`[e2e] stack hint=${JSON.stringify(shown)}`)
        console.log(`[e2e] screenshot=${await wooi.shot('stack-hint-inline')}`)

        // ── 1. 동시에 하나만, 그리고 그게 스택 힌트다 ───────────────
        if (shown.cards !== 1) {
          throw new Error(`expected exactly one hint card, found ${shown.cards}`)
        }
        if (!shown.text?.includes('stacked workspace')) {
          throw new Error(`the visible hint is not the stack hint: ${JSON.stringify(shown.text)}`)
        }

        // ── 2. 앵커형이 아니다 ──────────────────────────────────────
        // 링이 그려졌다면 이 힌트가 어딘가에 anchor 를 달았다는 뜻이다. 인라인으로 남기기로 한
        // 이유가 있다 — 가리킬 컨트롤(행 호버 메뉴의 "Stack a new workspace")이 눌러야 열리는
        // 메뉴 안이라, 레이아웃 컨테이너를 앵커로 재사용하면 카드가 엉뚱한 빈 곳을 가리킨다.
        if (shown.rings !== 0) {
          throw new Error(`inline hint must not draw an anchor ring, found ${shown.rings}`)
        }

        // ── 3. 사이드바 좌하단에 붙어 있다 ──────────────────────────
        // Hint.tsx 의 인라인 배치는 left:8 / bottom:8 이다. 여유를 조금 두되, 화면 한가운데로
        // 날아간 카드는 반드시 걸리게 잡는다.
        const EDGE_MAX = 24
        const fromBottom = shown.viewport.height - shown.card.bottom
        if (shown.card.left > EDGE_MAX || fromBottom > EDGE_MAX || fromBottom < 0) {
          throw new Error(
            `inline hint is not pinned to the sidebar's bottom-left: ${JSON.stringify({
              card: shown.card,
              viewport: shown.viewport
            })}`
          )
        }
        // 사이드바 폭 안에 머물러야 한다 — 채팅 열을 덮으면 그건 인라인 배치가 아니다.
        const sidebarRight = await win.evaluate(() => {
          const list = globalThis.document.querySelector('[data-tour="workspaces"]')
          return list ? list.getBoundingClientRect().right : null
        })
        if (sidebarRight != null && shown.card.right > sidebarRight + EDGE_MAX) {
          throw new Error(
            `inline hint spills past the sidebar (card.right=${Math.round(shown.card.right)}, ` +
              `sidebar.right=${Math.round(sidebarRight)})`
          )
        }

        // ── 4. 닫으면 다시 뜨지 않는다 ──────────────────────────────
        await win.locator('[aria-label="Dismiss hint"]').click()
        await win.locator('[aria-label="Dismiss hint"]').waitFor({ state: 'detached' })
        // 조건을 다시 참으로 만들어도(다른 워크스페이스에 갔다 온다) 돌아오면 안 된다.
        await win.keyboard.press('Meta+ArrowDown')
        await win.keyboard.press('Meta+ArrowUp')
        if (await win.locator('[aria-label="Dismiss hint"]').count()) {
          throw new Error('dismissed stack hint came back after re-triggering its condition')
        }

        console.log(`[e2e] screenshot=${await wooi.shot('stack-hint-dismissed')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
