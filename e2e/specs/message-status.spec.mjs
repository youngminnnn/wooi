/* global console, process */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'

/**
 * 보낸 메시지의 결말은 **앱을 껐다 켠 뒤에도** 물으면 답이 나와야 한다.
 *
 * 그래서 원장을 `wooi.json` 에 심어 두고 새 프로세스로 띄운다 — 발신 워크스페이스의 대화는
 * 재시작을 넘어 이어지므로, 며칠 전 보낸 것을 묻는 것이 정상 경로다. 유닛 테스트는 함수를
 * 부르지만 여기서는 디스크 → 스토어 → 도구 → 카드까지가 실제로 이어지는지를 본다.
 *
 * 조회 창구는 `/wooi:message-status` 다. direct 명령이라 에이전트 턴도 토큰도 쓰지 않아,
 * 모델을 띄우지 않는 e2e 환경에서 이 기능을 끝까지 밟을 수 있는 유일한 길이기도 하다.
 */

const HOUR = 60 * 60 * 1000

/** 만료 판정은 보관 중인 가장 오래된 항목을 기준으로 하므로, 보관 기간 상수에 기대지 않는다. */
function messageId(at, suffix) {
  return `pm-${at.toString(36)}-${suffix}`
}

async function runCommand(win, text) {
  const box = win.locator('textarea[placeholder^="Message your agent"]')
  // 뒤 공백이 자동완성 메뉴를 닫는다(`slashQuery` 는 공백 없는 `/…` 에만 매치한다).
  // Escape 로 닫으면 안 된다 — 슬래시 메뉴에서 Escape 는 메뉴만 닫는 게 아니라 초안을 통째로
  // 비운다(Composer 의 `if (menuOpen) setText('')`). 인자 없는 `/wooi:message-status` 는
  // 공백이 없어 메뉴가 열리므로 그대로 두면 빈 메시지가 나가고 카드가 영영 뜨지 않는다.
  // command-cards.spec.mjs 와 codex-session-commands.spec.mjs 도 같은 수법을 쓴다.
  await box.fill(`${text} `)
  await box.press('Enter')
  await win.getByText(`/wooi:message-status`, { exact: true }).waitFor()
  const body = win.locator('pre')
  await body.waitFor()
  const parsed = JSON.parse(await body.innerText())
  await box.press('Escape')
  return parsed
}

export default async function 보낸_메시지의_결말을_재시작_뒤에도_조회한다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )

  const now = Date.now()
  const declinedAt = now - 2 * HOUR
  const waitingAt = now - HOUR
  const declined = messageId(declinedAt, 'aaaaaaaa')
  const waiting = messageId(waitingAt, 'bbbbbbbb')
  // 보관 중인 가장 오래된 것보다 앞선 id — 밀려난 것이므로 "모른다" 로 답해야 한다.
  const evicted = messageId(declinedAt - 24 * HOUR, 'cccccccc')
  // 형식은 맞지만 이 워크스페이스가 보낸 적 없는 id — 만료와 구분되어야 한다.
  const neverSent = messageId(now, 'dddddddd')

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          peerSent: [
            {
              id: declined,
              toWorkspaceId: 'ws-peer',
              toName: 'peer workspace',
              excerpt: 'moved the tool registry',
              outcome: 'declined-by-user',
              at: declinedAt,
              outcomeAt: declinedAt + 60_000
            },
            {
              id: waiting,
              toWorkspaceId: 'ws-peer',
              toName: 'peer workspace',
              excerpt: 'renamed the delivery helper',
              outcome: 'waiting-for-user-approval',
              at: waitingAt,
              outcomeAt: waitingAt
            }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // 1. 거절된 메시지를 물으면 거절로 답한다. 아무도 발신자를 깨우지 않았지만, 물으면 나온다.
        const one = await runCommand(wooi.win, `/wooi:message-status ${declined}`)
        if (one.status !== 'declined-by-user' || one.final !== true) {
          throw new Error(`declined message did not report the decline: ${JSON.stringify(one)}`)
        }
        if (one.sentTo?.name !== 'peer workspace') {
          throw new Error(`decline answer lost the recipient: ${JSON.stringify(one)}`)
        }

        // 2. 아직 결말이 나지 않은 것은 final 이 아니다 — 여기서 기다리라고 말하면 안 된다.
        const two = await runCommand(wooi.win, `/wooi:message-status ${waiting}`)
        if (two.status !== 'waiting-for-user-approval' || two.final !== false) {
          throw new Error(`pending message was reported as settled: ${JSON.stringify(two)}`)
        }

        // 3. 밀려난 id 와 보낸 적 없는 id 는 서로 다른 답이다. "모른다" 와 "그런 것 없다" 는 다르다.
        const three = await runCommand(wooi.win, `/wooi:message-status ${evicted}`)
        if (three.status !== 'unknown-expired') {
          throw new Error(`evicted id was not reported as expired: ${JSON.stringify(three)}`)
        }
        const four = await runCommand(wooi.win, `/wooi:message-status ${neverSent}`)
        if (four.status !== 'unknown-no-such-message') {
          throw new Error(`unsent id was not reported as unknown: ${JSON.stringify(four)}`)
        }

        // 4. id 를 잃었을 때(압축이 그렇게 만든다) 인자 없이 부르면 최근 것부터 나열한다.
        const list = await runCommand(wooi.win, '/wooi:message-status')
        const ids = (list.recent ?? []).map((item) => item.messageId)
        if (ids.join(',') !== [waiting, declined].join(',')) {
          throw new Error(`recent list was not newest-first: ${JSON.stringify(list)}`)
        }
        if (list.recent[0].excerpt !== 'renamed the delivery helper') {
          throw new Error(`recent list dropped the excerpt: ${JSON.stringify(list)}`)
        }

        const screenshot = await wooi.shot('message-status')
        console.log(
          `[e2e] statuses=${[one, two, three, four].map((r) => r.status).join(' ')} screenshot=${screenshot}`
        )
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
