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
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_BACKEND_IDS } from '@shared/types'
import { createWooiMcpServer } from '../claude/wooiMcp'
import { resolveClaudeExecutable } from '../claude/executable'
import { MCP_SETTING_SOURCES } from '../claude/mcp'
import { CLAUDE_CODE_SYSTEM_PROMPT } from '../claude/systemPrompt'

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
 * 두 백엔드를 **같은 표현으로** 잰다. 노출 방식이 서로 다르기 때문이다 — Claude 는 SDK 가 도구
 * 정의를 프롬프트에 직접 싣고, Codex 는 MCP 도구를 눈에 띄게 올려 주지 않아 스레드 지침으로
 * 존재를 알려야 한다. 표현을 공유해야 그 차이가 숫자로 드러난다.
 *
 * 모델을 실제로 부르므로 기본은 건너뛴다. 표현 하나에 한 턴씩 쓴다:
 *
 *   WOOI_E2E_CHOICE=1 npx vitest run src/main/subagent/choice.e2e.test.ts
 */

function cliExists(cli: string): boolean {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    return Boolean(execFileSync(shell, ['-lc', `command -v ${cli}`], { encoding: 'utf8' }).trim())
  } catch {
    return false
  }
}

function codexPath(): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    return execFileSync(shell, ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const CODEX = codexPath()
const claudeExecutable = resolveClaudeExecutable()
const CLAUDE = Boolean(claudeExecutable) || cliExists('claude')
const SERVER = join(process.cwd(), 'out', 'main', 'toolShim.js')
const ENABLED = process.env.WOOI_E2E_CHOICE === '1'

/**
 * 사용자가 **다른 제품을 지목한** 표현들. 전부 위임 도구로 가야 맞다.
 *
 * `other` 는 메인이 **아닌** 제품이다 — 메인이 무엇이냐에 따라 지목 대상이 바뀌므로 문장을
 * 고정하지 않는다. 그러지 않으면 Claude 메인에게 "Claude 서브에이전트를 만들어 줘" 라고 묻는
 * 셈이 되는데, 그건 네이티브를 써도 맞는 요청이라 재는 것이 달라진다.
 *
 * 한국어와 영어를 섞는다 — 실제 실패가 한국어("claude subagent를 생성해서")에서 났고, 어휘
 * 매칭이 언어를 건너 작동하는지가 이 기능의 관건이다.
 */
function named(other: string): { prompt: string; want: number }[] {
  return [
    {
      prompt: `${other} subagent를 하나 생성해서 README.md 첫 줄만 읽고 알려달라고 해줘.`,
      want: 1
    },
    { prompt: `${other} 한테 이 저장소의 package.json name 필드가 뭔지 물어봐 줘.`, want: 1 },
    { prompt: `Have a ${other} subagent tell me the name field in package.json.`, want: 1 },
    {
      prompt: 'codex, claude 서브에이전트를 각각 하나씩 만들어서 README.md 첫 줄을 읽어 와 줘.',
      want: 2
    },
    { prompt: 'Claude 랑 Codex 둘 다한테 package.json 의 name 을 물어보고 답을 비교해줘.', want: 2 }
  ]
}

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
async function codexAttempt(prompt: string): Promise<Attempt> {
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

/**
 * 표현 하나를 실제 Claude 세션에 넣고 위임 도구 호출 수를 센다.
 *
 * agent-host 를 띄우지 않고 여기서 직접 query 를 연다 — 재려는 것은 모델이 도구를 고르는가이고,
 * 그 판단에 필요한 것은 제품 경로와 **같은 MCP 서버**(createWooiMcpServer)뿐이다. 호스트를
 * 거치면 측정 대상이 아니라 배관을 함께 재게 된다.
 */
async function claudeAttempt(prompt: string): Promise<Attempt> {
  let delegated = 0
  const server = createWooiMcpServer(
    async (tool) => {
      // 실제로 돌리지 않고 성공을 돌려준다 — 실패한 도구는 모델이 재시도해서 횟수가 의미를 잃는다.
      if (tool.endsWith('_subagent')) delegated += 1
      return { text: 'Probe run — the subagent did not really run.' }
    },
    [...AGENT_BACKEND_IDS]
  )

  const q = query({
    prompt: oneShot(prompt),
    options: {
      cwd: process.cwd(),
      // 제품 세션과 같은 조건으로 맞춘다. 시스템 프롬프트가 다르면 다른 것을 재게 된다.
      systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
      settingSources: MCP_SETTING_SOURCES,
      mcpServers: { [WOOI_MCP_SERVER_NAME]: server },
      maxTurns: 8,
      // 승인 프롬프트가 없는 환경이라 물어보면 그대로 멈춘다. 재려는 것은 권한이 아니다.
      canUseTool: async (_tool, input) => ({ behavior: 'allow' as const, updatedInput: input }),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {})
    }
  })

  try {
    for await (const msg of q) if (msg.type === 'result') break
  } finally {
    q.close()
  }
  return { prompt, delegated }
}

async function* oneShot(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
}

/** 결과를 사람이 읽는 표로 찍고 적중 수를 돌려준다. */
function report(label: string, results: (Attempt & { want: number })[]): number {
  for (const r of results) {
    const mark = r.delegated > 0 ? 'HIT ' : 'MISS'
    console.log(`${label} ${mark}  got=${r.delegated} want=${r.want}  ${r.prompt}`)
  }
  const hits = results.filter((r) => r.delegated > 0).length
  console.log(`\n${label} named: ${hits}/${results.length}`)
  return hits
}

describe.skipIf(!ENABLED || !CODEX || !existsSync(SERVER))('Codex 메인', () => {
  it(
    '제품을 지목한 요청은 위임으로 간다',
    async () => {
      const cases = named('Claude')
      const results = []
      for (const c of cases) results.push({ ...(await codexAttempt(c.prompt)), want: c.want })

      // 전부를 요구하지 않는다 — 모델 선택이라 결정적이지 않고, 그걸 100% 로 못 박으면 테스트가
      // 사실이 아니라 소원이 된다. 과반이면 문구가 이기고 있다고 본다.
      expect(report('codex ', results) * 2).toBeGreaterThan(results.length)
    },
    named('Claude').length * 120_000
  )

  it(
    '제품을 지목하지 않은 요청은 네이티브로 가도 된다',
    async () => {
      // 실패로 판정하지 않는다. 위임을 너무 세게 밀어붙여 **아무 서브에이전트나 이 도구로**
      // 흘러가는 과교정을 눈으로 보기 위한 관찰용이다.
      for (const prompt of UNNAMED) {
        const r = await codexAttempt(prompt)
        console.log(`codex  unnamed  delegated=${r.delegated}  ${r.prompt}`)
      }
      expect(true).toBe(true)
    },
    UNNAMED.length * 120_000
  )
})

describe.skipIf(!ENABLED || !CLAUDE)('Claude 메인', () => {
  it(
    '제품을 지목한 요청은 위임으로 간다',
    async () => {
      const cases = named('Codex')
      const results = []
      for (const c of cases) results.push({ ...(await claudeAttempt(c.prompt)), want: c.want })
      expect(report('claude', results) * 2).toBeGreaterThan(results.length)
    },
    named('Codex').length * 180_000
  )

  it(
    '제품을 지목하지 않은 요청은 네이티브로 가도 된다',
    async () => {
      for (const prompt of UNNAMED) {
        const r = await claudeAttempt(prompt)
        console.log(`claude unnamed  delegated=${r.delegated}  ${r.prompt}`)
      }
      expect(true).toBe(true)
    },
    UNNAMED.length * 180_000
  )
})
