/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 대화 밀도 — ⌃O 로 Summary / Normal / Verbose 를 돈다.
 *
 * 렌더러 단위 테스트가 이미 "무엇이 보이고 무엇이 접히는가" 를 증명한다. 여기서 볼 것은 그
 * 판정이 아니라 **판정을 감싸는 배선**이다:
 *
 * - ⌃O 가 진짜 창의 전역 keydown 에서 시작해 대화까지 닿는가(그리고 입력 중에는 안 닿는가).
 * - 상태줄 칩 → 선택 카드 → 값 적용의 클릭 경로가 이어지는가.
 * - 밀도가 **앱을 껐다 켜도** 그 워크스페이스에 남는가. 스토어 초기값이 localStorage 를 한 번에
 *   읽는 구조라, 이건 실제로 두 번 띄워 봐야만 증명된다.
 * - 설정의 전역 기본값이 **아직 고르지 않은 워크스페이스**에 닿는가. 값이 main 의 설정과 renderer
 *   의 localStorage 두 곳에 나뉘어 살아서, 이 둘을 잇는 배선은 여기서만 확인된다.
 */
const AGENT_REPLY = 'Parser is strict now.'
const READ_TAIL = 'read-output-tail-line'
const DIFF_LINE = '+const parse = (s: string): Ast'

/** 접기 한도(FOLD.lines=3)를 확실히 넘겨, 접힌 상태와 펴진 상태가 눈에 띄게 다르도록. */
const READ_OUTPUT = [
  'line one',
  'line two',
  'line three',
  'line four',
  'line five',
  READ_TAIL
].join('\n')

