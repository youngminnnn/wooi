/* global console, process */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 병합된 워크스페이스를 계속 쓸 때 **맥락만 끊고 기록은 남기는** 출구가 실제로 도는지 고정한다.
 *
 * 이걸 e2e 로 보는 이유는 계약이 세 프로세스에 걸쳐 있어서다 — 버튼은 렌더러가 그리고, 세션을
 * 버리는 것은 main 이 하고, "기록이 남았다" 는 디스크의 트랜스크립트 파일이 증명한다. 어느 한
 * 층의 유닛 테스트도 "화면의 버튼을 눌렀더니 대화는 남고 맥락만 비었다" 를 통째로 말하지 못한다.
 *
 * 특히 지키려는 것은 **기록이 남는다** 는 쪽이다. `keepTranscript` 없이 `/clear` 를 부르면
 * 트랜스크립트 파일이 지워지는데, 그 차이는 눈으로 보지 않으면 조용히 뒤집힌다.
 *
 * 이 스펙이 증명하지 못하는 것: 다음 턴이 정말 빈 맥락으로 시작하는지. 그건 실제 CLI 를 띄워야
 * 알 수 있고(모델 턴을 돌리지 않는다는 원칙과 부딪힌다), 여기서는 그 유일한 근거인
 * `sessionId === null` 까지만 본다([[claude/session]] 이 그 값으로만 resume 을 건다).
 */

const SEEDED_LINE = 'The e2e seed message that must survive a fresh session.'
const BUTTON_NAME = 'Start fresh session'
const TOAST_TEXT = 'Started a fresh session. The conversation above is kept.'
const SYSTEM_NOTICE =
  'Context cleared. The conversation above stays here for you, but the next message starts a fresh session that cannot see it.'

/** 메인이 렌더러로 보내는 대화 이벤트를 그대로 흉내 낸다(rewind-modes 와 같은 길). */
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

/**
 * 시드 워크스페이스의 세션 상태를 읽는다.
 *
 * `?? null` 로 정규화하되 "못 찾았다" 는 따로 돌려준다 — 둘을 한 값으로 접으면 워크스페이스가
 * 통째로 사라진 것과 세션이 제대로 끊긴 것을 구별하지 못한다.
 */
async function readSession(win) {
  return win.evaluate(async () => {
    const state = await globalThis.api.getState()
    const ws = state.workspaces.find((item) => item.id === 'ws-e2e')
    if (!ws) return { found: false, sessionId: null }
    return { found: true, sessionId: ws.sessionId ?? null }
  })
}

export default async function 병합된_워크스페이스에서_맥락만_끊으면_대화는_남는다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user:seed:1', type: 'user', text: SEEDED_LINE, ts: Date.now() - 60_000 }
          ],
          workspace: {
            // mergedBranch 는 워크스페이스 브랜치와 같아야 한다 — 다르면 기동 직후
            // reconcileWorkspaceStack 이 제안을 다시 판정해 지운다([[stack]] detectArchiveSuggestion).
            archiveSuggest: {
              mergedBranch: 'feature-test',
              prNumber: 42,
              detectedAt: Date.now()
            }
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // 배너는 병합만으로 뜨지만 이 버튼은 컨텍스트가 커야 뜬다. 컨텍스트 사용량은 렌더러
        // 스토어에만 사는 값이라 시드로 넣을 수 없어, 세션이 턴 끝에 보내는 이벤트를 흉내 낸다.
        const banner = wooi.win.getByText('was merged —')
        await banner.waitFor()
        const button = wooi.win.getByRole('button', { name: BUTTON_NAME })
        if (await button.isVisible()) {
          throw new Error('the fresh-session button appeared before any context was reported')
        }
        // 끊기 전에 세션이 있었어야 "끊었다" 가 의미를 갖는다(시드 트랜스크립트가 붙여 준 값).
        const before = await readSession(wooi.win)
        if (before.sessionId === null) {
          throw new Error(`the seeded workspace had no session to drop: ${JSON.stringify(before)}`)
        }

        await sendChatEvent(wooi.app, {
          type: 'context',
          usedTokens: 180_000,
          maxTokens: 1_000_000,
          percentage: 0.18
        })
        await button.waitFor()
        await button.click()

        // 토스트는 `[data-toast]` 로 좁힌다 — 같은 문구가 sr-only 라이브 리전에도 복제돼
        // getByText 로는 strict mode 위반이 된다.
        await wooi.win.locator('[data-toast]').filter({ hasText: TOAST_TEXT }).waitFor()
        // 화면과 맥락이 어긋난 것을 앱이 말해야 한다.
        await wooi.win.getByText(SYSTEM_NOTICE).waitFor()

        const after = await readSession(wooi.win)
        if (!after.found) {
          throw new Error('the seeded workspace disappeared from the state')
        }
        if (after.sessionId !== null) {
          throw new Error(`the session was not dropped: ${JSON.stringify(after)}`)
        }

        // 여기가 이 스펙의 핵심 단언이다 — 맥락은 비었는데 기록은 디스크에 남아 있어야 한다.
        const transcript = await readFile(
          join(scratch.userDataPath, 'transcripts', 'ws-e2e.jsonl'),
          'utf8'
        ).catch((error) => {
          throw new Error(`the transcript file was removed: ${error.message}`)
        })
        if (!transcript.includes(SEEDED_LINE)) {
          throw new Error(
            `the seeded conversation did not survive: ${JSON.stringify(transcript.slice(0, 400))}`
          )
        }

        // 상태줄 게이지도 0 으로 돌아가야 한다. 컨텍스트 사용량은 AppState 에 없어 상태 방송에
        // 실리지 않으므로, main 이 잊는 것만으로는 화면이 끊기 전 수치를 계속 가리킨다.
        await wooi.win.locator('[title="Context usage appears after the first turn"]').waitFor()

        console.log(`[e2e] screenshot=${await wooi.shot('archive-suggest-fresh-session')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
