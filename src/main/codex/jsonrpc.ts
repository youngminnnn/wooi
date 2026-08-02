/**
 * `codex app-server` 용 줄 단위 JSON-RPC 2.0 클라이언트.
 *
 * 특징(일반적인 JSON-RPC 와 다른 점):
 * - 프레이밍은 **개행 구분 JSON(JSONL)**. Content-Length 헤더가 없다.
 * - 와이어에 `"jsonrpc":"2.0"` 필드를 **싣지 않는다**(app-server 규약).
 * - **양방향**이다. 서버도 우리에게 요청을 보내며(승인 프롬프트 등), 응답하기 전까지 턴이 멈춘다.
 *
 * 프로세스 spawn 과 분리해 두었다 — 프레이밍·상관·에러 처리는 전부 여기 있고, 테스트는 가짜
 * 스트림만 물려서 돌린다(jsonrpc.test.ts).
 */

import { log } from '../logger'

/** 이 클라이언트가 물릴 최소한의 스트림 인터페이스(child_process 의 stdio 를 그대로 만족한다). */
export interface RpcStreams {
  /** 서버 → 우리. 'data' 로 Buffer/문자열 청크를 흘려보낸다. */
  readable: { on(event: 'data', cb: (chunk: Buffer | string) => void): void }
  /** 우리 → 서버. */
  writable: { write(chunk: string): void }
}

/** 서버가 보낸 요청을 처리하는 핸들러. 반환값이 그대로 result 로 응답된다. */
export type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown

export interface RpcOptions {
  /** 알림(응답 불필요) 수신 콜백. */
  onNotification: (method: string, params: unknown) => void
  /** 서버 요청 핸들러 등록표. 없는 메서드는 -32601 로 거절한다(요청이 영영 매달리지 않도록). */
  requestHandlers?: Record<string, ServerRequestHandler>
  /** 요청 기본 타임아웃(ms). */
  timeoutMs?: number
}

/** JSON-RPC 표준 코드 + app-server 확장. */
const METHOD_NOT_FOUND = -32601
const SERVER_OVERLOADED = -32001

const DEFAULT_TIMEOUT_MS = 30_000
/** 과부하(-32001) 재시도 횟수와 기본 대기(지수 백오프). */
const OVERLOAD_RETRIES = 3
const OVERLOAD_BASE_DELAY_MS = 250

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class RpcClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** 부분 수신된 줄. 청크 경계가 JSON 중간을 자를 수 있으므로 버퍼링한다. */
  private buffer = ''
  /** -32601 을 한 번 받은 메서드. 다시 호출하지 않고 즉시 미지원 처리한다. */
  private unsupported = new Set<string>()
  private closed = false

  constructor(
    private streams: RpcStreams,
    private opts: RpcOptions
  ) {
    streams.readable.on('data', (chunk) => this.onData(chunk))
  }

  // ── 수신 ────────────────────────────────────────────────────────────

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

    // 개행마다 한 메시지. 마지막 조각은 아직 미완성일 수 있으므로 버퍼에 남긴다.
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 스트림에 섞여 들어온 비-JSON(로그 등)은 무시한다. 여기서 throw 하면 연결이 통째로 죽는다.
      log.warn(`codex rpc: dropping non-JSON line (${line.slice(0, 120)})`)
      return
    }

    const id = msg.id
    const method = msg.method

    // 서버 → 클라이언트 **요청**: id 와 method 가 함께 있다.
    if (typeof method === 'string' && id !== undefined && id !== null) {
      void this.handleServerRequest(id as number | string, method, msg.params)
      return
    }

    // 알림: method 만 있다.
    if (typeof method === 'string') {
      try {
        this.opts.onNotification(method, msg.params)
      } catch (err) {
        // 한 알림의 처리 실패가 스트림 전체를 끊지 않도록 격리한다.
        log.error(`codex rpc: notification handler threw for ${method}`, err)
      }
      return
    }

    // 응답: id 만 있다.
    if (typeof id === 'number') {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      const error = msg.error as { code?: number; message?: string } | undefined
      if (error) {
        const err = new RpcError(error.message ?? 'Codex request failed', error.code)
        entry.reject(err)
      } else {
        entry.resolve(msg.result)
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    const handler = this.opts.requestHandlers?.[method]
    if (!handler) {
      // 처리기가 없으면 반드시 에러로 답해야 한다 — 무응답은 서버 쪽 턴을 영영 멈춰 세운다.
      log.warn(`codex rpc: no handler for server request ${method}; replying method-not-found`)
      this.send({ id, error: { code: METHOD_NOT_FOUND, message: `Unhandled method: ${method}` } })
      return
    }
    try {
      const result = await handler(params)
      this.send({ id, result: result ?? {} })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`codex rpc: server request ${method} handler failed`, err)
      this.send({ id, error: { code: -32603, message } })
    }
  }

  // ── 송신 ────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (this.closed) return
    // app-server 는 와이어에서 `jsonrpc` 필드를 생략한다.
    this.streams.writable.write(`${JSON.stringify(msg)}\n`)
  }

  /** 응답이 필요 없는 알림을 보낸다. */
  notify(method: string, params?: unknown): void {
    this.send({ method, params: params ?? {} })
  }

  /** 요청을 보내고 응답을 기다린다. 과부하(-32001)는 백오프 후 자동 재시도한다. */
  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.once(method, params, timeoutMs)) as T
      } catch (err) {
        const retriable = err instanceof RpcError && err.code === SERVER_OVERLOADED
        if (!retriable || attempt >= OVERLOAD_RETRIES) throw err
        // 지터를 섞지 않는 단순 지수 백오프 — 로컬 단일 연결이라 thundering herd 가 없다.
        await delay(OVERLOAD_BASE_DELAY_MS * 2 ** attempt)
      }
    }
  }

  private once(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error(`Codex request timed out: ${method}`))
        },
        timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params: params ?? {} })
    })
  }

  /**
   * 있으면 좋고 없으면 마는 메서드를 호출한다.
   *
   * codex 버전마다 지원하는 메서드가 다르므로, 미지원(-32601)은 **정상 상황**으로 취급해
   * undefined 를 돌려주고 그 메서드를 기억해 다음부터는 왕복조차 하지 않는다.
   */
  async tryRequest<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T | undefined> {
    if (this.unsupported.has(method)) return undefined
    try {
      return await this.request<T>(method, params, timeoutMs)
    } catch (err) {
      if (err instanceof RpcError && err.code === METHOD_NOT_FOUND) {
        this.unsupported.add(method)
        log.warn(`codex rpc: ${method} unsupported by this codex version; degrading`)
        return undefined
      }
      throw err
    }
  }

  /** 이 메서드가 미지원으로 판명됐는가(호출을 아예 건너뛸지 판단할 때). */
  supports(method: string): boolean {
    return !this.unsupported.has(method)
  }

  /** 연결 종료 — 대기 중인 요청은 전부 거절한다(영영 매달리지 않도록). */
  close(reason = 'Codex connection closed'): void {
    if (this.closed) return
    this.closed = true
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(reason))
    }
    this.pending.clear()
  }
}

/** 서버가 돌려준 JSON-RPC 에러. code 로 재시도·degrade 판단을 한다. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
