/* global console, process, window */

import {
  dismissToasts,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const PROMPT_NAME = 'Review'
const PROMPT_BODY = 'Review the diff on this branch and list only real defects.'

/**
 * 리포에 저장해 둔 프롬프트를 등록하고 컴포저에서 꺼내 쓰는 길을 끝까지 밟는다.
 *
 * 유닛 테스트는 채우는 규칙(appendPrompt)과 스키마가 옳다는 것까지만 말해 준다. 여기서 값진 것은
 * **사용자가 실제로 밟는 경로**다 — 리포 설정에 프롬프트 자리가 있는지, 저장이 리포에 남는지,
 * 컴포저의 피커가 그것을 보여 주는지.
 *
 * 그리고 이 기능의 계약 하나를 여기서만 확인할 수 있다: **고르는 것은 전송이 아니다.** 골랐을 때
 * 입력창이 채워지고 그대로 남아 있어야 한다. 보내 버리면 입력창은 비고 시키지도 않은 턴이 시작되는데,
 * 그 차이는 렌더러 유닛 테스트로는 잡히지 않는다.
 */
export default async function 저장한_프롬프트를_컴포저에서_꺼내_쓴다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const win = wooi.win
        await openSeededWorkspace(win)

        // 아직 저장된 것이 없으면 컴포저에 피커를 그리지 않는다 — 빈 목록으로 가는 버튼은
        // 좁은 줄에서 자리만 차지한다.
        const picker = win.locator('[aria-label="Insert a saved prompt"]')
        if ((await picker.count()) !== 0) {
          throw new Error('저장된 프롬프트가 없는데 컴포저에 피커가 떠 있다')
        }

        // 1. 리포 설정에 프롬프트를 등록한다.
        await win.locator('[data-tour="repo-settings"]').first().click()
        const dialog = win.locator('[role="dialog"]')
        await dialog.waitFor({ timeout: 5000 })
        await dialog.getByText('Saved prompts').first().waitFor({ timeout: 5000 })
        await dialog.getByRole('button', { name: '+ Add prompt' }).click()
        await dialog.getByLabel('Prompt 1 name').fill(PROMPT_NAME)
        await dialog.getByLabel('Prompt 1 text').fill(PROMPT_BODY)
        console.log(`[e2e] screenshot=${await wooi.shot('saved-prompts-editor')}`)
        // 토스트가 모달 푸터를 덮고 있으면 저장 버튼을 영영 못 누른다.
        await dismissToasts(win)
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await dialog.waitFor({ state: 'detached', timeout: 10_000 })

        // 2. 리포에 남는다 — 새 저장소가 아니라 Repo 레코드에 붙는다.
        const stored = await win.evaluate(async () => {
          const state = await window.api.getState()
          return state.repos[0]?.savedPrompts ?? null
        })
        if (!stored || stored.length !== 1) {
          throw new Error(`저장된 프롬프트가 리포에 남지 않았다: ${JSON.stringify(stored)}`)
        }
        if (stored[0].name !== PROMPT_NAME || stored[0].prompt !== PROMPT_BODY) {
          throw new Error(`저장된 값이 다르다: ${JSON.stringify(stored[0])}`)
        }

        // 3. 컴포저의 피커에 뜨고, 고르면 입력창이 채워진다.
        await picker.waitFor({ timeout: 10_000 })
        await picker.click()
        const entry = win.getByRole('button', { name: new RegExp(PROMPT_NAME) }).last()
        await entry.waitFor({ timeout: 5000 })
        console.log(`[e2e] screenshot=${await wooi.shot('saved-prompts-picker')}`)
        await entry.click()

        const composer = win.getByPlaceholder('Message your agent…')
        await composer.waitFor({ timeout: 5000 })

        // 4. 계약: 채우기만 하고 보내지 않는다. 보냈다면 입력창은 비어 있을 것이다.
        const filled = await composer.inputValue()
        if (filled !== PROMPT_BODY) {
          throw new Error(`컴포저가 프롬프트로 채워지지 않았다: ${JSON.stringify(filled)}`)
        }
        const status = await win.evaluate(async () => {
          const state = await window.api.getState()
          return state.workspaces[0]?.status ?? null
        })
        if (status !== 'idle') {
          throw new Error(`프롬프트를 고른 것만으로 턴이 시작됐다: ${JSON.stringify(status)}`)
        }
        console.log(`[e2e] screenshot=${await wooi.shot('saved-prompts-filled-composer')}`)

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
