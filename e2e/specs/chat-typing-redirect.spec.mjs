/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 대화 아무 데나 친 글자는 입력창의 caret 자리로 간다.
 *
 * 판정 자체는 렌더러 단위 테스트가 전수로 덮는다([[typingRedirect]]). 여기서 증명할 것은
 * 그 판정이 실제 창에서 이어지는지다 — 진짜 포커스가 대화 본문에 있고, 진짜 키가 App 의 전역
 * 핸들러를 지나, 진짜 textarea 의 selectionStart 에 꽂히는 경로. jsdom 은 포커스도 caret 도
 * 흉내만 내므로 이 사슬이 끊겨도 초록으로 남는다.
 */
const COMPOSER = 'textarea[placeholder^="Message your agent"]'

export default async function 대화_아무_데나_치면_입력창으로_간다() {
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user-1', type: 'user', text: 'redirect target conversation', ts: now - 1 },
            { id: 'assistant-1', type: 'assistant', text: 'typing-redirect body', ts: now }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const composer = wooi.win.locator(COMPOSER)
        await composer.waitFor()

        // ── 포커스가 대화 본문에 있어도 글자가 들어간다 ──────────────────────
        await blur(wooi.win)
        await wooi.win.keyboard.press('h')
        await wooi.win.keyboard.press('i')
        await wooi.win.waitForTimeout(200)
        await expectDraft(composer, 'hi', 'typing with focus outside the composer')
        if (!(await isComposerFocused(wooi.win))) {
          throw new Error('the first keystroke did not move focus to the composer')
        }

        // ── 끝이 아니라 caret 자리에 꽂힌다 ──────────────────────────────────
        // caret 을 맨 앞으로 옮긴 뒤 포커스를 뺏는다. 크로미움은 포커스를 잃어도 caret 을
        // 기억하므로, 다음 글자는 'hi' 앞에 와야 한다.
        await composer.press('ArrowLeft')
        await composer.press('ArrowLeft')
        await blur(wooi.win)
        await wooi.win.keyboard.press('o')
        await wooi.win.waitForTimeout(200)
        await expectDraft(composer, 'ohi', 'insertion at the remembered caret')

        // ── Backspace 는 데려가기만 하고 넣지 않는다 ─────────────────────────
        await blur(wooi.win)
        await wooi.win.keyboard.press('Backspace')
        await wooi.win.waitForTimeout(200)
        if (!(await isComposerFocused(wooi.win))) {
          throw new Error('Backspace outside the composer did not move focus to it')
        }
        await expectDraft(composer, 'ohi', 'Backspace focusing without inserting')

        console.log(`[e2e] screenshot=${await wooi.shot('typing-redirect')}`)

        // ── 버튼 위에서는 발동하지 않는다 ────────────────────────────────────
        // 단위 테스트는 판정 함수에 가짜 target 을 넣어 확인한다. 여기서는 진짜 버튼에 진짜
        // 포커스를 주고 친다 — event.target 이 실제로 그 버튼으로 오는지까지 걸린다.
        const headerButton = wooi.win.locator('.workspace-header button').first()
        await headerButton.focus()
        await wooi.win.keyboard.press('z')
        await wooi.win.waitForTimeout(200)
        await expectDraft(composer, 'ohi', 'typing while a button has focus')

        // ── '?' 는 기존 단축키 도움말이 먼저 가져간다 ────────────────────────
        // 의도한 절충이다: 이미 있는 단축키를 깨는 쪽이 더 나쁘다. 그 선택이 조용히
        // 뒤집히지 않도록 여기에 못박는다.
        await blur(wooi.win)
        await wooi.win.keyboard.press('?')
        await wooi.win.waitForTimeout(300)
        const shortcuts = wooi.win.getByText('Keyboard shortcuts', { exact: false })
        if ((await shortcuts.count()) === 0) {
          throw new Error("'?' no longer opens the shortcut help — the redirect swallowed it")
        }
        await expectDraft(composer, 'ohi', "'?' opening the help instead of typing")
        await wooi.win.keyboard.press('Escape')

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

function blur(win) {
  return win.evaluate(() => {
    const el = globalThis.document.activeElement
    if (el && el !== globalThis.document.body) el.blur()
  })
}

function isComposerFocused(win) {
  return win.evaluate(
    (selector) => globalThis.document.activeElement === globalThis.document.querySelector(selector),
    COMPOSER
  )
}

async function expectDraft(composer, expected, what) {
  const value = await composer.inputValue()
  if (value !== expected) {
    throw new Error(`${what}: composer held ${JSON.stringify(value)}, wanted "${expected}"`)
  }
}
