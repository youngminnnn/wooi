import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppServer } from './appServer'
import { RPC } from './wire'
import { DelegateBridge } from '../subagent/bridge'
import { BRIDGE_ENV } from '../subagent/protocol'

/**
 * `thread/start` 의 config 로 위임 MCP 서버를 **스레드 단위로** 붙일 수 있는지 실물 확인.
 *
 * 이것이 Codex 를 메인 에이전트로 쓸 수 있게 하는 유일한 경로다. 스키마 대조로는 부족하다 —
 * `ThreadStartParams.config` 는 `additionalProperties: true` 인 자유 객체라, 이름을 틀려도 요청은
 * 성공하고 도구만 조용히 사라진다. 그래서 codex 가 **서버를 실제로 띄우고 tools/list 까지 읽었는지**를
 * mcpServerStatus/list 로 확인한다.
 *
 * 프로세스 인자(`-c`)를 쓰지 않는 이유도 여기서 고정된다: app-server 는 모든 Codex 워크스페이스가
 * 공유하므로, 프로세스 단위로 넣으면 단일 에이전트 워크스페이스에까지 위임 도구가 붙는다.
 *
 * 모델을 부르지 않으므로 자격증명 없이도 돈다.
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
const SERVER = join(process.cwd(), 'out', 'main', 'delegateServer.js')

let app: AppServer | null = null
let bridge: DelegateBridge | null = null
afterEach(() => {
  app?.dispose()
  app = null
  bridge?.dispose()
  bridge = null
})

describe.skipIf(!CODEX || !existsSync(SERVER))('codex 스레드에 위임 도구 붙이기 (실물)', () => {
  it('thread/start 의 config 로 넣으면 codex 가 도구를 읽어 간다', async () => {
    bridge = new DelegateBridge({
      resolve: () => null,
      onStart: () => {},
      onActivity: () => {},
      onEnd: () => {}
    })
    app = new AppServer({
      executable: CODEX!,
      onNotification: () => {},
      requestHandlers: {},
      onExit: () => {}
    })
    const rpc = await app.rpc()

    expect(bridge.attachedServers()).toBe(0)

    await rpc.request(RPC.threadStart, {
      cwd: process.cwd(),
      sandbox: 'read-only',
      config: {
        mcp_servers: {
          wooi: {
            // 패키징된 앱에서는 Electron 바이너리를 node 모드로 띄우지만(mcpConfig.ts), 테스트는
            // 평범한 node 라 그대로 쓴다 — 확인하려는 것은 codex 가 이 설정을 읽느냐다.
            command: process.execPath,
            args: [SERVER],
            env: {
              [BRIDGE_ENV.socket]: bridge.socketPath(),
              [BRIDGE_ENV.workspaceId]: 'ws-e2e',
              [BRIDGE_ENV.backends]: 'claude,codex'
            }
          }
        }
      }
    })

    // 서버 기동에 잠깐 걸린다. 붙었다는 것은 codex 가 이 스레드 설정을 읽고 우리 서버를 자식
    // 프로세스로 띄웠다는 뜻이다 — mcpServerStatus/list 는 프로세스 전역 설정만 보고하므로
    // (실측) 스레드 단위 서버를 확인하는 데 쓸 수 없다.
    await new Promise((r) => setTimeout(r, 8000))
    expect(bridge.attachedServers(), 'codex did not start the wooi MCP server').toBeGreaterThan(0)
  }, 120_000)
})
