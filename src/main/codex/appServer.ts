import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import { log } from '../logger'
import { CODEX_MCP_SERVERS_ENV, type CodexStdioServer } from '@shared/types'
import { RpcClient, type ServerRequestHandler } from './jsonrpc'
import { RPC, type InitializeResult } from './wire'
import { withWooiCodexConfig } from './config'

/**
 * `codex app-server` 자식 프로세스 1개 + 그 위의 JSON-RPC 연결.
 *
 * 프로세스는 **하나만** 띄우고 모든 워크스페이스가 스레드로 다중화한다 — codex 인스턴스마다
 * 프로세스를 띄우면 메모리도 낭비고, 계정 상태(account/updated)도 여러 출처로 갈라진다.
 *
 * 수명주기 책임만 진다. 프레이밍은 jsonrpc.ts, 이벤트 해석은 mapping.ts 가 맡는다.
 */

/** 우리가 codex 에 밝히는 신원. app-server 문서가 클라이언트 식별을 요구한다. */
const CLIENT_INFO = {
  name: 'wooi',
  title: 'Wooi',
  version: process.env.npm_package_version ?? '1.1.0'
}

/**
 * Wooi가 실제로 처리하는 app-server 확장 기능. 특히 request_plugin_install은 Codex Apps
 * MCP의 openai/form elicitation을 사용하므로 이 선언이 없으면 설치 확인 단계에 도달하지 못한다.
 */
export const CLIENT_CAPABILITIES = {
  experimentalApi: true,
  mcpServerOpenaiFormElicitation: true
} as const

/** 종료 요청 후 이 시간까지 안 죽으면 SIGKILL 한다(고아 프로세스 방지). */
const KILL_GRACE_MS = 2_000

/**
 * Wooi 도구를 이 app-server 연결에만 등록하는 설정 오버라이드.
 *
 * `-c` 는 **프로세스 인자**라 사용자의 `~/.codex/config.toml` 을 건드리지 않는다. 같은 목적으로
 * `config/value/write` 를 쓰면 그 파일에 영구히 기록되고(그게 Wooi 의 MCP 토글 경로다),
 * `thread/start` 의 config 오버레이로는 서버가 등록되지 않는다 — 둘 다 실측으로 확인했다.
 * 사용자가 터미널에서 직접 쓰는 codex 에는 영향이 없다.
 *
 * 셸을 거치지 않고 spawn 인자로 그대로 넘어가므로 값에 따옴표만 맞추면 된다(TOML 로 파싱된다).
 */
/**
 * Wooi 도구 shim 의 실행 설정. `-c` 인자와 **스레드 config 양쪽이 같은 값**을 써야 한다.
 *
 * 스레드 config 를 쓰는 경로(멀티 에이전트 위임)가 생기면서 이게 필요해졌다 — `thread/start` 의
 * `config.mcp_servers` 는 `-c` 로 등록한 서버를 **덮는다**(실측: 위임 서버만 ready 로 뜨고 wooi 는
 * 목록에서 사라졌다). 그래서 스레드 config 를 싣는 쪽이 이 서버를 함께 다시 선언한다.
 */
export function wooiToolServer(): {
  command: string
  args: string[]
  env: Record<string, string>
} | null {
  const socket = process.env.WOOI_TOOL_SOCKET
  const shim = process.env.WOOI_TOOL_SHIM
  if (!socket || !shim) return null
  if (!existsSync(shim)) {
    log.warn(`codex: Wooi tools not registered — shim missing at ${shim}`)
    return null
  }
  return {
    command: process.execPath,
    args: [shim],
    // Electron 바이너리를 순수 Node 로 쓰기 위한 스위치. 없으면 앱이 통째로 한 번 더 뜬다.
    env: { ELECTRON_RUN_AS_NODE: '1', WOOI_TOOL_SOCKET: socket }
  }
}

function wooiToolArgs(): string[] {
  // 경로는 둘 다 메인이 정해 env 로 내려 준다([[index]]). 여기서 import.meta.dirname 으로
  // 추측하지 않는 이유는 그 값이 실행 맥락마다 다르기 때문이다 — 번들에서는 out/main 이지만
  // 소스로 직접 도는 테스트에서는 src/main/codex 라, 조용히 등록이 빠진 채 통과한다.
  // 붙을 곳 없는 서버를 띄우면 codex 가 매 기동마다 실패한 MCP 서버를 하나 안고 간다.
  const server = wooiToolServer()
  if (!server) return []
  return [
    '-c',
    `mcp_servers.${WOOI_MCP_SERVER_NAME}.command=${toml(server.command)}`,
    '-c',
    `mcp_servers.${WOOI_MCP_SERVER_NAME}.args=[${toml(server.args[0])}]`,
    ...Object.entries(server.env).flatMap(([key, value]) => [
      '-c',
      `mcp_servers.${WOOI_MCP_SERVER_NAME}.env.${key}=${toml(value)}`
    ])
  ]
}

/** TOML 문자열 리터럴로 감싼다(경로에 공백·따옴표가 있어도 안전하게). */
function toml(value: string): string {
  return JSON.stringify(value)
}

