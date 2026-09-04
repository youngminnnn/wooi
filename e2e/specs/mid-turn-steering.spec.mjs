/* global console, process, window */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 워크스페이스를 '진행 중' 으로 만든다.
 *
 * status 를 시드하는 것으로는 안 된다 — 부팅 때 남아 있는 'running' 은 직전 크래시의 유령
 * 상태로 보고 idle 로 정규화된다([[main/store]]). 그래서 앱이 뜬 뒤에 상태 방송을 흉내 낸다.
 * 채널 이름은 소스에서 읽는다: 문자열을 박아 두면 IPC 상수가 바뀐 날 조용히 아무것도 검사하지
 * 않게 된다.
 */
async function markRunning(wooi) {
  const typesSource = await readFile(resolve('src/shared/types.ts'), 'utf8')
  const channel = typesSource.match(/evtState:\s*'([^']+)'/)?.[1]
  if (!channel) throw new Error('evtState channel not found')
  const state = await wooi.win.evaluate(() => window.api.getState())
  for (const w of state.workspaces) w.status = 'running'
  await wooi.app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no window to deliver the state to')
      win.webContents.send(payload.channel, payload.state)
    },
    { channel, state }
  )
}

/**
 * 턴이 도는 중에 친 메시지는 더 이상 렌더러 대기 큐에 앉지 않는다 — 두 백엔드 모두 진행 중인
 * 턴에 그대로 밀어 넣는다([[agent/backend]] capabilities.steering).
 *
 * 화면까지 나와야 확인되는 이유: 큐를 걷어낸 흔적은 전부 입력창 주변의 문구와 카드다. 유닛
 * 테스트는 store 에서 큐가 사라진 것만 알 뿐, 실행 중 입력창이 여전히 "Queue a follow-up…" 이라고
 * 말하고 있는지는 못 본다. 실제로 running 상태의 워크스페이스를 그려서 본다.
 *
 * 모델 턴은 돌리지 않는다(e2e 규칙) — markRunning 이 상태 방송을 흉내 내 같은 화면을 만든다.
 */
const STEER_PLACEHOLDER = 'Steer the agent while it works…'
const SEND_BUTTON_TITLE = 'Send now — ⌘Enter stops the current turn first'
const QUEUED_CARD_TITLE = 'Cancel this queued message'

export default async function 실행_중_입력창은_큐가_아니라_steering_을_말한다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch)
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await markRunning(wooi)

        const composer = wooi.win.locator('textarea').first()
        await composer.waitFor()
        await wooi.win.locator(`[title="${SEND_BUTTON_TITLE}"]`).first().waitFor()
        const placeholder = await composer.getAttribute('placeholder')
        if (!placeholder?.startsWith(STEER_PLACEHOLDER)) {
          throw new Error(`running composer did not offer steering: ${JSON.stringify(placeholder)}`)
        }
        if (/queue/i.test(placeholder)) {
          throw new Error(
            `running composer still talks about a queue: ${JSON.stringify(placeholder)}`
          )
        }

        // 전송 버튼도 같은 말을 해야 한다 — 문구가 갈리면 사용자는 둘 중 무엇이 참인지 모른다.
        const sendTitle = await wooi.win
          .locator(`[title="${SEND_BUTTON_TITLE}"]`)
          .first()
          .getAttribute('title')
        if (sendTitle !== SEND_BUTTON_TITLE) {
          throw new Error(
            `send button title was not the steering wording: ${JSON.stringify(sendTitle)}`
          )
        }

        // 큐 카드는 이제 어떤 상태에서도 그려지지 않는다.
        const queuedCards = await wooi.win.locator(`[title="${QUEUED_CARD_TITLE}"]`).count()
        if (queuedCards !== 0) {
          throw new Error(`queued message card is still rendered: ${queuedCards}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('mid-turn-steering')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
