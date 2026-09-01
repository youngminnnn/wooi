/* global console, process */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const FILE = 'notes.txt'
const ORIGINAL = 'hello\nworld\n'
/** 뷰어를 열어 둔 사이 에이전트가 같은 파일을 고친 상황. */
const AGENT_WROTE = 'the agent rewrote this file\n'
const MY_EDIT = 'hello\nWORLD\n'

/**
 * 뷰어에서 고친 파일을 저장하는 길과, **그 사이 디스크가 바뀌었을 때 멈춰 서는 계약**을 밟는다.
 *
 * 유닛 테스트는 판정 함수(classifySave)와 쓰기 함수(writeFileInRoot)가 각각 옳다는 것까지만
 * 말해 준다. 여기서만 확인할 수 있는 것은 그 둘이 **화면과 이어져 있는지**다 — 열 때 받은
 * 해시가 편집 상태에 실제로 담기는지, Save 가 그 해시를 들고 가는지, 충돌이 배너로 돌아오는지.
 * 이 사슬은 어느 한 칸만 끊겨도 유닛 테스트는 전부 초록인 채로 남의 작업이 사라진다.
 *
 * 이 앱에서 사람과 에이전트는 같은 워크트리를 동시에 만진다. 그래서 여기서 가장 중요한 단언은
 * "경고가 떴다" 가 아니라 **경고가 뜬 시점에 디스크가 손대지지 않았다** 는 쪽이다.
 */
export default async function 뷰어에서_저장할_때_디스크가_바뀌었으면_멈춘다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        await writeFile(join(scratch.worktrees['feature-test'], FILE), ORIGINAL)
        return seedAppState(scratch)
      }
    },
    async (scratch) => {
      const filePath = join(scratch.worktrees['feature-test'], FILE)
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win
      const onDisk = () => readFile(filePath, 'utf8')

      try {
        await openSeededWorkspace(win)

        // ── 1. ⇧⌘O 로 뷰어를 연다(대화 위 오버레이) ───────────────────────────
        await win.keyboard.press('Meta+Shift+KeyO')
        const quickOpen = win.getByRole('textbox', { name: 'Open a file' })
        await quickOpen.waitFor({ timeout: 10_000 })
        await quickOpen.fill(FILE)
        // 검색은 비동기라 결과가 오기 전에 Enter 를 치면 아무 일도 안 일어난다. 행을 기다렸다 누른다.
        const hit = win.locator('[role="button"]').filter({ hasText: FILE }).first()
        await hit.waitFor({ timeout: 10_000 })
        await hit.click()

        const viewer = win.locator('[role="dialog"][aria-label^="File viewer"]')
        await viewer.waitFor({ timeout: 10_000 })
        await win.getByText('world').first().waitFor({ timeout: 10_000 })

        // ── 2. 편집을 시작하고 한 줄 고친다 ───────────────────────────────────
        await win.getByRole('button', { name: 'Edit', exact: true }).click()
        const editor = win.getByLabel(`Edit ${FILE}`)
        await editor.waitFor({ timeout: 5000 })
        await editor.fill(MY_EDIT)

        // ── 3. 그 사이 에이전트가 같은 파일을 고쳤다 ──────────────────────────
        await writeFile(filePath, AGENT_WROTE)

        // ── 4. 저장하면 쓰지 않고 경고한다 ────────────────────────────────────
        await win.getByRole('button', { name: 'Save', exact: true }).click()

        const banner = win.locator('[role="alert"]').filter({ hasText: 'changed on disk' })
        await banner.waitFor({ timeout: 10_000 })
        console.log(`[e2e] screenshot=${await wooi.shot('file-viewer-save-conflict')}`)

        // 이 스펙의 핵심 단언. 경고를 띄우면서 이미 덮어썼다면 경고는 아무 의미가 없다.
        const untouched = await onDisk()
        if (untouched !== AGENT_WROTE) {
          throw new Error(`충돌을 알리면서 디스크를 이미 덮어썼다: ${JSON.stringify(untouched)}`)
        }

        // 초안도 남아 있어야 한다 — 여기서 날리면 사용자가 방금 친 것이 사라진다.
        const draftKept = await editor.inputValue()
        if (draftKept !== MY_EDIT) {
          throw new Error(`충돌 뒤 초안이 사라졌다: ${JSON.stringify(draftKept)}`)
        }

        // ── 5. 경고를 보고 고른 덮어쓰기는 통과시킨다 ─────────────────────────
        await banner.getByRole('button', { name: 'Overwrite' }).click()
        await banner.waitFor({ state: 'detached', timeout: 10_000 })

        const saved = await onDisk()
        if (saved !== MY_EDIT) {
          throw new Error(`덮어쓰기를 골랐는데 저장되지 않았다: ${JSON.stringify(saved)}`)
        }

        // 저장이 끝나면 읽기 전용으로 돌아간다(Save 가 사라지고 Edit 이 돌아온다).
        await win.getByRole('button', { name: 'Edit', exact: true }).waitFor({ timeout: 10_000 })

        console.log(`[e2e] screenshot=${await wooi.shot('file-viewer-save-done')}`)
        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
