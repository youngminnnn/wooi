import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { agentToolsFor, WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import { AppServer } from './appServer'
import { RPC } from './wire'
import { turnPolicyFor } from './modes'

/**
 * 실제 `codex app-server` 를 상대로 핸드셰이크와 기본 계약을 확인한다.
 *
 * 유닛 테스트(jsonrpc·mapping)는 프로토콜을 **우리가 이해한 대로** 고정할 뿐이라, 그 이해가
 * 틀렸으면 전부 통과하면서도 실물과 어긋난다. 이 테스트만이 그 간극을 잡는다.
 *
 * codex 가 없으면 건너뛴다 — 네트워크·자격증명 없이 도는 범위만 다루므로 CI 에서도 안전하다
 * (initialize·thread/start 는 모델을 부르지 않는다).
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
/** 빌드 산출물. 없으면(빌드 전) 등록 자체가 생략되므로 함께 건너뛴다. */
const SHIM = resolve('out/main/toolShim.js')

let server: AppServer | null = null
afterEach(() => {
  server?.dispose()
  server = null
})

describe.skipIf(!CODEX)('codex app-server (실물)', () => {
  function start(): AppServer {
    server = new AppServer({
      executable: CODEX!,
      onNotification: () => {},
      requestHandlers: {},
      onExit: () => {}
    })
    return server
  }

  it('initialize 핸드셰이크가 성립한다', async () => {
    const rpc = await start().rpc()
    expect(rpc).toBeDefined()
  }, 30_000)

  // 우리가 쓰는 메서드가 이 버전에 실제로 있는지 확인한다. 없으면 -32601 로 degrade 되므로,
  // "조용히 기능이 사라지는" 상황을 여기서 미리 잡는다.
  it('model/list 를 지원한다', async () => {
    const rpc = await start().rpc()
    const result = await rpc.tryRequest<{ data?: unknown[] }>(RPC.modelList, {})
    expect(result).toBeDefined()
    expect(Array.isArray(result?.data)).toBe(true)
  }, 30_000)

  it('account/read 를 지원한다(로그인 여부와 무관하게 응답한다)', async () => {
    const rpc = await start().rpc()
    const result = await rpc.tryRequest(RPC.accountRead, { refreshToken: false })
    expect(result).toBeDefined()
  }, 30_000)

  /**
   * 아래는 "우리가 보내는 파라미터를 서버가 실제로 받아들이는가" 를 본다.
   *
   * 스키마 대조만으로는 부족하다 — serde 가 **모르는 필드를 조용히 무시**하기 때문에, 이름을
   * 틀려도 요청은 성공하고 정책만 사라진다(실제로 thread/start 의 sandboxPolicy 가 그랬다).
   * 그래서 모델을 부르지 않는 범위에서 왕복을 걸어 둔다.
   */
  describe('우리가 보내는 파라미터', () => {
    it('thread/start 가 모든 권한 모드의 파라미터를 받아들인다', async () => {
      const rpc = await start().rpc()
      for (const mode of ['askForApproval', 'default', 'fullAccess'] as const) {
        const policy = turnPolicyFor(mode, process.cwd())
        const result = await rpc.request<{ thread?: { id?: string } }>(RPC.threadStart, {
          cwd: process.cwd(),
          sandbox: policy.sandboxMode,
          approvalPolicy: policy.approvalPolicy
        })
        expect(result?.thread?.id, `mode=${mode}`).toBeTruthy()
      }
    }, 60_000)

    // 입력 모양이 틀리면 첫 메시지부터 실패한다. 모델 호출 전에 파라미터 검증만 통과하는지 본다
    // (로그인하지 않았다면 턴은 인증 오류로 끝나지만, 그건 파라미터가 통과했다는 뜻이다).
    it('turn/start 가 우리 입력 모양을 받아들인다', async () => {
      const rpc = await start().rpc()
      const thread = await rpc.request<{ thread?: { id?: string } }>(RPC.threadStart, {
        cwd: process.cwd(),
        sandbox: 'read-only'
      })
      const policy = turnPolicyFor('askForApproval', process.cwd())
      const turn = await rpc.request<{ turn?: { id?: string } }>(RPC.turnStart, {
        threadId: thread?.thread?.id,
        input: [{ type: 'text', text: 'ping' }],
        sandboxPolicy: policy.sandboxPolicy,
        approvalPolicy: policy.approvalPolicy
      })
      // 파라미터가 거부되면 여기서 RpcError 로 터진다. 턴 자체의 성패는 보지 않는다.
      expect(turn?.turn?.id).toBeTruthy()
    }, 60_000)
  })

  /**
   * 설정 화면의 "From ~/.codex/config.toml" 목록이 기대는 계약을 못 박는다.
   *
   * 그 목록은 mcpServerStatus/list 가 아니라 config/read 를 본다. 이유가 딱 하나 있다 —
   * **꺼 둔 서버가 응답에 남아야** 설정 화면에서 다시 켤 수 있기 때문이다. 상태 목록 쪽은
   * 안 뜬 서버를 "초기화 실패" 로 내거나 아예 빼므로 토글의 근거가 되지 못한다.
   *
   * 여기가 깨지면 증상은 "껐더니 목록에서 사라져 다시 못 켠다" 로 나타난다.
   */
  describe('설정용 MCP 목록', () => {
    it('config/read 가 mcp_servers 를 enabled 필드와 함께 돌려준다', async () => {
      const rpc = await start().rpc()
      const result = await rpc.request<{
        config?: { mcp_servers?: Record<string, Record<string, unknown>> }
      }>(RPC.configRead, { includeLayers: false })
      const table = result?.config?.mcp_servers
      expect(table, 'config/read did not return mcp_servers').toBeTypeOf('object')
      // 항목 하나하나는 사용자 설정이라 개수·이름을 못 박지 않는다. 우리가 읽는 필드가
      // 있는 모양인지만 본다(빈 설정이면 검사할 것이 없으므로 통과).
      for (const server of Object.values(table ?? {})) {
        expect(server).toBeTypeOf('object')
        if ('enabled' in server) expect(typeof server.enabled).toBe('boolean')
      }
    }, 60_000)

    // 빌드 산출물이 없으면 `-c` 등록 자체가 생략되므로 함께 건너뛴다.
    it.skipIf(!existsSync(SHIM))(
      '`-c` 로 얹은 서버도 같은 테이블에 섞여 온다(설정 화면이 걸러내야 하는 이유)',
      async () => {
        process.env.WOOI_TOOL_SOCKET = join(tmpdir(), 'wooi-e2e-unused.sock')
        process.env.WOOI_TOOL_SHIM = SHIM
        try {
          const rpc = await start().rpc()
          const result = await rpc.request<{
            config?: { mcp_servers?: Record<string, unknown> }
          }>(RPC.configRead, { includeLayers: false })
          expect(Object.keys(result?.config?.mcp_servers ?? {})).toContain(WOOI_MCP_SERVER_NAME)
        } finally {
          delete process.env.WOOI_TOOL_SOCKET
          delete process.env.WOOI_TOOL_SHIM
        }
      },
      60_000
    )
  })

  /**
   * Wooi 도구가 실제로 이 연결에 등록되는지 본다.
   *
   * `-c` 오버라이드는 codex 의 CLI 표면이라 우리가 통제할 수 없다 — 형식이 바뀌거나 무시되기
   * 시작하면 도구가 조용히 사라지고, 모델은 워크스페이스를 만들라는 지시를 받고도 맨손 git 으로
   * 흉내 낸 뒤 성공했다고 보고한다(실제로 겪은 실패 모양이다). 그래서 여기서 못 박는다.
   *
   * 산출물이 없으면(빌드 전) 등록 자체를 생략하므로 함께 건너뛴다.
   */
  describe.skipIf(!existsSync(SHIM))('Wooi 도구 등록', () => {
    it('mcp_servers.wooi 가 붙고 카탈로그가 그대로 발견된다', async () => {
      // 등록만 확인한다 — 도구를 실제로 부르지는 않으므로 소켓은 안 열려 있어도 된다.
      process.env.WOOI_TOOL_SOCKET = join(tmpdir(), 'wooi-e2e-unused.sock')
      process.env.WOOI_TOOL_SHIM = SHIM
      try {
        const rpc = await start().rpc()
        const list = await rpc.request<{
          data?: Array<{ name: string; tools?: Record<string, unknown> }>
        }>(RPC.mcpStatusList, { limit: 100 })

        const wooi = list?.data?.find((s) => s.name === WOOI_MCP_SERVER_NAME)
        expect(wooi, 'wooi server not registered').toBeDefined()
        // 목록을 여기 베껴 두지 않는다 — 이 테스트가 확인하는 것은 "카탈로그가 그대로 발견되는가"
        // 이지 카탈로그의 내용이 아니다. 베껴 두면 도구를 하나 더할 때마다 무관한 전송 테스트가 깨진다.
        // 위임 백엔드 없이 띄운 shim 이라 기준은 agentToolsFor() 다.
        expect(Object.keys(wooi?.tools ?? {}).sort()).toEqual(
          agentToolsFor()
            .map((t) => t.name)
            .sort()
        )
      } finally {
        delete process.env.WOOI_TOOL_SOCKET
        delete process.env.WOOI_TOOL_SHIM
      }
    }, 60_000)
  })
})
