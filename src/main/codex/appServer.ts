import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from '../logger'
import { RpcClient, type ServerRequestHandler } from './jsonrpc'
import { RPC, type InitializeResult } from './wire'

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

/** 종료 요청 후 이 시간까지 안 죽으면 SIGKILL 한다(고아 프로세스 방지). */
const KILL_GRACE_MS = 2_000

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
    const child = spawn(this.opts.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 사용자 셸에서 하이드레이트된 PATH·자격증명 환경을 그대로 물려준다.
      env: process.env
    })
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
      clientInfo: CLIENT_INFO
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
