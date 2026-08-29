/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 이 PR 이 더한 두 설정이 **저장 파일을 오간 뒤에도** 살아 있는지 본다.
 *
 * 둘 다 옵셔널 필드라 스키마 버전을 올리지 않았다. 그 선택이 맞으려면 두 방향이 모두 성립해야
 * 하는데, 둘 다 jsdom 으로는 증명할 수 없다 — 저장·로드는 메인 프로세스에 있고 재시작이 필요하다.
 *
 *  1. 필드가 **없는** 파일(기존 사용자)이 올라오면 기본값 병합이 채운다.
 *  2. 화면에서 고친 값이 재시작 뒤에도 남는다.
 */

const QUIET_SWITCH = 'Stay quiet for the workspace I’m watching'
const ENV_KEY = 'E2E_PROXY'
const ENV_VALUE = 'http://localhost:8080'

/** 설정 모달을 연다(렌더러의 openSettings 와 같은 경로). 모달이 이미 떠 있으면 no-op 이다. */
async function openSettings(win, page) {
  await win.evaluate((target) => {
    globalThis.localStorage.setItem('settings.lastPage', target)
    globalThis.dispatchEvent(new globalThis.CustomEvent('wooi:open-settings'))
  }, page)
}

const settingsOf = (win) => win.evaluate(async () => (await globalThis.api.getState()).settings)

export default async function 에이전트_환경변수와_포커스_억제_설정이_재시작을_넘긴다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const first = await launchWooi({ appDir: process.cwd(), ...scratch })
      let backend
      try {
        // 시드는 settings 에 세 키만 적는다 — suppressWhenFocused 가 없는 파일이다.
        // 그런 파일이 올라올 때 기본값 병합이 켜 두는 것이 이 필드의 하위호환 계약이다.
        const seeded = await settingsOf(first.win)
        if (seeded.suppressWhenFocused !== true) {
          throw new Error(
            `a settings file without suppressWhenFocused should default to true, got ${JSON.stringify(seeded.suppressWhenFocused)}`
          )
        }
        backend = seeded.defaultAgentBackend

        // ── 환경 변수를 화면에서 더한다 ──
        await openSettings(first.win, 'agents')
        await first.win.getByRole('button', { name: 'Add variable' }).click()
        await first.win.getByLabel('Variable name').fill(ENV_KEY)
        await first.win.getByLabel('Variable value').fill(ENV_VALUE)

        await first.win.waitForFunction(
          async ([id, key, value]) =>
            (await globalThis.api.getState()).settings.agents?.[id]?.env?.[key] === value,
          [backend, ENV_KEY, ENV_VALUE]
        )

        // 막힌 키는 조용히 버리지 않는다 — 그 자리에서 이유를 보여 주는 것이 이 기능의 계약이다.
        await first.win.getByRole('button', { name: 'Add variable' }).click()
        await first.win.getByLabel('Variable name').last().fill('PATH')
        const warning = first.win.getByText('Wooi sets PATH itself')
        await warning.waitFor()

        // 경고만 띄우고 끝나면 안 된다. 저장된 맵에는 들어가되(사용자가 친 그대로 보여야 하므로)
        // 주입 직전 sanitizeAgentEnv 가 떨어뜨린다 — 여기서는 정상 키가 살아 있는지만 다시 본다.
        const afterBlocked = await settingsOf(first.win)
        if (afterBlocked.agents[backend].env?.[ENV_KEY] !== ENV_VALUE) {
          throw new Error(
            `the valid variable was lost after typing a blocked one: ${JSON.stringify(afterBlocked.agents[backend].env)}`
          )
        }
        console.log(`[e2e] screenshot=${await first.shot('agent-env-blocked-key')}`)

        // ── 포커스 억제를 끈다 ──
        await first.win.getByRole('button', { name: 'Notifications' }).click()
        await first.win.getByRole('switch', { name: QUIET_SWITCH }).click()
        await first.win.waitForFunction(
          async () => (await globalThis.api.getState()).settings.suppressWhenFocused === false
        )
        console.log(`[e2e] screenshot=${await first.shot('notifications-focus-toggle')}`)

        // ── 새 IPC 두 개가 실제로 메인까지 닿는가 ──
        // 보고 있는 워크스페이스는 렌더러 메모리에만 있어서, 이 채널이 끊기면 포커스 억제는
        // 조용히 "아무것도 안 보고 있음" 으로 굳는다 — 화면에는 아무 증상이 없다.
        const skip = await first.win.evaluate(async () => {
          await globalThis.api.notify.setViewing('ws-e2e')
          await globalThis.api.notify.setViewing(null)
          return globalThis.api.notify.lastSkip()
        })
        if (skip !== null && typeof skip?.reason !== 'string') {
          throw new Error(`notify.lastSkip returned an unexpected shape: ${JSON.stringify(skip)}`)
        }
      } finally {
        await first.close()
      }

      // ── 재시작 ──
      const restarted = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const settings = await settingsOf(restarted.win)
        if (settings.agents?.[backend]?.env?.[ENV_KEY] !== ENV_VALUE) {
          throw new Error(
            `agent env did not survive a restart: ${JSON.stringify(settings.agents?.[backend]?.env)}`
          )
        }
        if (settings.suppressWhenFocused !== false) {
          throw new Error(
            `suppressWhenFocused did not survive a restart, got ${JSON.stringify(settings.suppressWhenFocused)}`
          )
        }
        console.log(`[e2e] screenshot=${await restarted.shot('settings-after-restart')}`)
        await waitForInspection(restarted.win)
      } finally {
        await restarted.close()
      }
    }
  )
}
