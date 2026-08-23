/* global console, process */

import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  E2E_WORKSPACE_DISPLAY_NAME,
  openRowMenuItem,
  openSeededWorkspace,
  seedAppState,
  waitForInspection
} from '../fixtures.mjs'

const SEEDED_SESSION = 'session-e2e-seeded'
const COPIED_LINE = 'Bumped answer to 42.'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * 분기가 **원본의 지금 상태**를 물려받는지 확인한다.
 *
 * 여기서 값진 것은 워크스페이스가 하나 더 생겼다는 사실이 아니라, 무엇을 들고 왔는가다. 원본에
 * 아직 푸시하지 않은 커밋과 커밋조차 하지 않은 변경을 하나씩 심어 두고 분기하는 이유가 그것이다
 * — 옛 구현처럼 origin/<base> 에서 따면 둘 다 조용히 빠지고, 대화는 없는 코드를 이야기한다.
 *
 * 모델 턴은 돌리지 않는다. 시드한 sessionId 는 실재하지 않으므로 Claude 세션 승계는 실패하는데,
 * 그 실패 자체가 확인 대상이다: 워크스페이스는 만들어지고 기록은 복사되며, **원본의 sessionId 를
 * 그대로 입지는 않는다**. 두 워크스페이스가 같은 세션을 resume 하면 한 기록에 메시지가 섞이는데,
 * 이 기능이 존재하는 이유가 바로 그 상황을 만들지 않는 것이다.
 */
