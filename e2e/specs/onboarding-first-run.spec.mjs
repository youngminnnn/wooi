/* global console, process */

import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/** 예전 첫 실행 투어의 1단계 문구. 이게 다시 보이면 일괄 소개가 부활한 것이다. */
const TOUR_COPY = 'This quick tour points out where everything lives'

/** 현재 화면에 투어가 끼어들지 않았는지 확인한다. 단계마다 부른다 — 끝에서 한 번만 보면
 *  중간에 스쳐 지나간 투어를 놓친다. */
async function assertNoTour(win, step) {
  if (await win.getByText(TOUR_COPY, { exact: false }).count()) {
    throw new Error(`feature tour reappeared during first run at step: ${step}`)
  }
}

/**
 * 첫 실행이 동의 → 연결 → 기본값 **세 화면**으로 끝나고, 7단계 스포트라이트 투어가 그 사이에
 * 끼어들지 않는지 못 박는다.
 *
 * 투어를 첫 실행에서 뺀 것이 이 변경의 핵심인데, 그 사실을 지키는 검사가 없으면 누군가
 * `OnboardingModal` 에 단계를 하나 되돌려 놓아도 타입도 유닛 테스트도 통과한다.
 */
export default async function 첫_실행이_세_화면으로_끝나고_투어가_없다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      // firstRun: 온보딩 플래그 세 개를 아예 쓰지 않아 진짜 첫 실행이 된다.
      seed: (scratch) => seedAppState(scratch, { firstRun: true })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        const win = wooi.win

        // ── 1. 동의 ─────────────────────────────────────────────────
        await win.getByText('Before you start').waitFor()
        await assertNoTour(win, 'consent')

        const consentBox = win.locator('input[type="checkbox"]').first()
        const continueBtn = win.locator('button', { hasText: /^Continue$/ }).first()
        if (!(await continueBtn.isDisabled())) {
          throw new Error('Continue was enabled before the terms checkbox was checked')
        }
        await consentBox.check()
        if (await continueBtn.isDisabled()) {
          throw new Error('Continue stayed disabled after the terms checkbox was checked')
        }
        await continueBtn.click()

        // ── 2. 연동 ─────────────────────────────────────────────────
        await win.getByText('Connect a coding agent to get started').waitFor()
        await assertNoTour(win, 'integrations')
        console.log(`[e2e] screenshot=${await wooi.shot('onboarding-integrations')}`)

        // 에이전트 연결 여부와 무관하게 진행할 수 있어야 한다(둘 중 하나만 있어도 정상 사용자다).
        await win
          .locator('button', { hasText: /^(Get started|Skip for now)$/ })
          .last()
          .click()

        // ── 3. 기본값 ───────────────────────────────────────────────
        await win.getByText('Make it yours').waitFor()
        await assertNoTour(win, 'preferences')

        // 기본 에이전트 UI 는 **이 머신에서 실제로 쓸 수 있는 백엔드 수**를 따른다. 기대값을
        // 박아 두면 CLI 가 하나만 깔린 기계에서 스펙이 거짓으로 깨진다 — IPC 에 직접 묻는다.
        const backends = await win.evaluate(() => globalThis.api.agent.listBackends())
        const available = backends.filter((b) => b.available)
        const radioCount = await win.locator('button', { hasText: /^(Claude Code|Codex)$/ }).count()
        const singleLine = await win.getByText(/^Using /).count()
        const modeQuestion = await win.getByText('How much can the agent do on its own?').count()

        if (available.length > 1) {
          if (radioCount !== available.length) {
            throw new Error(
              `expected ${available.length} default-agent choices, rendered ${radioCount}`
            )
          }
        } else if (available.length === 1) {
          if (radioCount !== 0 || singleLine !== 1) {
            throw new Error(
              `single available backend should render one line and no choices; ` +
                `choices=${radioCount} line=${singleLine}`
            )
          }
        } else if (radioCount !== 0 || singleLine !== 0 || modeQuestion !== 0) {
          // 백엔드가 없으면 권한 모드 질문도 함께 사라져야 한다 — 예전에는 빈 컨트롤이 남았다.
          throw new Error(
            `no available backend should hide both fields; ` +
              `choices=${radioCount} line=${singleLine} modeQuestion=${modeQuestion}`
          )
        }
        if (available.length > 0 && modeQuestion !== 1) {
          throw new Error(`permission-mode question missing with ${available.length} backends`)
        }

        // 테마는 **고르는 즉시** 적용돼야 한다. 이 라이브 프리뷰가 테마를 온보딩에 둔 이유라,
        // 저장 뒤가 아니라 이 화면에서 확인한다.
        await win
          .locator('button', { hasText: /^Light$/ })
          .first()
          .click()
        await win.waitForFunction(
          () => globalThis.document.documentElement.getAttribute('data-theme') === 'light'
        )
        console.log(`[e2e] screenshot=${await wooi.shot('onboarding-preferences-light')}`)

        // ── 4. 저장 ─────────────────────────────────────────────────
        await win.locator('button', { hasText: /^Start using Wooi$/ }).click()
        // 모달이 사라지는 것이 저장 완료 신호다(설정 갱신이 곧 닫힘 조건이다).
        await win.getByText('Make it yours').waitFor({ state: 'detached' })
        const { settings } = await win.evaluate(() => globalThis.api.getState())

        if (!settings.onboarded || !settings.pickedDefaults) {
          throw new Error(
            `onboarding flags were not persisted: ${JSON.stringify({
              onboarded: settings.onboarded,
              pickedDefaults: settings.pickedDefaults
            })}`
          )
        }
        if (settings.theme !== 'light') {
          throw new Error(`chosen theme was not saved: ${JSON.stringify(settings.theme)}`)
        }
        if (available.length > 0 && !available.some((b) => b.id === settings.defaultAgentBackend)) {
          throw new Error(
            `saved default agent ${JSON.stringify(settings.defaultAgentBackend)} is not available ` +
              `(${available.map((b) => b.id).join(', ')})`
          )
        }

        console.log(`[e2e] screenshot=${await wooi.shot('onboarding-done')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
