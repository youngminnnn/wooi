/* global console, process */

import {
  E2E_WORKSPACE_DISPLAY_NAME,
  openSeededWorkspace,
  seedAppState,
  sendPermissionRequest,
  waitForInspection
} from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 상태 변화가 **실제로 소리로 나가는지**를 앱을 띄워 확인한다.
 *
 * 왜 이 스펙이 있나: 이 기능은 화면에 아무것도 그리지 않는다. 유일한 호스트가 `App.tsx` 에서
 * 조용히 빠지거나 스토어를 잘못 구독해도 눈으로는 영영 알 수 없고, 다음에 이 파일을 지나가는
 * 사람은 리전이 죽은 줄도 모른 채 지나간다.
 *
 * jsdom 으로는 부족하다. `lib/announce.test.ts` 는 문장을 **고르는 규칙**을,
 * `LiveRegion.test.tsx` 는 컴포넌트 하나를 따로 렌더해 배선을 본다 — 둘 다
 * "App.tsx 가 이 호스트를 마운트하는가" 와 "메인이 IPC 로 보낸 권한 요청이 스토어를 거쳐
 * 리전까지 닿는가" 는 볼 수 없다. 그 두 자리가 정확히 이 기능이 조용히 죽는 자리다.
 *
 * 모델 턴은 돌리지 않는다 — 승인 카드는 `sendPermissionRequest` 로 메인의 이벤트를 그대로
 * 흉내 내 띄운다(pending-ask-summary 스펙과 같은 길).
 */
const QUESTION = 'Which auth method should we use?'

export default async function 상태_변화가_스크린리더에게_소리로_나간다() {
  await withScratchRepo(
    { worktrees: ['feature-test'], seed: (scratch) => seedAppState(scratch) },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const { win } = wooi
      try {
        // 리전은 **요소가 먼저 DOM 에 있어야** 그 뒤의 텍스트 변경을 사건으로 인식한다.
        // 조건부로 마운트하면 첫 알림이 통째로 사라지므로, 빈 채로 떠 있는지부터 본다.
        const polite = win.locator('[data-live-region][aria-live="polite"]')
        const alert = win.locator('[data-live-region="alert"][aria-live="assertive"]')
        await alert.waitFor()

        const politeCount = await polite.count()
        if (politeCount !== 2) {
          throw new Error(
            `polite 라이브 리전은 둘(턴·토스트)이어야 한다 — ${politeCount} 개다. ` +
              '하나로 합치면 같은 틱의 두 사건 중 나중 것이 앞 것을 덮어써 조용히 사라진다.'
          )
        }

        // 켜자마자 지금 상태를 한 번 읊는 것은 변화의 통지가 아니라 잡음이다.
        const initial = (await alert.innerText()).trim()
        if (initial !== '') {
          throw new Error(`라이브 리전은 초기 내용을 읽지 않아야 한다 — ${JSON.stringify(initial)}`)
        }

        // 여기서 워크스페이스가 선택되고, 그 시점이 기준선(첫 스냅샷)이 된다. 권한 요청은
        // **그 뒤에** 보내야 한다 — 먼저 보내면 대기 상태가 첫 스냅샷이 되어(설계대로) 침묵한다.
        await openSeededWorkspace(win)

        await sendPermissionRequest(wooi.app, {
          requestId: 'req-e2e-live-region',
          workspaceId: 'ws-e2e',
          toolName: 'AskUserQuestion',
          kind: 'question',
          input: {
            questions: [
              {
                header: 'Auth',
                question: QUESTION,
                options: [
                  { label: 'OAuth', description: 'Delegate to the provider' },
                  { label: 'Session cookies', description: 'Keep it in our own database' }
                ]
              }
            ]
          }
        })

        // 사용자의 응답을 기다리는 상태다 — 읽던 것을 끊고 알려야 하므로 assertive 쪽으로 간다.
        const expected = `${E2E_WORKSPACE_DISPLAY_NAME} needs your input: ${QUESTION}`
        await alert.filter({ hasText: 'needs your input' }).waitFor()
        const spoken = (await alert.innerText()).trim()
        if (spoken !== expected) {
          throw new Error(
            `assertive 리전의 문장이 다르다.\n  기대: ${JSON.stringify(expected)}\n  실제: ${JSON.stringify(spoken)}`
          )
        }

        // 무엇을 묻는지까지 읽어야 한다 — "입력이 필요합니다" 만으로는 다섯 개가 동시에 물을 때
        // 어느 것을 먼저 볼지 정할 수 없다(pending-ask-summary 가 눈으로 보는 것과 같은 사실).
        if (!spoken.includes(QUESTION)) {
          throw new Error(`무엇을 묻는지가 문장에 없다: ${JSON.stringify(spoken)}`)
        }

        // 토스트는 polite 로 한 번만 읽힌다. 토스트마다 role="alert" 를 되붙이면 같은 문장이
        // 두 리전에서 겹쳐 읽히고, 방금 한 행동의 결과 보고일 뿐인 토스트가 읽던 것을 끊는다.
        const duplicated = await win.locator('[data-toast][role="alert"]').count()
        if (duplicated > 0) {
          throw new Error(
            `토스트 ${duplicated} 개가 role="alert" 를 달고 있다 — LiveRegion 과 겹쳐 읽힌다.`
          )
        }

        // 사이드바 상태 표시는 색 말고도 이름이 있어야 한다. 예전에는 점 분기가 role 없는 빈
        // span 이라 보조 기술이 통째로 건너뛰었고, 사용자는 색으로만 상태를 구분해야 했다.
        // 지금은 입력 대기 중이므로 그 칸의 이름이 나와야 한다.
        // 이름은 aria → label 순으로 고른다. 이 칸은 aria 가 없으므로 짧은 라벨이 이름이 된다
        // ('Waiting for your permission' 은 눈으로 보는 사람의 title 이지 읽히는 이름이 아니다).
        await win.locator('[role="img"][aria-label="Needs input"]').first().waitFor()

        console.log(`[e2e] screenshot=${await wooi.shot('live-region-announcements')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
