/* global console, process */

import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 아티팩트는 **유닛 테스트가 볼 수 없는 곳에서 산다.**
 *
 * 저장소·URL 문법·컴파일러는 유닛 테스트가 이미 증명한다. 여기서 보는 것은 그것들이 딛고 선
 * **플랫폼 가정**이다 — 커스텀 스킴이 진짜 origin 을 갖는가, 파티션이 갈려 있는가, 그리고
 * 무엇보다 **그 게스트가 망에 못 닿는가**. 이건 진짜 Electron 세션에서만 나오는 값이라
 * mock 으로는 흉내조차 낼 수 없고, 실제로 개발 중에 두 번 물렸다(CJS 재노출이 런타임에만
 * 깨졌다).
 *
 * 봉쇄가 이 스펙의 존재 이유다. CSP 한 줄이나 `preview.ts` 의 세션 분기가 나중에 완화되면
 * 아티팩트는 **여전히 잘 보이면서** 조용히 망으로 나가게 된다. 화면만 보는 검사로는 절대 못
 * 잡는다.
 *
 * 그래서 진짜 서버를 세우고 **거기에 무엇이 도착하는지**로 판정한다. 게스트 안의 반환값을
 * 믿으면 안 된다 — `sendBeacon` 은 요청이 나갔는지가 아니라 큐에 넣었는지를 돌려주고,
 * `WebSocket` 생성자는 CSP 에 막혀도 동기적으로 던지지 않는다. 실제로 이 스펙의 첫 판을
 * 그렇게 썼다가 멀쩡한 샌드박스를 유출로 오진했다.
 *
 * 도구 핸들러를 부르지 않고 디스크에 직접 시드하는 이유: `/wooi:artifact` 는 `agent` 모드라
 * 모델 없이는 부를 수 없다. 핸들러 로직은 유닛 테스트가 보므로, 여기서는 **디스크에 있는
 * 아티팩트가 화면까지 오는 경로**만 본다.
 */

const WORKSPACE_ID = 'ws-e2e'
const ARTIFACT_ID = 'e2e-artifact'
const MARKER = 'artifact rendered from its own scheme'
const ARTIFACT_ORIGIN = 'wooi-artifact://a'
const ARTIFACT_PARTITION = 'wooi-artifact'

/** 게스트가 붙고 loadURL 이 끝날 때까지. 로컬 파일이라 보통 한두 번이면 된다. */
async function untilGuest(wooi, predicate, message) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const seen = await wooi.app.evaluate(async ({ webContents, session }, partition) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.session === session.fromPartition(partition))
      if (!guest || guest.isDestroyed()) return { found: false }
      return { found: true, url: guest.getURL() }
    }, ARTIFACT_PARTITION)
    if (predicate(seen)) return seen
    await wooi.win.waitForTimeout(250)
  }
  throw new Error(message)
}

/** 게스트 안에서 코드를 돌린다. 봉쇄를 확인하는 유일한 방법이다. */
function inGuest(wooi, source) {
  return wooi.app.evaluate(
    async ({ webContents, session }, { partition, code }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.session === session.fromPartition(partition))
      if (!guest) throw new Error('no artifact guest to run in')
      return guest.executeJavaScript(code)
    },
    { partition: ARTIFACT_PARTITION, code: source }
  )
}

