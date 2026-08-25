/* global console, process */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'

/**
 * 세션 재시작을 둘러싼 두 안내가 **화면에 실제로 보이는지**, 그리고 모델·effort 선택이
 * 워크스페이스 상태에 어떻게 반영되는지를 실제 앱에서 고정한다.
 *
 * 두 안내(자동 재시도 · 큰 세션 resume)는 세션이 `type: 'system'` 항목으로 트랜스크립트에
 * 남긴다. 무엇이 그것을 **띄우는지**는 유닛 테스트가 고정하므로(session.autoRetryNotice /
 * session.preflight), 여기서 확인할 것은 그 문장이 앱에서 읽히느냐다 — 조용하던 일을 말로
 * 바꾼 변경이라, 말이 화면에 안 보이면 고친 것이 없는 것과 같다.
 *
 * 모델 변경은 이제 세션을 버리지 않고 살아 있는 query 에 `setModel` 을 보낸다. 그 차이는 라이브
 * 세션이 있어야만 관측되고 라이브 세션은 진짜 CLI 를 띄워야 하므로(모델 턴을 돌리지 않는다는
 * 원칙과 부딪힌다), 여기서는 라이브 세션 없이도 결정적인 것만 본다 — 고른 값이 워크스페이스에
 * 남고, **이미 고른 값을 다시 골라도 상태가 흔들리지 않는다**(재선택 가드).
 */

const now = Date.now()

/** 세션이 실제로 emit 하는 두 안내. 문구가 바뀌면 이 스펙이 먼저 깨지도록 그대로 적는다. */
const AUTO_RETRY_NOTICE =
  'The turn failed before the agent said anything. Wooi restarted the agent and sent your ' +
  'message again — the first attempt may already have been billed.'
const RESUME_SIZE_NOTICE =
  'Picking this conversation back up restores about 120k tokens of context from disk. ' +
  'Use /clear to start fresh if you no longer need the history.'

const transcript = [
  { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: now - 3 },
  { id: 'system:resume-size:1', type: 'system', text: RESUME_SIZE_NOTICE, ts: now - 2 },
  { id: 'system:auto-retry:1', type: 'system', text: AUTO_RETRY_NOTICE, ts: now - 1 },
  { id: 'assistant-e2e', type: 'assistant', text: 'Ready without a model turn.', ts: now }
]

function expectEquals(actual, expected, subject) {
  if (actual !== expected) {
    throw new Error(
      `${subject}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

/** 상태줄 칩을 눌러 선택 카드를 연다(칩의 title 이 문구·클래스보다 안정적이다). */
async function openPicker(win, chipTitlePrefix) {
  await win.locator(`button[title^="${chipTitlePrefix}"]`).click()
  const card = win.locator('div.absolute.bottom-full.max-h-96')
  await card.waitFor()
  return card
}

async function pick(win, chipTitlePrefix, optionLabel) {
  const card = await openPicker(win, chipTitlePrefix)
  await card.getByRole('button', { name: optionLabel, exact: false }).first().click()
  await card.waitFor({ state: 'detached' })
}

const workspaceState = (win) =>
  win.evaluate(async () => {
    const state = await globalThis.api.getState()
    const ws = state.workspaces.find((w) => w.id === 'ws-e2e')
    return { model: ws.model, effort: ws.effort, status: ws.status, sessionId: ws.sessionId }
  })

export default async function 재시작_안내가_보이고_모델_선택이_상태에_남는다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        await seedAppState(scratch, { transcript })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.locator('textarea[placeholder^="Message your agent"]').waitFor()

        // ── 두 안내가 트랜스크립트에서 읽힌다 ────────────────────────────────
        // getByText 는 정규화된 텍스트로 찾으므로, 줄바꿈으로 접히더라도 문장이 온전하면 잡힌다.
        await wooi.win.getByText(RESUME_SIZE_NOTICE).waitFor()
        await wooi.win.getByText(AUTO_RETRY_NOTICE).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('session-restart-notices')}`)

        // ── 모델 선택이 워크스페이스에 남는다 ────────────────────────────────
        const before = await workspaceState(wooi.win)
        expectEquals(before.model, null, 'seeded model')

        await pick(wooi.win, 'Model:', 'Haiku 4.5')
        const afterModel = await workspaceState(wooi.win)
        expectEquals(afterModel.model, 'claude-haiku-4-5', 'model after picking')
        // 세션 id 는 그대로다 — 모델을 바꿔도 이어갈 대화를 놓지 않는다.
        expectEquals(afterModel.sessionId, before.sessionId, 'sessionId after model change')
        console.log(`[e2e] screenshot=${await wooi.shot('session-restart-model-picked')}`)

        // ── 같은 값을 다시 골라도 상태가 흔들리지 않는다(재선택 가드) ────────
        // 예전에는 이 한 번이 멀쩡한 세션을 버렸다. main 의 가드는 값이 같으면 아무것도 하지
        // 않으므로, 여기서 보이는 것은 "달라진 게 없다" 뿐이다.
        await pick(wooi.win, 'Model:', 'Haiku 4.5')
        const afterSame = await workspaceState(wooi.win)
        expectEquals(afterSame.model, 'claude-haiku-4-5', 'model after re-picking the same value')
        expectEquals(afterSame.sessionId, before.sessionId, 'sessionId after re-picking')
        expectEquals(afterSame.status, before.status, 'status after re-picking')

        // ── effort 도 같은 가드를 받는다(이쪽은 여전히 세션을 다시 연다) ─────
        await pick(wooi.win, 'Reasoning effort:', 'High')
        expectEquals((await workspaceState(wooi.win)).effort, 'high', 'effort after picking')

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
