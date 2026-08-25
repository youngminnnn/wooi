/* global console, process */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

// 기본 스크래치 루트는 한 번에 하나의 실행만 감당한다(하네스 계약). 다른 워크스페이스가 동시에
// e2e 를 돌리면 정리가 ENOTEMPTY 로 깨지므로 이 스펙만의 루트를 쓴다.
const ROOT = '/tmp/wooi-e2e-status-skills-hooks'
// shots 를 루트 밖에 둔다 — 루트는 끝나면 통째로 지워져 PNG 가 함께 사라진다.
const SHOTS = '/tmp/wooi-shots-status-skills-hooks'

/**
 * /status·/skills·/hooks 카드. 셋 다 CLI TUI 전용(local-jsx) 명령이라 그냥 메시지로 보내면
 * "isn't available in this environment." 가 돌아온다 — Wooi 가 데이터를 직접 받아 그린 카드가
 * 실제로 뜨는지는 앱을 띄워야만 확인된다.
 *
 * 모델 턴은 돌지 않는다. 세 명령 모두 인터셉트되어 SDK 제어 채널 또는 설정 파일만 읽는다.
 */

const transcript = [
  { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: Date.now() - 1 },
  { id: 'assistant-e2e', type: 'assistant', text: 'Ready without a model turn.', ts: Date.now() }
]

/** 인터셉트 카드의 루트. 한 번에 하나만 뜨므로 first() 로 충분하다. */
function cardRoot(win) {
  return win.locator('div.absolute.bottom-full').first()
}

/** 카드가 뜨고 로딩이 끝날 때까지 기다린 뒤 본문 텍스트를 돌려준다. */
async function runCommandCard(win, command) {
  const textarea = win.locator('textarea[placeholder^="Message your agent"]')
  await textarea.click()
  // 후행 공백이 자동완성 메뉴를 닫는다 — 메뉴가 열려 있으면 Enter 를 메뉴가 먼저 가져간다.
  await textarea.fill(`${command} `)
  await textarea.press('Enter')

  // 카드 헤더의 닫기 버튼이 카드가 실제로 붙었다는 가장 안정적인 신호다.
  await win.locator('button[title="Dismiss (Esc)"]').waitFor({ timeout: 30_000 })

  // 단명 쿼리가 CLI 를 spawn 하므로 로딩이 길다. "Loading…" 이 사라질 때까지 기다린다.
  const loading = win.getByText('Loading…', { exact: true })
  await loading.waitFor({ state: 'detached', timeout: 90_000 }).catch(() => {})

  await win.waitForTimeout(500)
  const card = cardRoot(win)
  return { card, text: await card.innerText() }
}

/** 카드를 닫아 다음 명령이 깨끗한 입력창에서 시작하게 한다. */
async function closeCard(win) {
  await win.locator('button[title="Dismiss (Esc)"]').click()
  await win.locator('button[title="Dismiss (Esc)"]').waitFor({ state: 'detached' })
}

function expectIncludes(actual, expected, subject) {
  if (!actual.includes(expected)) {
    throw new Error(
      `${subject}: expected text containing ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

function expectExcludes(actual, forbidden, subject) {
  if (actual.includes(forbidden)) {
    throw new Error(
      `${subject}: expected text NOT containing ${JSON.stringify(forbidden)}, found ${JSON.stringify(actual)}`
    )
  }
}

export default async function 새_명령_카드_셋이_실제_앱에서_뜬다() {
  await withScratchRepo(
    {
      root: ROOT,
      worktrees: ['feature-test'],
      seed: (scratch) => seedAppState(scratch, { transcript })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch, shotsPath: SHOTS })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.locator('textarea[placeholder^="Message your agent"]').waitFor()

        // ── /hooks — Query 를 열지 않고 settings.json 만 읽는다 ─────────────────
        {
          const { text } = await runCommandCard(wooi.win, '/hooks')
          // 스크래치 워크트리에는 .claude/settings.json 이 없다 → 빈 상태 문구가 떠야 한다.
          expectIncludes(text, 'No hooks configured', '/hooks empty state')
          console.log(`[e2e] screenshot=${await wooi.shot('card-hooks')}`)
          await closeCard(wooi.win)
        }

        // ── /status — 세션이 없으므로 fast mode 를 모른다고 밝혀야 한다 ────────
        {
          const { text } = await runCommandCard(wooi.win, '/status')
          expectIncludes(text, 'Account', '/status sections')
          expectIncludes(text, 'Workspace', '/status sections')
          // 이 워크스페이스는 아직 턴을 돌린 적이 없다 → 라이브 쿼리가 없다.
          expectIncludes(text, 'No live session', '/status no-live-session notice')
          // 빈 단명 쿼리의 fast mode 값('off')을 세션 상태인 척 보여 주면 안 된다.
          expectIncludes(text, 'start one to see fast mode state', '/status fast mode honesty')
          expectIncludes(text, 'feature-test', '/status branch row')
          console.log(`[e2e] screenshot=${await wooi.shot('card-status')}`)
          await closeCard(wooi.win)
        }

        // ── /skills — reloadSkills() 의 권위 있는 목록 ─────────────────────────
        {
          const { card, text } = await runCommandCard(wooi.win, '/skills')
          expectExcludes(text, 'No data returned', '/skills error state')
          const items = card.locator('li')
          const count = await items.count()
          if (count === 0) throw new Error('/skills: no skills listed')
          // 출처 배지가 실제로 붙는지(플러그인·유저·번들 중 최소 하나).
          const badges = await card.locator('text=/^(Plugin|User|Built-in)$/').count()
          if (badges === 0) throw new Error('/skills: no source badge rendered')
          // 플러그인 스킬은 SDK 가 중복으로 돌려준다 — 카드에는 한 번만 떠야 한다.
          // 이름 span 만 고른다(설명·인자힌트·배지 span 과 섞이지 않도록).
          const names = await card.locator('li span.font-medium').allInnerTexts()
          const dupes = names.filter((n, i) => names.indexOf(n) !== i)
          if (dupes.length > 0) throw new Error(`/skills: duplicate entries ${dupes.join(', ')}`)
          console.log(`[e2e] skills=${count} names=${names.length} badges=${badges}`)
          console.log(`[e2e] screenshot=${await wooi.shot('card-skills')}`)
          await closeCard(wooi.win)
        }

        // ── 자동완성 — /agents 설명이 CLI 의 "(removed)" 가 아니어야 한다 ──────
        {
          const textarea = wooi.win.locator('textarea[placeholder^="Message your agent"]')
          await textarea.click()
          await textarea.fill('/agents')
          const menu = wooi.win.getByText('List subagents available to this session').first()
          await menu.waitFor({ timeout: 30_000 })
          const menuText = await wooi.win.locator('body').innerText()
          expectExcludes(menuText, '(removed)', '/agents autocomplete description')
          console.log(`[e2e] screenshot=${await wooi.shot('autocomplete-agents')}`)
          await textarea.fill('')
        }

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
