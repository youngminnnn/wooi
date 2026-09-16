/* global console, process, document, window */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 서브에이전트의 대화 — 사이드바에서 골라 들어가고, 부를 수 있으면 말을 건다.
 *
 * 렌더러 단위 테스트가 이미 "무엇이 보이고 언제 입력창이 열리는가" 를 증명한다. 여기서 볼 것은
 * 그 판정이 아니라 **판정을 감싸는 배선**이다:
 *
 * - 디스크에 저장된 `subagent`/`parentToolId` 항목이 실제로 다시 읽혀 사이드바의 행이 되는가.
 *   (이 설계의 전제가 "트랜스크립트에 함께 저장하므로 껐다 켜도 남는다" 이고, 그 전제는 진짜
 *   앱을 띄워 파일에서 읽어 봐야만 증명된다.)
 * - 사이드바 → 대화창 교체 → 되돌아가기가 실제로 이어지는가. 이 축은 워크스페이스 선택과
 *   얽혀 있어(store 의 selectWorkspace 가 선택을 지운다) 컴포넌트 하나로는 확인되지 않는다.
 * - 부모 대화가 서브에이전트의 도구 호출을 **걸러 내는가**. 이 배선이 끊기면 Task 카드 사이에
 *   남의 Bash·Read 가 섞인다.
 *
 * 릴레이 전송 자체는 **모델 턴이 필요해 여기서 밟지 않는다**(하네스 규약: 모델 턴을 돌리지 않는다).
 * 입력창이 열리는 조건과 잠기는 이유까지만 본다.
 */
const PARENT_TEXT = 'Delegating the search to two agents.'
const NAMED_TEXT = 'Found the config loader in src/main/paths.ts'
const UNNAMED_TEXT = 'The branch rule lives in scripts/branch-name-rule.mjs'
const CHILD_BASH = 'rg --files-with-matches loadConfig'
const CODEX_ACTIVITY = 'Codex activity-only run'

