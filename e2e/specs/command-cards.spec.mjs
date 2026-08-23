/* global console, process */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'

/**
 * 인터랙티브 명령 카드가 **없는 세션을 있는 척 세지 않는지**를 실제 앱에서 고정한다.
 *
 * 이 두 명령은 SDK 도, claude CLI 도 타지 않는다 — /context 는 라이브 쿼리가 없다는 사실만 보고
 * 곧바로 끊고, /permissions 는 settings 파일만 읽는다. 그래서 로그인·네트워크와 무관하게
 * 결정적으로 돌릴 수 있다(모델 턴을 돌리지 않는다는 e2e 원칙도 지킨다).
 *
 * /usage·/mcp 의 단명 쿼리 경로는 진짜 CLI 를 띄워야 하므로 여기서 다루지 않는다 —
 * 그쪽 경계는 src/main/claude/control.test.ts 가 가짜 Query 로 고정한다.
 */

const transcript = [
  { id: 'user-e2e', type: 'user', text: 'Seeded conversation', ts: Date.now() - 1 },
  { id: 'assistant-e2e', type: 'assistant', text: 'Ready without a model turn.', ts: Date.now() }
]

/** 워크트리 프로젝트 스코프에 심는 권한 규칙 — 카드가 이 값을 그대로 되비쳐야 한다. */
const SEEDED_RULES = {
  allow: ['Bash(echo e2e:*)'],
  ask: ['WebFetch(domain:example.com)'],
  deny: ['Read(./e2e-secret.txt)']
}

function expectIncludes(actual, expected, subject) {
  if (!actual.includes(expected)) {
    throw new Error(
      `${subject}: expected text containing ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    )
  }
}

function expectExcludes(actual, pattern, subject) {
  if (pattern.test(actual)) {
    throw new Error(`${subject}: expected no match for ${pattern}, found ${JSON.stringify(actual)}`)
  }
}

/** 명령을 보내고 뜬 카드의 본문 텍스트를 돌려준다(카드는 트랜스크립트가 아니라 입력창 위에 뜬다). */
async function openCard(win, command) {
  const textarea = win.locator('textarea[placeholder^="Message your agent"]')
  await textarea.click()
  // 뒤 공백은 자동완성 메뉴를 닫아 Enter 가 메뉴 선택이 아니라 전송이 되게 한다.
  await textarea.fill(`${command} `)
  await textarea.press('Enter')
  const card = win.locator('div.absolute.bottom-full.max-h-96')
  await card.waitFor()
  // 로딩 스피너가 걷힐 때까지 기다린다 — 곧바로 읽으면 'Loading…' 을 본다.
  await card.getByText('Loading…').waitFor({ state: 'detached' })
  return card
}

/** 다음 명령이 앞 카드를 읽지 않도록 Esc 로 닫는다. */
async function closeCard(win) {
  await win.keyboard.press('Escape')
  await win.locator('div.absolute.bottom-full.max-h-96').waitFor({ state: 'detached' })
}

export default async function 명령_카드가_라이브_세션이_없는_사정을_그대로_보여_준다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )

  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        await seedAppState(scratch, { transcript })
        // 프로젝트 스코프 규칙을 워크트리에 심는다. /permissions 는 <cwd>/.claude 를 읽으므로
        // 사용자 실제 설정과 무관하게 카드가 무엇을 되비치는지 결정적으로 볼 수 있다.
        const claudeDir = join(scratch.worktrees['feature-test'], '.claude')
        await mkdir(claudeDir, { recursive: true })
        await writeFile(
          join(claudeDir, 'settings.local.json'),
          JSON.stringify({ permissions: SEEDED_RULES }, null, 2)
        )
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.locator('textarea[placeholder^="Message your agent"]').waitFor()

        // ── /context — 라이브 세션이 없으면 숫자를 지어내지 않는다 ──────────────
        const contextCard = await openCard(wooi.win, '/context')
        const contextText = await contextCard.innerText()
        expectIncludes(contextText, '/context', '/context card title')
        expectIncludes(contextText, 'No live session in this workspace yet', '/context card body')
        expectIncludes(contextText, 'Send a message first', '/context card body')
        // 예전 버그의 흔적: 빈 query 를 읽어 만든 사용률·카테고리가 남아 있으면 안 된다.
        expectExcludes(contextText, /\d+\s?%/, '/context card body')
        expectExcludes(contextText, /System (prompt|tools)/, '/context card body')
        console.log(`[e2e] screenshot=${await wooi.shot('command-card-context-no-session')}`)
        await closeCard(wooi.win)

        // ── /permissions — 읽은 파일과 "전부가 아님" 을 밝힌다 ──────────────────
        const permissionsCard = await openCard(wooi.win, '/permissions')
        const permissionsText = await permissionsCard.innerText()
        expectIncludes(permissionsText, '/permissions', '/permissions card title')
        expectIncludes(permissionsText, 'Default —', '/permissions mode line')
        for (const rule of [...SEEDED_RULES.allow, ...SEEDED_RULES.ask, ...SEEDED_RULES.deny]) {
          expectIncludes(permissionsText, rule, '/permissions seeded rule')
        }
        expectIncludes(permissionsText, '.claude/settings.local.json', '/permissions sources')
        expectIncludes(
          permissionsText,
          'Rules loaded by plugins or applied per session are not listed here.',
          '/permissions caveat'
        )
        console.log(`[e2e] screenshot=${await wooi.shot('command-card-permissions-sources')}`)

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
