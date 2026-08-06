import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppServer } from '../codex/appServer'
import { RPC, SERVER_REQUEST } from '../codex/wire'
import { delegateThreadInstructions } from './catalog'
import { WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'

/**
 * **모델이 우리 도구를 고르는가** 를 센다.
 *
 * 이 파일만 다른 종류의 테스트다. 나머지는 배관이 맞는지 보지만(도구가 붙었나 · 왕복이 되나),
 * 여기는 그 배관이 다 맞은 뒤에도 남는 문제를 본다 — 실제 실패가 정확히 거기였다: MCP 핸드셰이크도
 * tools/list 도 정상인데 모델이 자기 네이티브 서브에이전트를 골랐다.
 *
 * 그래서 이건 프롬프트 싸움이고, 프롬프트 싸움은 **세어야** 안다. 문구나 도구 이름을 만질 때마다
 * "이제 될 겁니다" 라고 말하는 대신 이 숫자를 본다.
 *
 * 모델을 실제로 부르므로 기본은 건너뛴다. 표현 하나에 한 턴씩 쓴다:
 *
 *   WOOI_E2E_CHOICE=1 npx vitest run src/main/subagent/choice.e2e.test.ts
 */

function codexPath(): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    return execFileSync(shell, ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const CODEX = codexPath()
const SERVER = join(process.cwd(), 'out', 'main', 'toolShim.js')
const ENABLED = process.env.WOOI_E2E_CHOICE === '1'

/**
 * 사용자가 **다른 제품을 지목한** 표현들. 전부 위임 도구로 가야 맞다.
 *
 * 한국어와 영어를 섞는다 — 실제 실패가 한국어("claude subagent를 생성해서")에서 났고, 어휘
 * 매칭이 언어를 건너 작동하는지가 이 기능의 관건이다.
 */
const NAMED: string[] = [
  'claude subagent를 하나 생성해서 README.md 첫 줄만 읽고 알려달라고 해줘.',
  'Claude 한테 이 저장소의 package.json name 필드가 뭔지 물어봐 줘.',
  'Have a Claude subagent tell me the name field in package.json.',
  'codex, claude 서브에이전트를 각각 하나씩 만들어서 README.md 첫 줄을 읽어 오라고 해줘.',
  'Claude 랑 Codex 둘 다한테 package.json 의 name 을 물어보고 답을 비교해줘.'
]

/** 제품을 지목하지 **않은** 표현. 네이티브를 써도 맞으므로 위임이 없어도 실패가 아니다. */
const UNNAMED: string[] = ['서브에이전트를 하나 띄워서 README.md 첫 줄을 읽어와 줘.']

interface Attempt {
  prompt: string
  /**
   * 모델이 위임 도구를 부른 횟수.
   *
   * **알림(item/started)에서 센다.** 브리지 도착 수로 세면 안 된다 — codex 는 MCP 도구 호출마다
   * 클라이언트에 승인(elicitation)을 물으므로, 승인 경로가 빠진 하네스에서는 모델이 제대로
   * 골랐는데도 0 이 나온다(실제로 그 실수로 두 번 잘못 읽었다). 여기서 세려는 것은 **모델의
   * 선택**이지 승인 흐름이 아니다.
   */
  delegated: number
}

let app: AppServer | null = null
let socket: Server | null = null
afterEach(() => {
  app?.dispose()
  app = null
  socket?.close()
  socket = null
  rmSync(SOCKET_PATH, { force: true })
})

const SOCKET_PATH = join(tmpdir(), `wooi-choice-${process.pid}.sock`)

/**
 * 메인 대신 도구 소켓을 받아 **성공**을 돌려준다.
 *
 * 서브런을 실제로 돌리지 않는 이유는 세려는 것이 모델의 선택이지 서브에이전트의 실력이 아니기
 * 때문이다. 그렇다고 실패를 돌려주면 안 된다 — 실패한 도구는 모델이 다시 부르므로 호출 **횟수**가
 * 의미를 잃는다. 실제로 두 번 잘못 읽었다: 소켓을 안 열었을 때(연결 실패)도, 프로토콜대로
 * 거절했을 때도 횟수가 2~6 으로 튀었다. 성공을 돌려줘야 "몇 개를 띄우려 했나" 가 그대로 남는다.
 */
function startStubSocket(): Server {
  rmSync(SOCKET_PATH, { force: true })
  const server = createServer((conn) => {
    conn.on('data', () => {
      conn.write(
        JSON.stringify({
          ok: true,
          data: { text: 'Probe run — the subagent did not really run.' }
        }) + '\n'
      )
      conn.end()
    })
  })
  server.listen(SOCKET_PATH)
  return server
}

/** 표현 하나를 실제 Codex 스레드에 넣고 위임 도구 호출 수를 센다. */
async function attempt(prompt: string): Promise<Attempt> {
  let delegated = 0
  socket = startStubSocket()
  app = new AppServer({
    executable: CODEX!,
    onNotification: (method, params) => {
      if (method !== 'item/started') return
      const item = (params as { item?: { type?: string; server?: string } })?.item
      if (item?.type === 'mcpToolCall' && item.server === WOOI_MCP_SERVER_NAME) delegated += 1
    },
    // 승인에 답하지 않으면 도구 호출이 그 자리에서 멈춘다. 여기서 재는 것은 승인 정책이 아니므로
    // 무조건 수락한다 — 실제 앱에서는 codex-host 가 이 요청을 사용자 질문 UI 로 옮긴다.
    requestHandlers: {
      [SERVER_REQUEST.elicitation]: async () => ({ action: 'accept', content: {} })
    },
    onExit: () => {}
  })

  const rpc = await app.rpc()
  const started = await rpc.request<{ thread?: { id?: string } }>(RPC.threadStart, {
    cwd: process.cwd(),
    sandbox: 'read-only',
    // 제품 경로와 같게 싣는다(codex/thread.ts). 이게 빠지면 모델이 도구의 존재를 모른다.
    developerInstructions: delegateThreadInstructions(['claude', 'codex']),
    // 제품 경로와 같은 모양 — 하나의 shim 을 위임 도구까지 켜서 스레드 단위로 선언한다.
    config: {
      mcp_servers: {
        [WOOI_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [SERVER],
          env: { WOOI_TOOL_SOCKET: SOCKET_PATH, WOOI_TOOL_DELEGATE: 'claude,codex' }
        }
      }
    }
  })

  await rpc.request(RPC.turnStart, {
    threadId: started?.thread?.id,
    input: [{ type: 'text', text: prompt }],
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'never'
  })

  // 턴이 끝날 때까지 기다린다. turn/completed 를 구독하지 않고 넉넉히 재우는 이유는, 세려는 것이
  // "이 턴에 위임이 있었나" 뿐이라 정확한 종료 시점이 필요 없기 때문이다.
  await new Promise((r) => setTimeout(r, 45_000))
  app.dispose()
  app = null
  socket.close()
  socket = null
  return { prompt, delegated }
}

describe.skipIf(!ENABLED || !CODEX || !existsSync(SERVER))('모델이 위임 도구를 고르는가', () => {
  it(
    '제품을 지목한 요청은 위임으로 간다',
    async () => {
      const results: Attempt[] = []
      for (const prompt of NAMED) results.push(await attempt(prompt))

      for (const r of results) {
        console.log(`${r.delegated > 0 ? 'HIT ' : 'MISS'}  ${r.delegated}  ${r.prompt}`)
      }
      const hits = results.filter((r) => r.delegated > 0).length
      console.log(`\nnamed: ${hits}/${results.length}`)

      // 전부를 요구하지 않는다 — 모델 선택이라 결정적이지 않고, 그걸 100% 로 못 박으면 테스트가
      // 사실이 아니라 소원이 된다. 과반이면 문구가 이기고 있다고 본다.
      expect(hits * 2).toBeGreaterThan(results.length)
    },
    NAMED.length * 120_000
  )

  it(
    '제품을 지목하지 않은 요청은 네이티브로 가도 된다',
    async () => {
      // 실패로 판정하지 않는다. 위임을 너무 세게 밀어붙여 **아무 서브에이전트나 이 도구로**
      // 흘러가는 과교정을 눈으로 보기 위한 관찰용이다.
      for (const prompt of UNNAMED) {
        const r = await attempt(prompt)
        console.log(`unnamed  delegated=${r.delegated}  ${r.prompt}`)
      }
      expect(true).toBe(true)
    },
    UNNAMED.length * 120_000
  )
})