export default async function 대화_밀도는_세_단계를_돌고_재시작과_전역_기본값을_넘어_남는다() {
  const now = Date.now()
  const transcript = [
    { id: 'user-1', type: 'user', text: 'make the parser strict', ts: now - 8 },
    { id: 'think-1', type: 'thinking', text: 'weighing two shapes for the AST', ts: now - 7 },
    // 연속 조회 두 건이라 묶음 카드 한 줄로 접힌다 — 밀도가 묶음까지 다루는지 함께 본다.
    {
      id: 'use-read-1',
      type: 'tool_use',
      name: 'Read',
      input: { file_path: 'src/parser.ts' },
      toolId: 'call-read-1',
      ts: now - 6
    },
    {
      id: 'res-read-1',
      type: 'tool_result',
      toolId: 'call-read-1',
      text: READ_OUTPUT,
      isError: false,
      ts: now - 5
    },
    {
      id: 'use-read-2',
      type: 'tool_use',
      name: 'Read',
      input: { file_path: 'src/ast.ts' },
      toolId: 'call-read-2',
      ts: now - 4
    },
    {
      id: 'res-read-2',
      type: 'tool_result',
      toolId: 'call-read-2',
      text: 'second read output',
      isError: false,
      ts: now - 3
    },
    {
      id: 'use-edit-1',
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: 'src/parser.ts' },
      toolId: 'call-edit-1',
      diff: `--- a/src/parser.ts\n+++ b/src/parser.ts\n-const parse = (s)\n${DIFF_LINE}`,
      ts: now - 2
    },
    {
      id: 'res-edit-1',
      type: 'tool_result',
      toolId: 'call-edit-1',
      text: 'The file has been updated.',
      isError: false,
      ts: now - 1
    },
    { id: 'assistant-1', type: 'assistant', text: AGENT_REPLY, ts: now }
  ]

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const win = wooi.win
        await win.locator('[data-item-id="assistant-1"]').waitFor()

        // ── 기본은 Normal — 지금까지의 화면 그대로 ────────────────────────────
        await expectDensity(win, 'Normal')
        await expectVisible(win, 'use-read-1', 'the folded tool group')
        await expectVisible(win, 'think-1', 'the thinking card')
        await expectText(win, DIFF_LINE, 'the inline diff')
        // 묶음이 접혀 있으니 그 안의 출력은 아직 화면에 없다.
        await expectNoText(win, READ_TAIL, 'the folded tool output')

        // ── ⌃O 는 입력 중에는 듣지 않는다 ────────────────────────────────────
        // 안 그러면 지시를 치다 누른 ⌃O 가 읽던 대화를 말없이 다시 접는다.
        await win.locator('textarea').first().focus()
        await win.keyboard.press('Control+o')
        await win.waitForTimeout(200)
        await expectDensity(win, 'Normal')

        // ── ⌃O → Verbose: 모든 중간 단계가 펴진다 ────────────────────────────
        await blurComposer(win)
        await win.keyboard.press('Control+o')
        await expectDensity(win, 'Verbose')
        await expectText(win, READ_TAIL, 'the expanded tool output')
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-density-verbose')}`)

        // ── ⌃O → Summary: 최종 응답과 바꾼 것만 남는다 ───────────────────────
        await win.keyboard.press('Control+o')
        await expectDensity(win, 'Summary')
        await expectText(win, AGENT_REPLY, 'the final reply')
        await expectText(win, 'make the parser strict', 'the user turn')
        await expectVisible(win, 'use-edit-1', 'the file change')
        await expectGone(win, 'use-read-1', 'the tool group')
        await expectGone(win, 'use-read-2', 'the grouped tool call')
        await expectGone(win, 'think-1', 'the thinking card')
        // 바꾼 것은 남되 diff 원문은 접는다 — Summary 는 변경 "목록" 이다.
        await expectNoText(win, DIFF_LINE, 'the inline diff')
        // 성긴 화면이 고장이 아니라 밀도 때문임을 화면이 말해 준다.
        await expectText(win, 'Summary hides', 'the hidden-step notice')
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-density-summary')}`)

        // ── ⌃O 한 번 더면 제자리 ─────────────────────────────────────────────
        await win.keyboard.press('Control+o')
        await expectDensity(win, 'Normal')
        await expectVisible(win, 'think-1', 'the thinking card')

        // ── 상태줄 칩 → 선택 카드 → 적용 ─────────────────────────────────────
        await densityChip(win).click()
        await win.getByText('/density').waitFor()
        await win.getByText('Final replies and file changes only').click()
        await expectDensity(win, 'Summary')
        await expectGone(win, 'think-1', 'the thinking card')

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }

      // ── 밀도는 재시작을 넘어 그 워크스페이스에 남는다 ─────────────────────
      const restarted = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(restarted.win)
        await restarted.win.locator('[data-item-id="assistant-1"]').waitFor()
        await expectDensity(restarted.win, 'Summary')
        await expectGone(restarted.win, 'think-1', 'the thinking card')

        const remembered = await restarted.win.evaluate(() =>
          globalThis.localStorage.getItem('wooi.transcriptDensity.ws-e2e')
        )
        if (remembered !== 'summary') {
          throw new Error(
            `the density was not remembered per workspace: ${JSON.stringify(remembered)}`
          )
        }
        console.log(`[e2e] screenshot=${await restarted.shot('transcript-density-after-restart')}`)

        // ── 전역 기본값은 "아직 고르지 않은" 워크스페이스에만 닿는다 ─────────
        // 이 워크스페이스는 Summary 를 골라 뒀으므로 전역을 Verbose 로 바꿔도 꿈쩍하지 않는다.
        await setDefaultDensity(restarted.win, 'verbose')
        await expectDensity(restarted.win, 'Summary', { quietAt: 'Verbose' })
        await expectGone(restarted.win, 'think-1', 'the thinking card')

        // 전역 기본값과 **같은** 값을 고르는 것은 "안 고름" 이다 — 기억해 둔 값을 지운다.
        await blurComposer(restarted.win)
        await restarted.win.keyboard.press('Control+o') // Summary → Normal
        await restarted.win.keyboard.press('Control+o') // Normal → Verbose
        await expectDensity(restarted.win, 'Verbose', { quietAt: 'Verbose' })
        const cleared = await restarted.win.evaluate(() =>
          globalThis.localStorage.getItem('wooi.transcriptDensity.ws-e2e')
        )
        if (cleared !== null) {
          throw new Error(
            `choosing the global default should clear the per-workspace value, but it kept ${JSON.stringify(cleared)}`
          )
        }

        // 지워 뒀기 때문에, 설정을 다시 바꾸면 재시작 없이 따라온다. 이것이 새 워크스페이스가
        // 고른 밀도로 시작하는 것과 같은 배선이다.
        await setDefaultDensity(restarted.win, 'summary')
        await expectDensity(restarted.win, 'Summary', { quietAt: 'Summary' })
        await expectGone(restarted.win, 'think-1', 'the thinking card')
        console.log(`[e2e] screenshot=${await restarted.shot('transcript-density-global-default')}`)

        await waitForInspection(restarted.win)
      } finally {
        await restarted.close()
      }
    }
  )
}

