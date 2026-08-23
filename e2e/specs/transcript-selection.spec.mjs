/* global console, process */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  openSeededWorkspace,
  seedAppState,
  sendPermissionRequest,
  waitForInspection
} from '../fixtures.mjs'

/**
 * 읽으라고 내놓은 글자는 고를 수 있어야 하고, 고르는 손짓이 카드를 건드려서는 안 된다.
 *
 * 이 스펙이 잡는 회귀는 렌더러 단위 테스트로는 잡히지 않는다 — 원인이 크로미움의 기본
 * 스타일(버튼 안의 글자에 user-select: none)이라, 진짜 창에서 진짜 마우스를 끌어 봐야
 * 드러난다. jsdom 은 선택 자체를 흉내 내지 않는다.
 */
const SHELL_LINE = 'selectable-shell-output tsc --noEmit'
const AGENT_LINE = 'selectable-agent-output M src/main/index.ts'
const RESULT_LINE = 'selectable-tool-result line one'
const COMMAND = 'npm run build -- selectable-permission-text'
const OPTION = 'Selectable option one'

export default async function 읽는_글자는_드래그로_고를_수_있다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )
  const now = Date.now()
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          transcript: [
            { id: 'user-1', type: 'user', text: 'run the build', ts: now - 4 },
            {
              id: 'bash-user',
              type: 'bash',
              command: 'npm run build',
              output: [SHELL_LINE, 'error TS2345: Argument of type string', 'third line'].join(
                '\n'
              ),
              exitCode: 1,
              running: false,
              ts: now - 3
            },
            {
              // 접기 한도(BASH_FOLD.agent)를 넘겨야 "Show full output" 이 생긴다 — 드래그가
              // 그 상태를 건드리지 않는다는 단언에 필요하다.
              id: 'bash-agent',
              type: 'bash',
              agent: true,
              command: 'git status --short',
              output: [AGENT_LINE, ...Array.from({ length: 14 }, (_, i) => `line ${i + 2}`)].join(
                '\n'
              ),
              exitCode: 0,
              running: false,
              ts: now - 2
            },
            {
              id: 'tool-use',
              type: 'tool_use',
              toolId: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/selectable.ts' },
              ts: now - 1
            },
            {
              id: 'tool-result',
              type: 'tool_result',
              toolId: 'tool-1',
              text: [RESULT_LINE, 'line two', 'line three', 'line four'].join('\n'),
              isError: true,
              ts: now
            }
          ]
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // ── 대화: 셸 출력과 도구 결과 ────────────────────────────────────────
        await expectSelectable(wooi.win, pre(wooi.win, SHELL_LINE), SHELL_LINE, 'shell output')

        const foldToggle = wooi.win.getByText('Show full output', { exact: false })
        const foldedBefore = await foldToggle.count()
        if (foldedBefore === 0) throw new Error('agent output did not fold; the seed is too short')
        await expectSelectable(wooi.win, pre(wooi.win, AGENT_LINE), AGENT_LINE, 'agent output')
        if ((await foldToggle.count()) !== foldedBefore) {
          throw new Error('dragging over the output folded or unfolded it')
        }

        await expectSelectable(wooi.win, pre(wooi.win, RESULT_LINE), RESULT_LINE, 'tool result')
        console.log(`[e2e] screenshot=${await wooi.shot('transcript-selection')}`)

        // 고르는 손짓이 접기를 막았다고 해서 누르는 손짓까지 막으면 안 된다.
        await clearSelection(wooi.win)
        await pre(wooi.win, AGENT_LINE).click()
        await wooi.win.waitForTimeout(300)
        if ((await foldToggle.count()) >= foldedBefore) {
          throw new Error('clicking the output no longer expands it')
        }

        // ── 승인 카드 ───────────────────────────────────────────────────────
        await sendPermissionRequest(wooi.app, {
          requestId: 'perm-e2e',
          workspaceId: 'ws-e2e',
          toolName: 'Bash',
          kind: 'command',
          title: 'Allow npm run build?',
          displayName: 'Bash',
          rule: 'Bash(npm run:*)',
          input: { command: COMMAND }
        })
        const permission = pre(wooi.win, 'selectable-permission-text')
        await permission.waitFor()
        await expectSelectable(wooi.win, permission, COMMAND, 'permission card body')

        // 본문에서 시작한 드래그가 결정 버튼 위에서 끝나도 승인으로 새면 안 된다.
        const allow = wooi.win.locator('button', { hasText: /^Allow$/ }).first()
        await dragBetween(wooi.win, permission, allow)
        if ((await permission.count()) === 0) {
          throw new Error('releasing a text drag over Allow answered the permission')
        }
        console.log(`[e2e] screenshot=${await wooi.shot('permission-selection')}`)

        await clearSelection(wooi.win)
        await allow.click()
        await wooi.win.waitForTimeout(600)
        if ((await permission.count()) > 0) throw new Error('clicking Allow no longer answers')

        // ── 질문 카드 ───────────────────────────────────────────────────────
        await sendPermissionRequest(wooi.app, {
          requestId: 'question-e2e',
          workspaceId: 'ws-e2e',
          toolName: 'AskUserQuestion',
          kind: 'question',
          input: {
            questions: [
              {
                question: 'Which approach?',
                header: 'Approach',
                multiSelect: false,
                options: [
                  { label: OPTION, description: 'the first way of doing it' },
                  { label: 'Second option', description: 'the other way' }
                ]
              }
            ]
          }
        })
        const label = wooi.win.getByText(OPTION, { exact: true })
        await label.waitFor()
        const submit = wooi.win.locator('button', { hasText: /^Submit$/ }).first()
        await expectSelectable(wooi.win, label, OPTION, 'question option')
        if (!(await submit.isDisabled())) throw new Error('dragging over an option answered it')
        console.log(`[e2e] screenshot=${await wooi.shot('question-selection')}`)

        await clearSelection(wooi.win)
        await label.click()
        await wooi.win.waitForTimeout(300)
        if (await submit.isDisabled()) throw new Error('clicking an option no longer selects it')

        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

/** 표시된 글자를 담은 <pre>. 셸 출력과 도구 결과가 모두 이 모양이다. */
function pre(win, text) {
  return win.locator('pre', { hasText: text }).first()
}

function clearSelection(win) {
  return win.evaluate(() => globalThis.getSelection()?.removeAllRanges())
}

/** 요소의 글자 위를 사람처럼 훑는다 — 왼쪽 위에서 오른쪽 아래로. */
async function dragAcross(win, locator, what) {
  await clearSelection(win)
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${what} was not on screen`)
  const inset = Math.min(6, box.height / 2)
  await win.mouse.move(box.x + 1, box.y + inset)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width - 1, box.y + box.height - inset, { steps: 20 })
  await win.mouse.up()
  await win.waitForTimeout(200)
  return win.evaluate(() => globalThis.getSelection()?.toString() ?? '')
}

async function expectSelectable(win, locator, expected, what) {
  const selected = await dragAcross(win, locator, what)
  if (!selected.includes(expected)) {
    throw new Error(`${what} could not be selected by dragging: got ${JSON.stringify(selected)}`)
  }
}

/** 한 요소에서 시작해 다른 요소 위에서 손을 떼는 드래그. */
async function dragBetween(win, from, to) {
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  if (!start || !end) throw new Error('drag endpoints were not both on screen')
  await clearSelection(win)
  await win.mouse.move(start.x + 2, start.y + 6)
  await win.mouse.down()
  await win.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 })
  await win.mouse.up()
  await win.waitForTimeout(600)
}
