import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { AppServer } from './appServer'
import { RPC } from './wire'

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
})