/** 상태줄의 밀도 칩. 제목으로 잡아, 라벨 문구가 바뀌어도 스펙이 엉뚱한 것을 집지 않게. */
function densityChip(win) {
  return win.locator('[title^="Conversation density: "]')
}

/**
 * 설정의 전역 기본 밀도를 바꾼다. 새 워크스페이스가 어디서 시작할지를 정하는 값이라, 밟을 길이
 * 설정 화면뿐이다.
 */
async function setDefaultDensity(win, density) {
  await win.evaluate(() =>
    globalThis.dispatchEvent(
      new globalThis.CustomEvent('wooi:open-settings', { detail: 'general' })
    )
  )
  await win.locator(`[data-default-density="${density}"]`).click()
  await win.getByRole('button', { name: 'Close settings' }).click()
  const saved = await win.evaluate(async () => (await globalThis.api.getState()).settings)
  if (saved.defaultTranscriptDensity !== density) {
    throw new Error(
      `the default density was not persisted through main: ${JSON.stringify(saved.defaultTranscriptDensity)}`
    )
  }
}

/**
 * 값은 제목에서 읽는다. 상태줄은 **기본값일 때 글자를 적지 않기 때문이다** — 폭을 아끼려고
 * 아이콘만 남기므로(`status-line-fit`), 보이는 글자로 값을 물으면 기본값을 빈 문자열로 읽는다.
 * 글자로 말하는지 아닌지는 그 자체가 계약이라 함께 확인한다.
 *
 * 그 "조용한 값" 은 상수가 아니라 설정의 전역 기본값이다 — `quietAt` 으로 지금 무엇이 기본인지
 * 일러 준다. 상태줄이 강조하는 것은 "Normal 이 아님" 이 아니라 "내가 정한 기본에서 벗어남" 이다.
 */
async function expectDensity(win, label, { quietAt = 'Normal' } = {}) {
  const chip = densityChip(win)
  await chip.waitFor()
  const title = (await chip.getAttribute('title')) ?? ''
  const said = title.slice('Conversation density: '.length).split(' — ')[0]
  if (said !== label) {
    throw new Error(`the status line said the density was ${said}, expected ${label}`)
  }
  const text = (await chip.innerText()).trim()
  const shouldSpeak = label !== quietAt
  if (shouldSpeak !== (text === label)) {
    throw new Error(
      `${label} density ${shouldSpeak ? 'should be' : 'should not be'} spelled out, ` +
        `but the chip read ${JSON.stringify(text)}`
    )
  }
}

/**
 * 입력창에서 포커스를 뺀다 — ⌃O 는 입력 중에는 듣지 않기 때문이다(바로 위에서 그 사실을
 * 확인한다). 워크스페이스를 열면 입력창이 포커스를 가져가므로 매번 필요하다.
 */
async function blurComposer(win) {
  await win.evaluate(() => globalThis.document.activeElement?.blur())
}

async function expectVisible(win, itemId, what) {
  const count = await win.locator(`[data-item-id="${itemId}"]`).count()
  if (count === 0) throw new Error(`${what} was missing from the transcript`)
}

async function expectGone(win, itemId, what) {
  const count = await win.locator(`[data-item-id="${itemId}"]`).count()
  if (count > 0) throw new Error(`${what} was still in the transcript`)
}

async function expectText(win, text, what) {
  const count = await win.getByText(text, { exact: false }).count()
  if (count === 0) throw new Error(`${what} was not on screen (looked for ${JSON.stringify(text)})`)
}

async function expectNoText(win, text, what) {
  const count = await win.getByText(text, { exact: false }).count()
  if (count > 0) throw new Error(`${what} was on screen (found ${JSON.stringify(text)})`)
}
