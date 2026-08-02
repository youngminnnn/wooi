import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
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
      for (const mode of ['readOnly', 'default', 'fullAccess', 'plan'] as const) {
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
      const policy = turnPolicyFor('readOnly', process.cwd())
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
})
