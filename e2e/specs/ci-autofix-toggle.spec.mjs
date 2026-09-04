/* global console, process, window */

import { seedAppState, openSeededWorkspace, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

const PR_NUMBER = 42
const TOGGLE = 'Fix failing checks with the agent'
const FAILING_CHECK = 'ci / e2e-coverage'

/**
 * 실패한 CI 를 에이전트에게 넘기는 토글이 **꺼진 채로 오고**, 켠 것이 워크스페이스에 남는지 본다.
 *
 * 유닛 테스트(decideCiFix)는 "언제 턴을 열고 언제 멈추는지" 를 이미 못박는다. 여기서만 확인할
 * 수 있는 것은 그 판정으로 가는 **스위치가 실제로 사용자 손에 닿는지**다 — Check 탭에 있는지,
 * 기본이 꺼짐인지, 누른 것이 메인까지 가서 남는지.
 *
 * 기본값이 꺼짐이라는 것을 화면에서 확인하는 것이 특히 중요하다. 이 토글은 사용자가 치지 않은
 * 턴을 열어 토큰을 쓰고 브랜치에 커밋을 만든다. 어떤 회귀로 기본이 켜짐이 되면 유닛 테스트는
 * 전부 초록인 채로 사람들이 켠 적 없는 비용을 물게 된다.
 *
 * gh 는 부르지 않는다 — 체크 조회와 인증 상태를 메인에서 스텁으로 갈아 끼워 네트워크 없이 돈다.
 */
export default async function CI_자동수정_토글은_꺼진_채로_오고_켜면_남는다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      // PR 이 있어야 Check 탭이 의미가 있다. autoFixCi 는 일부러 주지 않는다 — 레거시
      // 워크스페이스와 같은 "필드가 아예 없는" 상태에서 출발해야 기본값을 검증한 것이 된다.
      seed: (scratch) => seedAppState(scratch, { workspace: { prNumber: PR_NUMBER } })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      const win = wooi.win
      const workspaceState = () =>
        win.evaluate(async () => {
          const state = await window.api.getState()
          const ws = state.workspaces[0]
          return { autoFixCi: ws?.autoFixCi ?? null, progress: ws?.autoFixCiState ?? null }
        })

      try {
        await openSeededWorkspace(win)

        // 백엔드 목록을 손으로 적지 않으려고 진짜 상태를 먼저 받아 온다 — agents 가 하나라도
        // 빠지면 그 값을 읽는 패널들이 통째로 터진다.
        const realAuth = await win.evaluate(() => window.api.auth.getStatus())

        await wooi.app.evaluate(
          ({ ipcMain, BrowserWindow }, { auth, checks }) => {
            ipcMain.removeHandler('auth:getStatus')
            ipcMain.handle('auth:getStatus', () => auth)
            ipcMain.removeHandler('pr:checks')
            ipcMain.handle('pr:checks', () => checks)
            // 렌더러는 인증 상태를 기동 때 한 번 읽었다. 바뀌었다고 알려야 다시 읽는다.
            for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:authChanged')
          },
          {
            auth: { ...realAuth, github: { installed: true, loggedIn: true } },
            checks: {
              prNumber: PR_NUMBER,
              prUrl: `https://github.com/e2e/repo/pull/${PR_NUMBER}`,
              checks: [
                { name: 'ci / verify', state: 'success' },
                { name: FAILING_CHECK, state: 'failure', url: 'https://example.invalid/run' }
              ]
            }
          }
        )

        // ── 1. Check 탭에 실패한 체크와 토글이 함께 있다 ──────────────────────
        await win.getByRole('button', { name: 'Check', exact: true }).click()
        await win.getByText(FAILING_CHECK).waitFor({ timeout: 15_000 })

        const toggle = win.getByRole('switch', { name: TOGGLE })
        await toggle.waitFor({ timeout: 10_000 })

        // ── 2. 기본은 꺼짐이다 ────────────────────────────────────────────────
        const initial = await toggle.getAttribute('aria-checked')
        if (initial !== 'false') {
          throw new Error(`토글이 켜진 채로 왔다: aria-checked=${initial}`)
        }
        const before = await workspaceState()
        if (before.autoFixCi) {
          throw new Error(`저장된 상태가 켜짐이다: ${JSON.stringify(before)}`)
        }
        await win.getByText('nothing is sent to the agent', { exact: false }).waitFor()
        console.log(`[e2e] screenshot=${await wooi.shot('ci-autofix-off')}`)

        // ── 3. 켜면 메인까지 가서 남는다 ──────────────────────────────────────
        await toggle.click()
        await win.getByText(`3 of 3 attempts left`, { exact: false }).waitFor({ timeout: 10_000 })

        const after = await workspaceState()
        if (after.autoFixCi !== true) {
          throw new Error(`켠 것이 워크스페이스에 남지 않았다: ${JSON.stringify(after)}`)
        }
        console.log(`[e2e] screenshot=${await wooi.shot('ci-autofix-on')}`)

        // ── 4. 끄면 진행 상태까지 함께 지워진다 ───────────────────────────────
        // 다시 켤 때 남은 시도가 0 인 채로 시작하면 아무 일도 일어나지 않아, 사용자는 토글이
        // 고장 났다고 읽는다. 그래서 끄는 것이 곧 시도 횟수 초기화여야 한다.
        await toggle.click()
        const off = await workspaceState()
        if (off.autoFixCi !== false || off.progress !== null) {
          throw new Error(`끈 뒤에도 상태가 남았다: ${JSON.stringify(off)}`)
        }

        await waitForInspection(win)
      } finally {
        await wooi.close()
      }
    }
  )
}
