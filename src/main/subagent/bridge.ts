import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeRequest, BridgeResponse } from './protocol'
import type { SubAgentActivity, SubAgentRunDeps, SubAgentResult } from './run'
import { runSubAgent } from './run'
import { log } from '../logger'

/**
 * 위임 브리지 — codex 가 띄운 MCP 서버(우리 프로세스 밖)의 요청을 받아 실제 서브런을 돌린다.
 *
 * Claude 경로(claude/delegate.ts)와 **같은 일을 하되 경계가 다르다**. 거기서는 도구 핸들러가
 * 세션과 같은 프로세스에 있어 워크스페이스 설정·권한·중단에 그냥 닿지만, 여기서는 MCP 서버가
 * codex app-server 의 자식이라 닿을 수 없다. 그래서 그 모든 판단을 이쪽(메인)에 두고, 서버는
 * 소켓으로 요청만 넘긴다.
 *
 * 소켓은 앱 실행당 하나이고, 어느 워크스페이스가 부른 것인지는 요청에 실려 온다.
 */

/** 워크스페이스별로 위임 실행에 필요한 것을 메인에서 해석해 준다. */
export interface BridgeDeps {
  /**
   * 이 워크스페이스의 서브런 설정. 워크스페이스가 없거나 위임이 닫혀 있으면 null 을 돌려
   * 요청을 거절한다 — 소켓은 프로세스 전역이라 **요청마다 다시 확인해야** 한다(모드를 끈 뒤에도
   * 살아 있는 MCP 서버가 호출을 보낼 수 있다).
   */
  resolve: (
    workspaceId: string,
    backend: string
  ) =>
    | (Omit<SubAgentRunDeps, 'prompt' | 'abort' | 'onActivity' | 'backend'> & {
        backend: SubAgentRunDeps['backend']
      })
    | null
  /**
   * 위임 MCP 서버가 붙었다. 위임 가능한 스레드가 실제로 살아났다는 유일한 신호라, "위임이 안
   * 걸린다"를 진단할 때 첫 번째로 봐야 하는 값이다.
   */
  onConnect?: () => void
  /** 사이드바 "실행 중 에이전트" 목록 갱신. */
  onStart: (workspaceId: string, taskId: string, backend: string, description: string) => void
  onActivity: (workspaceId: string, taskId: string, activity: SubAgentActivity) => void
  onEnd: (workspaceId: string, taskId: string) => void
}

export class DelegateBridge {
  private server: Server | null = null
  private readonly path: string
  /** 진행 중인 위임 실행. 워크스페이스가 중단·정리될 때 함께 끊기 위해 들고 있는다. */
  private running = new Map<string, { workspaceId: string; abort: AbortController }>()
  /** 지금 붙어 있는 위임 MCP 서버 수(= 위임 가능한 살아 있는 스레드 수). 진단용. */
  private connections = 0

  constructor(private deps: BridgeDeps) {
    // userData 가 아니라 tmp 에 둔다 — 소켓 파일은 실행 간에 남길 이유가 없고, 경로 길이 제한
    // (unix 소켓은 ~104바이트)에 걸리기 쉬운 긴 앱 지원 경로를 피할 수 있다.
    this.path = join(tmpdir(), `wooi-delegate-${process.pid}.sock`)
  }

  /** 소켓 경로. MCP 서버에 환경변수로 넘긴다. 아직 안 떠 있으면 이 호출이 띄운다. */
  socketPath(): string {
    this.ensure()
    return this.path
  }

  private ensure(): void {
    if (this.server) return
    // 앞선 실행이 비정상 종료해 남긴 소켓 파일이 있으면 bind 가 EADDRINUSE 로 실패한다.
    rmSync(this.path, { force: true })
    const server = createServer((socket) => this.attach(socket))
    server.on('error', (err) => log.error('delegate bridge: socket server error', err))
    server.listen(this.path, () => log.info(`delegate bridge: listening on ${this.path}`))
    this.server = server
  }

  private attach(socket: Socket): void {
    this.connections += 1
    this.deps.onConnect?.()
    socket.on('close', () => {
      this.connections -= 1
    })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let request: BridgeRequest
        try {
          request = JSON.parse(line) as BridgeRequest
        } catch {
          // 프로토콜이 아닌 줄은 버린다. 우리가 띄운 서버만 붙으므로 정상 상황에선 오지 않는다.
          continue
        }
        void this.handle(socket, request)
      }
    })
    socket.on('error', () => {
      /* 서버 프로세스가 먼저 죽으면 EPIPE 가 난다 — 진행 중 실행은 abort 로 정리된다. */
    })
  }

  private async handle(socket: Socket, request: BridgeRequest): Promise<void> {
    if (request.type !== 'delegate') return
    const reply = (response: Omit<BridgeResponse, 'type' | 'id'>): void => {
      const payload: BridgeResponse = { type: 'result', id: request.id, ...response }
      socket.write(`${JSON.stringify(payload)}\n`)
    }

    const resolved = this.deps.resolve(request.workspaceId, request.backend)
    if (!resolved) {
      reply({ error: 'This workspace can no longer delegate work to another agent.' })
      return
    }

    const taskId = randomUUID()
    const abort = new AbortController()
    this.running.set(taskId, { workspaceId: request.workspaceId, abort })
    this.deps.onStart(request.workspaceId, taskId, request.backend, request.description)

    let result: SubAgentResult
    try {
      result = await runSubAgent({
        ...resolved,
        prompt: request.prompt,
        abort,
        onActivity: (activity) => this.deps.onActivity(request.workspaceId, taskId, activity)
      })
    } catch (err) {
      log.error('delegate bridge: sub-agent run threw', err)
      result = {
        text: '',
        sessionId: null,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      this.running.delete(taskId)
      this.deps.onEnd(request.workspaceId, taskId)
    }

    if (result.error && !result.text) reply({ error: result.error })
    else reply({ text: result.text })
  }

  /** 붙어 있는 위임 서버 수. 위임이 안 걸릴 때 "스레드에 도구가 붙긴 했나"를 가른다. */
  attachedServers(): number {
    return this.connections
  }

  /** 이 워크스페이스의 위임 실행을 전부 끊는다(중단·정리 경로에서 호출). */
  abortWorkspace(workspaceId: string): void {
    for (const [taskId, entry] of this.running) {
      if (entry.workspaceId !== workspaceId) continue
      entry.abort.abort()
      this.running.delete(taskId)
      this.deps.onEnd(workspaceId, taskId)
    }
  }

  /** 앱 종료 경로. 남은 실행을 끊고 소켓을 닫는다. */
  dispose(): void {
    for (const entry of this.running.values()) entry.abort.abort()
    this.running.clear()
    this.server?.close()
    this.server = null
    rmSync(this.path, { force: true })
  }
}
