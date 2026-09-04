/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 정리 제안이 **왜** 떴는지를 배너가 제대로 말하는지 고정한다([[types]] ArchiveSuggestReason).
 *
 * 사유가 늘어난 것이 이 변경의 요점이다 — 병합 말고도 "만들고 한 번도 안 씀" 과 "아무도 채택하지
 * 않은 fan-out 후보" 가 같은 배너를 띄운다. 셋이 한 컴포넌트를 나눠 쓰므로, 문구가 사유를 따라
 * 갈라지지 않으면 사용자는 병합되지도 않은 브랜치를 "merged" 로 읽는다. 그 오독의 결과가
 * worktree 삭제라 문구가 곧 안전장치다.
 *
 * 음성 단언이 이 스펙의 값어치다:
 * - 병합이 아닌 사유에는 "pull request" 를 말하지 않는다(연 적 없는 PR 을 남겨 둔다고 할 수 없다).
 * - 병합이 아닌 사유에는 `Start fresh session` 이 뜨지 않는다. 맥락을 끊어 계속 쓰자는 제안은
 *   "이 워크스페이스를 계속 쓸 이유가 있다" 는 전제 위에 서는데, 안 쓴 워크스페이스에는 그 전제가
 *   없다. 컨텍스트가 충분히 크더라도 그렇다 — 그래서 여기서 일부러 큰 값을 심는다.
 *
 * 이 스펙이 증명하지 못하는 것: 판정 자체. 무엇이 `unused` 인지는 순수 함수
 * (`detectIdleArchiveSuggestion`)가 결정하고 유닛 테스트가 고정한다. 여기서는 **판정 결과가
 * 화면에서 어떻게 읽히는지**만 본다.
 */

const FRESH_BUTTON = 'Start fresh session'

/** 사유 하나를 심고 배너를 확인한다. 스크래치 루트가 하나뿐이라 순차로 돈다. */
async function checkReason({ reason, expected, shot }) {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          workspace: {
            // mergedBranch 는 워크스페이스 브랜치와 같아야 한다 — 다르면 기동 직후
            // reconcileWorkspaceStack 이 제안을 다시 판정해 지운다.
            archiveSuggest: {
              mergedBranch: 'feature-test',
              prNumber: null,
              reason,
              detectedAt: Date.now()
            }
          }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.getByText(expected).waitFor()

        // 병합이 아니므로 PR 을 남겨 둔다는 말이 나오면 안 된다.
        const mentionsPr = wooi.win.getByText(', pull request,')
        if ((await mentionsPr.count()) > 0) {
          throw new Error(`the ${reason} banner still mentions a pull request`)
        }
        // 병합이 아니면 맥락 끊기 제안도 하지 않는다.
        const fresh = wooi.win.getByRole('button', { name: FRESH_BUTTON })
        if ((await fresh.count()) > 0) {
          throw new Error(`the ${reason} banner offered to start a fresh session`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot(shot)}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

export default async function 정리_제안은_왜_떴는지를_사유마다_다르게_말한다() {
  await checkReason({
    reason: 'unused',
    expected: 'was never used — no turn has run here since it was created.',
    shot: 'archive-suggest-unused'
  })
  await checkReason({
    reason: 'fanoutLoser',
    expected: 'is a fan-out candidate and none of the group was adopted.',
    shot: 'archive-suggest-fanout-loser'
  })
}
