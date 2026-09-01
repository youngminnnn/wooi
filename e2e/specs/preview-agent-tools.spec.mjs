/* global console, process, URL */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 에이전트의 프리뷰 도구는 **메인 밖에서 절반이 일어난다.**
 *
 * `open_preview` 는 메인에서 시작하지만, 그 다음은 렌더러가 Preview 탭을 열고 `<webview>` 게스트를
 * 붙이고 dom-ready 에 자기를 등록해야 비로소 메인이 그 게스트를 찾을 수 있다. 그리고 콘솔·네트워크
 * 문제는 진짜 Electron 세션에서만 나온다. 유닛 테스트는 이 사슬을 통째로 mock 으로 대체하므로,
 * 여기서 보는 것은 **그 mock 이 실제와 같은가** 다.
 *
 * 그래서 진짜 dev 서버를 띄운다 — run 스크립트로 작은 HTTP 서버를 돌리고, 그 로그에서 주소를
 * 뽑아 프리뷰를 열고, 그 페이지가 실제로 찍은 콘솔 에러와 404 를 도구로 다시 읽는다. 사용자가
 * 겪는 경로 그대로다(run_script → open_preview → read_preview_issues).
 *
 * `capture_preview` 는 `agent` 모드 커맨드라 모델 없이는 부를 수 없다. 대신 그 도구가 딛고 선
 * **플랫폼 가정**을 여기서 확인한다 — 우리가 연 게스트가 화면에 있을 때 `capturePage` 가 빈
 * 이미지가 아닌 것을 준다. 핸들러 로직은 유닛 테스트가 본다.
 */

const WORKTREE = 'feature-test'
const SCRIPT_NAME = 'Dev'
const SERVER_FILE = 'e2e-preview-server.mjs'
const FIRST_MARK = 'preview boom on the first page'
const SECOND_MARK = 'preview boom on the second page'
const MISSING_PATH = '/missing-on-purpose'

/**
 * 포트를 0 으로 열고 **자기가 주소를 찍는다.** Wooi 는 시드된 워크스페이스에 포트를 배정하지
 * 않으므로(ports: {}), 여기서 검증되는 것은 `detectDevUrl` 이 로그에서 주소를 뽑는 실제 경로다.
 */
const SERVER_SOURCE = `import { createServer } from 'node:http'

const FIRST = ${JSON.stringify(FIRST_MARK)}
const SECOND = ${JSON.stringify(SECOND_MARK)}
const MISSING = ${JSON.stringify(MISSING_PATH)}

function page(title, mark) {
  return (
    '<!doctype html><html><head><title>' + title + '</title></head>' +
    '<body style="font-family:system-ui;padding:48px;background:#111;color:#eee">' +
    '<h1>' + title + '</h1>' +
    '<script>console.error(' + JSON.stringify(mark) + ');' +
    'fetch(' + JSON.stringify(MISSING) + ').catch(function () {});</script>' +
    '</body></html>'
  )
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('first page', FIRST))
    return
  }
  if (path === '/second') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('second page', SECOND))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('nope')
})

server.listen(0, '127.0.0.1', () => {
  console.log('  \u279c  Local:   http://127.0.0.1:' + server.address().port + '/')
})
`

/**
 * direct 커맨드를 돌리고 카드가 무엇을 말했는지 돌려준다.
 *
 * 성공은 `<pre>` 의 JSON, 실패는 카드 본문 문장이다 — 이 스펙은 **실패 문장도 단언한다**.
 * "왜 프리뷰를 열 수 없는지" 를 사유별로 말하는 것이 이 기능의 계약이기 때문이다.
 */
async function runCommand(win, text) {
  const title = text.split(' ')[0]
  const box = win.locator('textarea[placeholder^="Message your agent"]')
  // 뒤 공백이 슬래시 자동완성을 닫는다(Escape 는 초안을 통째로 지우므로 쓰지 않는다 —
  // message-status.spec.mjs 와 같은 수법).
  await box.fill(`${text} `)
  await box.press('Enter')

  const heading = win.getByText(title, { exact: true }).last()
  await heading.waitFor()
  const card = heading.locator('xpath=ancestor::div[contains(@class,"bottom-full")][1]')

  for (let attempt = 0; attempt < 400; attempt++) {
    if ((await card.locator('pre').count()) > 0) {
      const parsed = JSON.parse(await card.locator('pre').innerText())
      await box.press('Escape')
      return { result: parsed }
    }
    const body = await card.innerText()
    if (!body.includes('Running…')) {
      await box.press('Escape')
      return { error: body }
    }
    await win.waitForTimeout(100)
  }
  throw new Error(`${text} never settled into a card`)
}

