/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 기본 스크래치 루트는 한 번에 하나의 실행만 감당한다(하네스 계약). 이 스펙만의 루트를 쓴다.
const ROOT = '/tmp/wooi-e2e-rewind-modes'
// shots 를 루트 밖에 둔다 — 루트는 끝나면 통째로 지워져 PNG 가 함께 사라진다.
const SHOTS = '/tmp/wooi-shots-rewind-modes'

/**
 * /rewind — 대화 되돌리기의 화면 쪽 계약.
 *
 * **이 스펙이 증명하지 못하는 것을 먼저 밝힌다.** 체크포인트는 살아 있는 세션에서 보낸 메시지로만
 * 생기므로(모델 턴이 필요하다) 여기서는 만들 수 없고, 따라서 세 갈래 선택 UI 와 되돌리기 실행은
 * 앱을 띄워서 확인할 수 없다. 그쪽은 session.rewind.test.ts 가 실물 SDK 계약을 흉내 내 덮는다.
 * 이 스펙이 통과했다고 "되돌리기가 된다" 로 읽으면 안 된다.
 *
 * 대신 앱을 띄워야만 알 수 있는 두 가지를 본다.
 *
 * 1. **truncate 이벤트가 화면 대화를 실제로 자르는가.** 되돌리기의 절반은 메인이 트랜스크립트를
 *    자르고 렌더러에 지점만 알려 주는 것이다(`{type:'truncate'}`). 이 리듀서가 틀리면 되돌린
 *    뒤에도 사라졌어야 할 말이 화면에 남는다 — jsdom 이 아니라 실제로 그려진 DOM 에서 본다.
 * 2. **`/rewind` 카드가 뜨고, 체크포인트가 없을 때 그 사정을 말하는가.** 카드는 입력창과 Esc Esc
 *    두 경로로 열린다. 예전에는 이 카드가 **언제나** 비어 있었으므로(체크포인트 수집이 죽어 있었다)
 *    빈 상태 문구가 곧 사용자가 보던 전부였다.
 */

const now = Date.now()
const transcript = [
  { id: 'user-keep', type: 'user', text: 'KEEP-FIRST-MESSAGE', ts: now - 40 },
  { id: 'assistant-keep', type: 'assistant', text: 'KEEP-FIRST-REPLY', ts: now - 30 },
  { id: 'user-drop', type: 'user', text: 'DROP-SECOND-MESSAGE', ts: now - 20 },
  { id: 'assistant-drop', type: 'assistant', text: 'DROP-SECOND-REPLY', ts: now - 10 }
]

/** 메인이 렌더러로 보내는 대화 이벤트를 그대로 흉내 낸다(sendPermissionRequest 와 같은 길). */
async function sendChatEvent(app, event, { workspaceId = 'ws-e2e', appDir = process.cwd() } = {}) {
  const typesFile = join(resolve(appDir), 'src/shared/types.ts')
  const channel = (await readFile(typesFile, 'utf8')).match(/evtChat:\s*'([^']+)'/)?.[1]
  if (!channel) throw new Error(`evtChat channel not found in ${typesFile}`)
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no window to deliver the chat event to')
      win.webContents.send(payload.channel, {
        workspaceId: payload.workspaceId,
        event: payload.event
      })
    },
    { channel, workspaceId, event }
  )
}

/** 인터셉트 카드의 루트. 한 번에 하나만 뜨므로 first() 로 충분하다. */
function cardRoot(win) {
  return win.locator('div.absolute.bottom-full').first()
}

async function closeCard(win) {
  await win.locator('button[title="Dismiss (Esc)"]').click()
  await win.locator('button[title="Dismiss (Esc)"]').waitFor({ state: 'detached' })
}

function expectIncludes(actual, expected, subject) {
  if (!actual.includes(expected)) {
    throw new Error(
      `${subject}: expected text containing ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

function expectExcludes(actual, forbidden, subject) {
  if (actual.includes(forbidden)) {
    throw new Error(
      `${subject}: expected text NOT containing ${JSON.stringify(forbidden)}, found ${JSON.stringify(actual)}`
    )
  }
}

export default async function rewind_카드와_대화_자르기() {
  await withScratchRepo(
    {
      root: ROOT,
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch, shotsPath: SHOTS })
      try {
        await openSeededWorkspace(wooi.win)
        const textarea = wooi.win.locator('textarea[placeholder^="Message your agent"]')
        await textarea.waitFor()

        // ── 1. truncate 가 화면 대화를 자른다 ────────────────────────────────
        {
          const before = await wooi.win.locator('body').innerText()
          for (const item of transcript) {
            expectIncludes(before, item.text, 'seeded transcript')
          }

          await sendChatEvent(wooi.app, { type: 'truncate', fromItemId: 'user-drop' })

          // 자른 결과가 그려질 때까지 기다린다 — 사라짐을 곧바로 단언하면 통과가 우연이 된다.
          await wooi.win
            .getByText('DROP-SECOND-MESSAGE', { exact: false })
            .waitFor({ state: 'detached', timeout: 15_000 })

          const after = await wooi.win.locator('body').innerText()
          // 지정한 항목부터 뒤가 사라진다.
          expectExcludes(after, 'DROP-SECOND-MESSAGE', 'truncate drops the target message')
          expectExcludes(after, 'DROP-SECOND-REPLY', 'truncate drops what followed it')
          // 그 앞은 그대로 남는다 — 통째로 비우는 것이 아니다.
          expectIncludes(after, 'KEEP-FIRST-MESSAGE', 'truncate keeps earlier messages')
          expectIncludes(after, 'KEEP-FIRST-REPLY', 'truncate keeps earlier replies')

          console.log(`[e2e] screenshot=${await wooi.shot('rewind-truncated')}`)
        }

        // ── 2. /rewind 카드 — 입력창 경로 ────────────────────────────────────
        {
          await textarea.click()
          // 후행 공백이 자동완성 메뉴를 닫는다 — 메뉴가 열려 있으면 Enter 를 메뉴가 먼저 가져간다.
          await textarea.fill('/rewind ')
          await textarea.press('Enter')
          await wooi.win.locator('button[title="Dismiss (Esc)"]').waitFor({ timeout: 30_000 })

          const text = await cardRoot(wooi.win).innerText()
          // 라이브 세션이 없으니 되돌릴 지점도 없다 — 그 사정을 말해야 한다.
          expectIncludes(text, 'No checkpoints yet', '/rewind empty state')
          console.log(`[e2e] screenshot=${await wooi.shot('rewind-card')}`)
          await closeCard(wooi.win)
        }

        // ── 3. 같은 카드가 Esc Esc 로도 열린다 ───────────────────────────────
        {
          await textarea.click()
          await textarea.press('Escape')
          await textarea.press('Escape')
          await wooi.win.locator('button[title="Dismiss (Esc)"]').waitFor({ timeout: 30_000 })

          const text = await cardRoot(wooi.win).innerText()
          expectIncludes(text, 'No checkpoints yet', 'Esc Esc opens the same card')
          console.log(`[e2e] screenshot=${await wooi.shot('rewind-card-esc-esc')}`)
          await closeCard(wooi.win)
        }

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