export default async function 아티팩트가_격리된_스킴에서_뜨고_망에는_못_닿는다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: async (scratch) => {
        await seedAppState(scratch)

        // 도구가 썼을 법한 모양 그대로 눕힌다 — 본문 + 같이 구운 스타일시트.
        const dir = join(scratch.userDataPath, 'artifacts', WORKSPACE_ID)
        await mkdir(join(dir, ARTIFACT_ID, '1'), { recursive: true })
        await writeFile(
          join(dir, ARTIFACT_ID, '1', 'index.html'),
          `<!doctype html><html><head><meta charset="utf-8"><title>E2E artifact</title>` +
            `<link rel="stylesheet" href="./style.css"></head>` +
            `<body><h1 id="m" class="flex">${MARKER}</h1></body></html>`
        )
        await writeFile(join(dir, ARTIFACT_ID, '1', 'style.css'), '#m{color:rgb(0, 128, 0)}')
        await writeFile(
          join(dir, 'index.jsonl'),
          JSON.stringify({
            id: ARTIFACT_ID,
            version: 1,
            kind: 'html',
            title: 'E2E artifact',
            createdAt: Date.now(),
            hasCss: true
          }) + '\n'
        )
      }
    },
    async (scratch) => {
      // 지상 검증용 서버. 여기에 요청이 하나라도 닿으면 봉쇄가 뚫린 것이다.
      const leaked = []
      const leakServer = createServer((req, res) => {
        leaked.push(req.url)
        res.end('LEAKED')
      })
      leakServer.on('upgrade', (req) => leaked.push(`WS ${req.url}`))
      await new Promise((resolve) => leakServer.listen(0, '127.0.0.1', resolve))
      const leakPort = leakServer.address().port

      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)

        // 1. 탭을 누르면 게스트가 붙는다(누르기 전에는 만들지 않는다 — 안 쓸 게스트를
        //    워크스페이스마다 띄울 이유가 없다).
        await wooi.win.getByRole('button', { name: 'Artifacts' }).click()
        await wooi.win.getByText('E2E artifact').first().waitFor()

        // 2. 디스크에 있는 것이 **우리 스킴으로** 실려야 한다. 여기가 저장소·URL 문법·
        //    protocol 핸들러가 처음으로 한 줄에 서는 지점이다.
        const expected = `${ARTIFACT_ORIGIN}/w/${WORKSPACE_ID}/${ARTIFACT_ID}/1/index.html`
        const guest = await untilGuest(
          wooi,
          (seen) => seen.found && seen.url === expected,
          'the artifact guest never loaded the artifact URL'
        )
        if (guest.url !== expected) {
          throw new Error(`artifact guest went somewhere else: ${guest.url}`)
        }

        // 3. 문서가 실제로 그려졌는가. protocol 핸들러가 우리 바이트를 건넨 증거다.
        const painted = await inGuest(
          wooi,
          `({
            marker: document.getElementById('m')?.textContent,
            styled: getComputedStyle(document.getElementById('m')).color,
            origin: location.origin,
            secure: window.isSecureContext
          })`
        )
        if (painted.marker !== MARKER) {
          throw new Error(`the artifact body was not served: ${JSON.stringify(painted)}`)
        }
        // 스타일시트까지 왔다는 뜻 — 문서가 링크한 형제 파일이 같은 스킴으로 해결된다.
        if (painted.styled !== 'rgb(0, 128, 0)') {
          throw new Error(`the artifact stylesheet did not load: ${JSON.stringify(painted)}`)
        }
        // standard + secure 스킴이라야 CSP 의 `'self'` 가 의미를 갖는다.
        if (painted.origin !== ARTIFACT_ORIGIN || painted.secure !== true) {
          throw new Error(`the artifact origin is not what CSP assumes: ${JSON.stringify(painted)}`)
        }

        // 4. **봉쇄.** 이 스펙이 존재하는 이유다. 모델이 쓴 코드가 방금 읽은 저장소의 내용을
        //    밖으로 실어 보낼 수 있으면 안 된다. 판정은 반환값이 아니라 **도착한 요청**이다.
        await inGuest(
          wooi,
          `(async () => {
            const T = 'http://127.0.0.1:${leakPort}'
            try { await fetch(T + '/leak-fetch') } catch {}
            try { new WebSocket('ws://127.0.0.1:${leakPort}/leak-ws') } catch {}
            try { navigator.sendBeacon(T + '/leak-beacon') } catch {}
            try { const x = new XMLHttpRequest(); x.open('GET', T + '/leak-xhr'); x.send() } catch {}
            new Image().src = T + '/leak-img'
            const s = document.createElement('script'); s.src = T + '/leak-script'
            document.body.appendChild(s)
            const f = document.createElement('iframe'); f.src = T + '/leak-iframe'
            document.body.appendChild(f)
            window.open(T + '/leak-open')
            return true
          })()`
        )
        // 요청이 나갈 시간을 준다 — 안 주면 "아직 안 왔다" 를 "안 나갔다" 로 오독한다.
        await wooi.win.waitForTimeout(1500)
        if (leaked.length > 0) {
          throw new Error(
            `the artifact sandbox let ${leaked.length} request(s) out: ${leaked.join(', ')} — ` +
              'a model-authored artifact can now exfiltrate what it just read'
          )
        }

        // 5. 최상위 이동도 막혀야 한다. CSP 로는 못 막는 자리라 세션 가드가 유일한 방어다.
        await inGuest(wooi, `location.href = 'https://example.com/nav-exfil'`)
        await wooi.win.waitForTimeout(1500)
        const stayed = await untilGuest(
          wooi,
          (seen) => seen.found,
          'the artifact guest disappeared after the navigation attempt'
        )
        if (!stayed.url.startsWith(ARTIFACT_ORIGIN)) {
          throw new Error(`the artifact navigated away from its origin: ${stayed.url}`)
        }

        console.log(`[e2e] screenshot=${await wooi.shot('artifact-sandbox')}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
        await new Promise((resolve) => leakServer.close(resolve))
      }
    }
  )
}