export default async function 서브에이전트의_대화를_사이드바에서_골라_들어간다() {
  const now = Date.now()
  const transcript = [
    {
      id: 'user-1',
      type: 'user',
      text: 'find the config loader and the branch rule',
      ts: now - 20
    },

    // 부모가 둘에게 위임한다. 한쪽은 SDK task 라 주소(taskId)가 있고, 한쪽은 없다
    // — 후자가 위임 실행·Codex collab 처럼 부를 수 없는 실행에 해당한다.
    {
      id: 'use-agent-1',
      type: 'tool_use',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'Find the config loader' },
      toolId: 'toolu_named',
      ts: now - 19
    },
    {
      id: 'use-agent-2',
      type: 'tool_use',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'Find the branch rule' },
      toolId: 'toolu_unnamed',
      ts: now - 18
    },

    {
      id: 'subagent:toolu_named',
      type: 'subagent',
      toolId: 'toolu_named',
      taskId: 'task-one',
      backend: 'claude',
      agentType: 'Explore',
      description: 'Find the config loader',
      status: 'running',
      toolUses: 4,
      totalTokens: 18_400,
      ts: now - 19
    },
    {
      id: 'subagent:toolu_unnamed',
      type: 'subagent',
      toolId: 'toolu_unnamed',
      backend: 'claude',
      agentType: 'Explore',
      description: 'Find the branch rule',
      status: 'running',
      toolUses: 7,
      totalTokens: 31_200,
      ts: now - 18
    },
    {
      id: 'codex:subagent:activity-1',
      type: 'subagent',
      toolId: 'activity-1',
      backend: 'codex',
      agentType: 'Explore',
      description: CODEX_ACTIVITY,
      status: 'completed',
      ts: now - 17.5
    },

    // 두 서브에이전트의 대화. 부모 대화에는 한 줄도 나오면 안 된다.
    {
      id: 'child-1-bash',
      type: 'tool_use',
      name: 'Bash',
      input: { command: CHILD_BASH },
      toolId: 'toolu_child_bash',
      ts: now - 17,
      parentToolId: 'toolu_named'
    },
    {
      id: 'child-1-bash-res',
      type: 'tool_result',
      toolId: 'toolu_child_bash',
      text: 'src/main/paths.ts',
      isError: false,
      ts: now - 16,
      parentToolId: 'toolu_named'
    },
    // 화면을 넘치도록 채운다. 이게 없으면 레이아웃이 깨져도(목록이 창 밖으로 자라도) 시드가
    // 짧아 아무 일도 일어나지 않는다 — 실제로 그렇게 통과한 적이 있다.
    //
    // 도구 호출로 채우지 않는 이유: 연속된 조회 호출은 하나의 묶음 카드로 접히므로
    // (`buildToolGroups`) 위의 Bash 카드까지 그 안으로 빨려 들어가 본문에서 사라진다.
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `child-1-filler-${i}`,
      type: 'assistant',
      text: `Checking module number ${i} for the loader.`,
      ts: now - 17 + i * 0.001,
      parentToolId: 'toolu_named'
    })),
    {
      id: 'child-1-say',
      type: 'assistant',
      text: NAMED_TEXT,
      ts: now - 15,
      parentToolId: 'toolu_named'
    },
    {
      id: 'child-2-say',
      type: 'assistant',
      text: UNNAMED_TEXT,
      ts: now - 14,
      parentToolId: 'toolu_unnamed'
    },

    { id: 'parent-say', type: 'assistant', text: PARENT_TEXT, ts: now - 13 }
  ]

  await withScratchRepo(
    {
      worktrees: ['feature-subagents'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // ── 부모 대화 ────────────────────────────────────────────────────
        const parent = await wooi.win.locator('body').innerText()
        if (!parent.includes(PARENT_TEXT)) {
          throw new Error(`parent reply is missing:\n${parent.slice(0, 2000)}`)
        }
        // 이 변경의 핵심 계약 — 서브에이전트가 낸 것은 부모 대화에 나오지 않는다.
        for (const leaked of [NAMED_TEXT, UNNAMED_TEXT, CHILD_BASH]) {
          if (parent.includes(leaked)) {
            throw new Error(`subagent output leaked into the parent conversation: ${leaked}`)
          }
        }

        // ── 사이드바에서 골라 들어간다 ───────────────────────────────────
        const named = wooi.win.getByRole('button', { name: /Find the config loader/ }).first()
        await named.waitFor()
        await named.click()

        const inside = await wooi.win.locator('body').innerText()
        if (!inside.includes(NAMED_TEXT) || !inside.includes(CHILD_BASH)) {
          throw new Error(
            `the subagent's own conversation should be shown:\n${inside.slice(0, 2000)}`
          )
        }
        if (inside.includes(PARENT_TEXT)) {
          throw new Error(`the parent conversation should be replaced, not stacked`)
        }
        // 주소가 있고 도는 중이므로 말을 걸 수 있다 — 릴레이라는 사실도 함께 밝혀야 한다.
        if (!inside.includes('Relayed through')) {
          throw new Error(
            `an addressable running subagent should offer a composer:\n${inside.slice(0, 2000)}`
          )
        }
        // 대화가 길어도 화면 안에 갇혀 있어야 한다. Wooi 는 전체 화면을 채우는 고정 레이아웃이라
        // 문서 자체는 절대 스크롤되지 않는다 — 그 불변식이 깨지면 어딘가 높이 제약이 새고 있다는
        // 뜻이다(MessageList 는 flex 컬럼의 직계 자식이어야 `flex-1 min-h-0` 이 먹는다).
        const overflow = await wooi.win.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight
        )
        if (overflow > 2) {
          throw new Error(`the subagent conversation overflows the window by ${overflow}px`)
        }
        // 입력창이 화면 밖으로 밀려나지 않았는지도 함께 본다 — 넘침의 가장 아픈 증상이다.
        const composerBottom = await wooi.win
          .getByPlaceholder(/^Message Explore/)
          .evaluate((el) => el.getBoundingClientRect().bottom)
        const viewportHeight = await wooi.win.evaluate(() => window.innerHeight)
        if (composerBottom > viewportHeight) {
          throw new Error(
            `the composer is pushed below the viewport (${composerBottom} > ${viewportHeight})`
          )
        }

        console.log(`[e2e] screenshot=${await wooi.shot('subagent-named')}`)

        // ── 주소 없이 뜬 쪽은 잠기고, 이유가 보인다 ──────────────────────
        await wooi.win
          .getByRole('button', { name: /Find the branch rule/ })
          .first()
          .click()
        const unnamed = await wooi.win.locator('body').innerText()
        if (!unnamed.includes(UNNAMED_TEXT)) {
          throw new Error(
            `switching subagents should swap the conversation:\n${unnamed.slice(0, 2000)}`
          )
        }
        if (!unnamed.includes('no address the main agent can send to')) {
          throw new Error(
            `an unaddressable subagent should say why it cannot be messaged:\n${unnamed.slice(0, 2000)}`
          )
        }
        console.log(`[e2e] screenshot=${await wooi.shot('subagent-unnamed')}`)

        // Codex app-server 는 서브에이전트의 상태·활동만 보내고 내부 transcript 는 보내지 않는다.
        // 빈 자식 대화를 일반 워크스페이스 onboarding 으로 오인하면 안 된다.
        await wooi.win
          .getByRole('button', { name: new RegExp(CODEX_ACTIVITY) })
          .first()
          .click()
        const codexActivity = await wooi.win.locator('body').innerText()
        if (!codexActivity.includes('internal transcript is not available from Codex')) {
          throw new Error(
            `Codex activity-only runs should explain the unavailable transcript:\n${codexActivity.slice(0, 2000)}`
          )
        }
        if (!codexActivity.includes('status and activity are shown above')) {
          throw new Error(
            `Codex activity-only runs should point to the visible status:\n${codexActivity.slice(0, 2000)}`
          )
        }
        if (codexActivity.includes('Start an agent session')) {
          throw new Error('Codex activity-only runs must not show the workspace onboarding')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('subagent-codex-activity')}`)

        // ── 부모로 돌아간다 ─────────────────────────────────────────────
        await wooi.win.getByRole('button', { name: /^Back to/ }).click()
        const back = await wooi.win.locator('body').innerText()
        if (!back.includes(PARENT_TEXT) || back.includes(NAMED_TEXT)) {
          throw new Error(
            `going back should restore the parent conversation:\n${back.slice(0, 2000)}`
          )
        }

        // ── ⌃A 로 차례로 돌고 부모로 돌아온다 ───────────────────────────
        // 시드의 두 실행은 도는 중이고 Codex activity 는 완료됐다. config loader 쪽부터
        // 사이드바 순서 그대로 돌아야 한다(순환과 목록이 같은 함수를 본다).
        await wooi.win.keyboard.press('Control+a')
        if (!(await wooi.win.locator('body').innerText()).includes(NAMED_TEXT)) {
          throw new Error('⌃A from the parent should enter the first subagent')
        }
        await wooi.win.keyboard.press('Control+a')
        if (!(await wooi.win.locator('body').innerText()).includes(UNNAMED_TEXT)) {
          throw new Error('⌃A should step to the next subagent')
        }
        await wooi.win.keyboard.press('Control+a')
        const codexCycle = await wooi.win.locator('body').innerText()
        if (!codexCycle.includes('internal transcript is not available from Codex')) {
          throw new Error('⌃A should step to the Codex activity-only subagent')
        }
        await wooi.win.keyboard.press('Control+a')
        const wrapped = await wooi.win.locator('body').innerText()
        if (!wrapped.includes(PARENT_TEXT) || wrapped.includes(UNNAMED_TEXT)) {
          throw new Error(
            `⌃A past the last subagent should return to the parent:\n${wrapped.slice(0, 1500)}`
          )
        }

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