export default async function 대화를_분기하면_원본의_코드와_기록을_물려받는다() {
  const { withScratchRepo, launchWooi } = await import(
    pathToFileURL(join(process.env.WOOI_E2E_HARNESS, 'index.mjs')).href
  )
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        const source = scratch.worktrees['feature-test']
        // 아직 어디에도 올리지 않은 커밋 하나.
        await writeFile(join(source, 'answer.ts'), 'export const answer = 42\n')
        git(source, 'add', '-A')
        git(source, 'commit', '-m', 'local-only commit')
        // 커밋조차 하지 않은 변경 하나. **추적 중인** 파일이라야 한다 — 스냅샷은
        // `git stash create` 라 추적하지 않는 새 파일을 담지 않는다(git.ts 에 적어 둔 경계).
        // 새 파일로 시험하면 기능이 아니라 그 경계를 시험하게 된다.
        await appendFile(join(source, 'README.md'), 'uncommitted-marker\n')
        return seedAppState(scratch, {
          transcript: [
            { id: 'user-fork', type: 'user', text: COPIED_LINE, ts: Date.now() - 1 },
            { id: 'assistant-fork', type: 'assistant', text: 'Noted.', ts: Date.now() }
          ],
          // 전역 기본과 다른 값이라야 "물려받았다" 가 증명된다.
          workspace: { permissionMode: 'plan', model: 'e2e-inherited-model' }
        })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        const item = await openRowMenuItem(wooi.win, 'Fork conversation')
        if (await item.isDisabled()) {
          throw new Error('fork was disabled for a workspace that has a conversation')
        }
        await item.click()

        // 분기는 worktree 추가·스냅샷 적용·세션 승계 시도를 거치므로 상태로 기다린다.
        const state = await waitFor(
          wooi.win,
          (s) => s.workspaces.find((w) => w.forkedFromWorkspaceId === 'ws-e2e'),
          'forked workspace never appeared'
        )
        const source = state.workspaces.find((w) => w.id === 'ws-e2e')
        const fork = state.workspaces.find((w) => w.forkedFromWorkspaceId === 'ws-e2e')

        // ── 관계와 승계 ────────────────────────────────────────────────
        // 분기는 원본의 형제다. base 가 원본 브랜치가 되면 원본을 먼저 머지해야만 분기가
        // 머지되는, 없던 의존이 생긴다.
        expect(fork.baseBranch, source.baseBranch, 'fork baseBranch')
        if (fork.baseBranch === source.branch) {
          throw new Error('fork was stacked on its origin instead of aiming at the same base')
        }
        expect(fork.parentWorkspaceId, source.parentWorkspaceId, 'fork parentWorkspaceId')
        expect(fork.permissionMode, 'plan', 'fork permissionMode')
        expect(fork.model, 'e2e-inherited-model', 'fork model')
        // displayName 에 무언가 써 넣으면 그것이 "사용자가 정한 이름" 이 되어 나중에 PR 제목이
        // 영영 이기지 못한다(workspaceDisplayName 의 우선순위).
        expect(fork.displayName, null, 'fork displayName')
        if (fork.sessionId === source.sessionId || fork.sessionId === SEEDED_SESSION) {
          throw new Error(`fork adopted the origin's session id: ${fork.sessionId}`)
        }

        // ── 코드 상태 ──────────────────────────────────────────────────
        expect(
          (await readFile(join(fork.worktreePath, 'answer.ts'), 'utf8')).trim(),
          'export const answer = 42',
          "fork's unpushed commit"
        )
        const forkReadme = await readFile(join(fork.worktreePath, 'README.md'), 'utf8')
        if (!forkReadme.includes('uncommitted-marker')) {
          throw new Error(`fork did not carry the origin's uncommitted change: ${forkReadme}`)
        }
        // 스냅샷은 원본을 건드리지 않는다(git stash create 는 스택에 쌓지 않는다).
        if (!git(source.worktreePath, 'status', '--porcelain').includes('README.md')) {
          throw new Error('forking consumed the uncommitted change from the origin worktree')
        }

        // ── 기록 ──────────────────────────────────────────────────────
        const copied = await readFile(
          join(scratch.userDataPath, 'transcripts', `${fork.id}.jsonl`),
          'utf8'
        )
        if (!copied.includes(COPIED_LINE)) {
          throw new Error('the origin conversation was not copied into the fork')
        }

        // ── 화면 ──────────────────────────────────────────────────────
        // 만들고 나면 그쪽으로 옮겨 간다 — 찾아가야 하는 분기는 이 기능의 요점을 놓친다.
        await wooi.win.locator(`.workspace-header [title^="${fork.name}"]`).waitFor()
        await wooi.win.getByText(`⑂ from ${E2E_WORKSPACE_DISPLAY_NAME}`).first().waitFor()

        // 관계는 부제로만 말한다. 사이드바의 들여쓰기는 "저 브랜치 위에 쌓였다" 는 뜻이고
        // 분기는 그 관계가 아니므로, 분기 행은 원본과 **같은 깊이**여야 한다.
        const indents = await wooi.win.evaluate(
          ([originName, forkName]) => {
            const indentOf = (label) => {
              const el = [...globalThis.document.querySelectorAll('[role="button"]')].find((node) =>
                node.textContent?.includes(label)
              )
              return el ? globalThis.getComputedStyle(el).paddingLeft : null
            }
            return { origin: indentOf(originName), fork: indentOf(forkName) }
          },
          [E2E_WORKSPACE_DISPLAY_NAME, fork.name]
        )
        if (!indents.origin || indents.origin !== indents.fork) {
          throw new Error(`fork was indented like a stack child: ${JSON.stringify(indents)}`)
        }

        const screenshot = await wooi.shot('conversation-fork')
        console.log(
          `[e2e] fork=${JSON.stringify({
            name: fork.name,
            baseBranch: fork.baseBranch,
            permissionMode: fork.permissionMode,
            model: fork.model,
            sessionInherited: fork.sessionId !== null
          })} screenshot=${screenshot}`
        )
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}

function expect(actual, wanted, what) {
  if (actual !== wanted) {
    throw new Error(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
  }
}

/** 상태가 조건을 만족할 때까지 기다린다. 실패하면 무엇을 기다렸는지 남긴다. */
async function waitFor(win, predicate, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    state = await win.evaluate(() => globalThis.api.getState())
    if (predicate(state)) return state
    await win.waitForTimeout(500)
  }
  throw new Error(`${message} (workspaces: ${state?.workspaces.map((w) => w.name).join(', ')})`)
}
