/* global console, process, window */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const IMPORTED = 'import-me'
const SESSION_ID = 'e2e-imported-session'
const SESSION_TITLE = 'Teach the parser to count'
const FIRST_PROMPT = '파서가 숫자를 세게 해 줘'
const FIRST_REPLY = '세게 만들었습니다.'

/**
 * 이미 있는 worktree 를 워크스페이스로 들여오고, 그 자리에서 돌던 대화까지 되살리는지 본다.
 *
 * 유닛 테스트는 스캔·변환이 옳은 값을 만든다는 것까지만 말해 준다. 여기서 값진 것은 **사용자가
 * 실제로 밟는 경로**다 — 리포의 + 메뉴에 항목이 있는지, 모달이 등록되지 않은 worktree 와 이어받을
 * 대화를 보여 주는지, 버튼 한 번에 워크스페이스가 생기고 지난 메시지가 화면에 뜨는지.
 *
 * 세션 파일은 실제 홈(`~/.claude/projects/<cwd 슬러그>`)에 심는다. CLI 가 그곳만 보기 때문이고,
 * HOME 을 바꾸면 백엔드 감지가 깨진다([[wooi-run]] 의 원칙). 슬러그는 스크래치 경로에서 나오므로
 * 사용자 것과 겹칠 수 없고, 끝나면 지운다.
 */
export default async function 기존_worktree를_대화까지_들여온다() {
  let claudeProjectDir = null
  try {
    await withScratchRepo(
      {
        worktrees: ['feature-test', IMPORTED],
        seed: async (scratch) => {
          // 시드는 첫 worktree 하나만 워크스페이스로 만든다 — IMPORTED 는 등록되지 않은 채
          // git 에만 있는 상태로 남아, 이 스펙이 확인할 후보가 된다.
          const seeded = await seedAppState(scratch)
          const cwd = realpathSync(scratch.worktrees[IMPORTED])
          claudeProjectDir = join(homedir(), '.claude', 'projects', cwd.replaceAll('/', '-'))
          await mkdir(claudeProjectDir, { recursive: true })
          const at = Date.now() - 60_000
          await writeFile(
            join(claudeProjectDir, `${SESSION_ID}.jsonl`),
            [
              { type: 'custom-title', customTitle: SESSION_TITLE, sessionId: SESSION_ID },
              {
                type: 'user',
                timestamp: new Date(at).toISOString(),
                message: { content: FIRST_PROMPT }
              },
              {
                type: 'assistant',
                timestamp: new Date(at + 1000).toISOString(),
                message: { content: [{ type: 'text', text: FIRST_REPLY }] }
              }
            ]
              .map((line) => JSON.stringify(line))
              .join('\n') + '\n'
          )
          return seeded
        }
      },
      async (scratch) => {
        const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
        try {
          const win = wooi.win

          // 1. 리포의 + 메뉴에 들여오기 항목이 있다.
          await win.locator('button[title="New workspace or start from an issue"]').first().click()
          const menuItem = win.getByText('Import existing worktrees…')
          await menuItem.waitFor({ timeout: 5000 })
          console.log(`[e2e] screenshot=${await wooi.shot('import-menu')}`)
          await menuItem.click()

          // 2. 모달이 등록되지 않은 worktree 와 이어받을 대화를 보여 준다.
          const dialog = win.locator('[role="dialog"]')
          await dialog.waitFor({ timeout: 5000 })
          // 이름과 브랜치가 같은 문자열이라 두 번 나온다 — 첫 번째(이름)만 본다.
          await dialog.getByText(IMPORTED, { exact: true }).first().waitFor({ timeout: 10_000 })
          const sessionLine = dialog.getByText(`Continue “${SESSION_TITLE}” and bring its messages`)
          await sessionLine.waitFor({ timeout: 10_000 })
          // 이미 워크스페이스인 worktree 도 목록에 남되 고를 수 없어야 한다 — 왜 안 들어오는지를
          // 보여 주지 않으면 사용자는 빠진 것을 버그로 읽는다.
          const seededRow = dialog
            .locator('label', { hasText: 'feature-test' })
            .filter({ hasText: 'already in Wooi' })
            .first()
          await seededRow.waitFor({ timeout: 10_000 })
          if (await seededRow.locator('input[type="checkbox"]').isEnabled()) {
            throw new Error('이미 워크스페이스인 worktree 를 다시 고를 수 있다')
          }
          console.log(`[e2e] screenshot=${await wooi.shot('import-modal')}`)

          // 3. 들여오면 워크스페이스가 생기고 세션을 이어받는다.
          await dialog.getByRole('button', { name: 'Import', exact: true }).click()
          await dialog.waitFor({ state: 'detached', timeout: 15_000 })

          const worktreePath = realpathSync(scratch.worktrees[IMPORTED])
          const imported = await win.evaluate(async (path) => {
            const state = await window.api.getState()
            return state.workspaces.find((ws) => ws.worktreePath === path) ?? null
          }, worktreePath)
          if (!imported) throw new Error(`들여온 워크스페이스가 상태에 없다: ${worktreePath}`)
          if (imported.sessionId !== SESSION_ID) {
            throw new Error(`세션을 이어받지 않았다: ${JSON.stringify(imported.sessionId)}`)
          }
          if (imported.branch !== IMPORTED) {
            throw new Error(`브랜치를 잘못 읽었다: ${JSON.stringify(imported.branch)}`)
          }
          if (imported.setupState !== 'success') {
            throw new Error(`셋업을 다시 돌리려 한다: ${JSON.stringify(imported.setupState)}`)
          }

          // 4. 지난 대화가 화면에 되살아난다.
          await win.locator('[role="button"]').filter({ hasText: IMPORTED }).first().click()
          await win.getByText(FIRST_PROMPT).first().waitFor({ timeout: 10_000 })
          await win.getByText(FIRST_REPLY).first().waitFor({ timeout: 10_000 })
          await win
            .getByText(`continuing the Claude Code conversation “${SESSION_TITLE}”`, {
              exact: false
            })
            .first()
            .waitFor({ timeout: 10_000 })
          console.log(`[e2e] screenshot=${await wooi.shot('import-restored-conversation')}`)

          await waitForInspection(win)
        } finally {
          await wooi.close()
        }
      }
    )
  } finally {
    // 실제 홈에 심은 세션 파일은 이 스펙의 것이다. 남기면 다음 실행이 옛 대화를 다시 본다.
    if (claudeProjectDir) await rm(claudeProjectDir, { recursive: true, force: true })
  }
}