/** 조건이 맞을 때까지 같은 커맨드를 다시 돌린다(서버 기동·문제 수집은 즉시가 아니다). */
async function until(win, command, accept, what) {
  let last = null
  for (let attempt = 0; attempt < 40; attempt++) {
    last = await runCommand(win, command)
    if (last.result && accept(last.result)) return last.result
    await win.waitForTimeout(500)
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`)
}

export default async function 에이전트가_프리뷰를_열고_에러를_읽는다() {
  await withScratchRepo(
    {
      worktrees: [WORKTREE],
      seed: async (scratch) => {
        await writeFile(join(scratch.worktrees[WORKTREE], SERVER_FILE), SERVER_SOURCE)
        await seedAppState(scratch, {
          repo: {
            runScripts: [
              {
                id: 'run-dev',
                name: SCRIPT_NAME,
                command: `node ${SERVER_FILE}`,
                autoStart: false
              }
            ]
          }
        })
      }
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // 1. dev 서버가 없으면 "열 수 없다" 가 아니라 **무엇이 없는지**를 말해야 한다. 스크립트는
        //    설정돼 있고 돌고 있지 않으므로, 다음 행동(run_script)까지 문장에 있어야 한다.
        const blocked = await runCommand(wooi.win, '/wooi:preview')
        if (!blocked.error?.includes('No run script is running')) {
          throw new Error(`stopped dev server did not name the reason: ${JSON.stringify(blocked)}`)
        }
        if (!blocked.error.includes('run_script') || !blocked.error.includes(SCRIPT_NAME)) {
          throw new Error(`reason did not say what to do next: ${JSON.stringify(blocked)}`)
        }

        // 2. 사람이 쓰는 그 도구로 서버를 띄운다.
        const started = await runCommand(wooi.win, `/wooi:run ${SCRIPT_NAME}`)
        if (started.result?.name !== SCRIPT_NAME) {
          throw new Error(`run_script did not start the script: ${JSON.stringify(started)}`)
        }

        // 3. 로그에 주소가 찍히면 프리뷰가 열린다. 서버 기동을 기다리므로 될 때까지 다시 부른다.
        const opened = await until(
          wooi.win,
          '/wooi:preview',
          (r) => typeof r.url === 'string',
          'open_preview never found the dev server'
        )
        if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(opened.url)) {
          throw new Error(`open_preview returned an unexpected address: ${opened.url}`)
        }
        const origin = new URL(opened.url).origin

        // 4. 도구가 말만 한 것이 아니라 **화면이 실제로 그렇게 되었는지** 본다. 게스트가 붙고
        //    주소창이 그 주소를 비추는 것이 렌더러까지 신호가 닿았다는 증거다.
        const address = wooi.win.locator('input[aria-label="Preview address"]')
        await address.waitFor()
        for (let attempt = 0; attempt < 40; attempt++) {
          if ((await address.inputValue()) === opened.url) break
          await wooi.win.waitForTimeout(250)
        }
        if ((await address.inputValue()) !== opened.url) {
          throw new Error(
            `preview address bar did not follow the tool: ${await address.inputValue()}`
          )
        }
        if ((await wooi.win.locator('webview').count()) === 0) {
          throw new Error('the preview tab opened without attaching a guest')
        }

        // 5. 그 페이지가 실제로 찍은 콘솔 에러와 실패한 요청이 도구로 되돌아와야 한다. 이건
        //    진짜 Electron 세션에서만 나오는 값이라 유닛 테스트가 볼 수 없는 부분이다.
        const issues = await until(
          wooi.win,
          '/wooi:preview-errors',
          (r) =>
            r.previewOpen === true &&
            (r.issues ?? []).some((i) => i.text?.includes(FIRST_MARK)) &&
            (r.issues ?? []).some((i) => i.text?.includes(MISSING_PATH)),
          'the console error and the failed request never reached read_preview_issues'
        )
        const failed = issues.issues.find((i) => i.text.includes(MISSING_PATH))
        if (failed.kind !== 'network' || !failed.text.startsWith('404 ')) {
          throw new Error(`the failed request was not reported as a 404: ${JSON.stringify(failed)}`)
        }
        if (issues.errors < 1) {
          throw new Error(`the console error was not counted: ${JSON.stringify(issues)}`)
        }

        // 6. capture_preview 가 딛고 선 가정 — 우리가 연 게스트는 화면에 있을 때 실제로 그려진다.
        //    핸들러는 유닛 테스트가 보므로 여기서는 플랫폼 쪽만 확인한다.
        const painted = await wooi.app.evaluate(async ({ webContents }) => {
          const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview')
          if (!guest) return { found: false }
          const image = await guest.capturePage()
          const size = image.getSize()
          return {
            found: true,
            empty: image.isEmpty(),
            width: size.width,
            height: size.height,
            url: guest.getURL()
          }
        })
        if (!painted.found || painted.empty || painted.width === 0) {
          throw new Error(
            `the preview guest rendered nothing to capture: ${JSON.stringify(painted)}`
          )
        }
        if (!painted.url.startsWith(origin)) {
          throw new Error(`captured a guest that is not this workspace's preview: ${painted.url}`)
        }

        // 7. 경로를 주면 그 경로로 간다. 그리고 이동하면 앞 페이지의 문제는 접힌다 — 안 접으면
        //    "고쳤는데도 그대로다" 로 보인다.
        const second = await runCommand(wooi.win, '/wooi:preview /second')
        if (second.result?.url !== `${origin}/second`) {
          throw new Error(`open_preview ignored the path: ${JSON.stringify(second)}`)
        }
        const afterNav = await until(
          wooi.win,
          '/wooi:preview-errors',
          (r) => (r.issues ?? []).some((i) => i.text?.includes(SECOND_MARK)),
          'the second page never reported its own console error'
        )
        if (afterNav.issues.some((i) => i.text.includes(FIRST_MARK))) {
          throw new Error(
            `navigating did not drop the previous page's issues: ${JSON.stringify(afterNav)}`
          )
        }

        await runCommand(wooi.win, `/wooi:stop ${SCRIPT_NAME}`)

        const screenshot = await wooi.shot('preview-agent-tools')
        console.log(
          `[e2e] preview=${opened.url} issues=${issues.total} capture=${painted.width}x${painted.height} screenshot=${screenshot}`
        )
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