/**
 * Wooi 스코프 MCP 서버 테이블. **메인이 계산해 env 로 내려 준 것**을 그대로 읽는다.
 *
 * 이 파일은 codex-host(유틸리티 프로세스)에서 돈다. 거기서는 `import { app } from 'electron'`
 * 이 로드 시점에 throw 하므로(logger.ts 의 같은 주석) 설정 store 로 이어지는 import 를 하나라도
 * 들이면 호스트가 로그 한 줄 없이 죽는다 — 겉으로는 "Codex host crashed" 로만 보인다.
 * 그래서 shim 경로(WOOI_TOOL_SHIM)와 같은 방식으로 값만 받는다.
 *
 * 이름이 Wooi 내장 도구 서버와 겹치면 건너뛴다. 그 이름을 뺏기면 앱 조작 통로가 통째로
 * 남의 서버로 바뀐다(Claude 쪽 session.ts 와 같은 판단).
 */
export function wooiMcpServerTable(): Record<string, CodexStdioServer> {
  const raw = process.env[CODEX_MCP_SERVERS_ENV]
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, CodexStdioServer>
    delete parsed[WOOI_MCP_SERVER_NAME]
    return parsed
  } catch (err) {
    log.warn(`codex: could not read ${CODEX_MCP_SERVERS_ENV} — no Wooi MCP servers injected`, err)
    return {}
  }
}

/** 같은 테이블을 app-server spawn 용 `-c` 인자로 편다(사용자의 config.toml 은 건드리지 않는다). */
function wooiMcpConfigArgs(): string[] {
  return Object.entries(wooiMcpServerTable()).flatMap(([name, server]) => [
    '-c',
    `mcp_servers.${name}.command=${toml(server.command)}`,
    '-c',
    `mcp_servers.${name}.args=[${server.args.map(toml).join(', ')}]`,
    ...Object.entries(server.env).flatMap(([key, value]) => [
      '-c',
      `mcp_servers.${name}.env.${key}=${toml(value)}`
    ])
  ])
}

export interface AppServerOptions {
  /** codex 실행 파일 절대 경로. */
  executable: string
  /** 알림 수신(스레드별 라우팅은 상위에서 threadId 로 한다). */
  onNotification: (method: string, params: unknown) => void
  /** 서버가 보내는 요청(승인 등) 처리기. */
  requestHandlers: Record<string, ServerRequestHandler>
  /** 프로세스가 죽었을 때. 상위가 진행 중 워크스페이스를 정리하고 재기동을 준비한다. */
  onExit: (code: number | null) => void
}

export class AppServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private client: RpcClient | null = null
  private ready: Promise<void> | null = null
  private disposed = false

  constructor(private opts: AppServerOptions) {}

  /** 연결이 준비될 때까지 기다린 뒤 RPC 클라이언트를 돌려준다. 필요하면 프로세스를 띄운다. */
  async rpc(): Promise<RpcClient> {
    if (this.disposed) throw new Error('Codex app-server is disposed')
    if (!this.ready) this.ready = this.start()
    await this.ready
    if (!this.client) throw new Error('Codex app-server is not connected')
    return this.client
  }

  private async start(): Promise<void> {
    // Wooi 스코프 서버는 프로세스가 뜰 때 한 번 고정된다 — 설정을 바꾸면 앱을 다시 켜야
    // 반영된다(app-server 는 모든 워크스페이스가 공유하는 단일 프로세스라 재기동이 곧 전면 중단).
    const child = spawn(
      this.opts.executable,
      withWooiCodexConfig(['app-server', ...wooiToolArgs(), ...wooiMcpConfigArgs()]),
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // 사용자 셸에서 하이드레이트된 PATH·자격증명 환경을 그대로 물려준다.
        env: process.env
      }
    )
    this.child = child

    // stderr 는 프로토콜이 아니라 진단용 로그다. 조용히 버리면 기동 실패 원인을 못 찾는다.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.warn(`codex app-server: ${text}`)
    })

    child.on('exit', (code) => {
      log.error(`codex app-server exited (code ${code})`)
      this.client?.close('Codex app-server exited')
      this.client = null
      this.child = null
      this.ready = null
      if (!this.disposed) this.opts.onExit(code)
    })

    child.on('error', (err) => {
      log.error('codex app-server failed to spawn', err)
    })

    const client = new RpcClient(
      { readable: child.stdout, writable: child.stdin },
      {
        onNotification: this.opts.onNotification,
        requestHandlers: this.opts.requestHandlers
      }
    )
    this.client = client

    // 핸드셰이크: initialize 요청 → initialized 알림. 이 순서를 지키기 전의 다른 요청은 거절된다.
    const result = await client.request<InitializeResult>(RPC.initialize, {
      clientInfo: CLIENT_INFO,
      // Plan 모드(collaborationMode)가 실험 API 표면에만 있어 opt-in 한다. 안정 필드는 그대로
      // 동작하고, 실험 필드는 서버가 모르면 조용히 무시되므로 최악의 경우 Plan 모드만 degrade 된다.
      capabilities: CLIENT_CAPABILITIES
    })
    client.notify(RPC.initialized)
    log.info(
      `codex app-server ready (home=${result?.codexHome ?? '?'} os=${result?.platformOs ?? '?'})`
    )
  }

  /** 프로세스를 정리한다. 앱 종료 시 고아 codex 프로세스를 남기지 않는 것이 목적이다. */
  dispose(): void {
    this.disposed = true
    this.client?.close('Codex app-server disposed')
    this.client = null
    this.ready = null

    const child = this.child
    this.child = null
    if (!child || child.killed) return

    child.kill('SIGTERM')
    // SIGTERM 을 무시하는 경우를 대비한 확인 사살. unref 로 이 타이머가 종료를 붙잡지 않게 한다.
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref()
  }
}
