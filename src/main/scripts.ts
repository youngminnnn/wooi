import { spawn, type ChildProcess } from 'node:child_process'
import { IPC } from '@shared/types'
import type { ScriptStatus } from '@shared/types'

type Dispatch = (channel: string, payload: unknown) => void

/**
 * 출력 코얼레싱 주기(ms). 스크립트 stdout/stderr 를 매 청크마다 즉시 renderer 로 보내지 않고
 * 이 간격으로 모아 보낸다 — dev 서버나 빌드가 로그를 폭주시키면 매 청크가 별도 IPC 메시지가
 * 되어, 느린 renderer 뒤로 메인 프로세스 송신 큐가 무한 적재되고 결국 메인 V8 힙 OOM 으로
 * 앱 전체가 죽는다(관측된 크래시). 모아 보내면 메시지 수가 급감해 큐 적체를 억제한다.
 */
const FLUSH_INTERVAL_MS = 16

/** flush 사이에 모아 둘 스트림별 출력 상한(바이트 근사). 초과분은 앞에서 잘라 tail 만 남긴다. */
const PENDING_LIMIT = 512 * 1024

/**
 * 이미 흘려보낸 출력을 다시 읽을 수 있게 보관하는 꼬리 버퍼의 상한.
 * 출력은 이벤트로만 나가므로, 나중에 뜬 창(분리한 스크립트 패널)은 이 버퍼가 없으면
 * 돌고 있는 dev 서버의 로그를 "No output yet." 로 보게 된다.
 *
 * runOnce 가 모으는 출력도 같은 상한을 쓴다 — 둘 다 "무한정 자라면 안 되는 로그 꼬리" 로
 * 성질이 같아서, 상한이 갈라지면 한쪽만 조용히 메모리를 먹는다.
 */
export const HISTORY_LIMIT = 256 * 1024

/** 꼬리 버퍼에 이어 붙인다. 상한을 넘으면 앞을 잘라 최신 부분만 남긴다. */
function appendTail(prev: string, chunk: string): string {
  const next = prev + chunk
  return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next
}

/** 일회성 명령(runOnce)의 실행 결과. */
export interface RunOnceResult {
  /** 종료 코드. 시작 자체가 실패했거나 타임아웃으로 죽인 경우 null. */
  code: number | null
  /** timeoutMs 를 넘겨 강제 종료했는지 — 정상 종료와 구분해야 메시지가 정확해진다. */
  timedOut: boolean
  /** stdout·stderr 를 시간 순으로 합친 출력의 꼬리(HISTORY_LIMIT 상한). */
  output: string
}

interface Running {
  proc: ChildProcess
  exitCode: number | null
  /** 아직 보내지 않고 모아 둔 출력. flush 시 스트림별로 한 번에 보낸다. */
  pendingOut: string
  pendingErr: string
  /** 예약된 flush 타이머(없으면 null). */
  flushTimer: ReturnType<typeof setTimeout> | null
}

/**
 * 프로세스 그룹 전체를 종료한다. detached 로 spawn 한 자식은 자신이 그룹 리더이므로,
 * 음수 pid 로 시그널을 보내면 자식이 띄운 손자(dev 서버의 node/vite 등)까지 함께 정리된다.
 * 그룹 종료가 불가능하면 자식 프로세스 하나만이라도 종료한다.
 */
function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.killed) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // 이미 종료됨.
    }
  }
}

/**
 * workspace 별 setup/dev 스크립트를 실행하고 출력을 renderer 로 스트리밍한다.
 * (workspaceId, kind) 당 프로세스 1개. dev 서버처럼 장수명 프로세스를 띄울 수 있다.
 *
 * 로그인 셸(`$SHELL -lc`)로 실행해 nvm/asdf 등으로 구성된 사용자 PATH 를 그대로 쓴다
 * — 패키징된 앱은 환경이 빈약할 수 있어 명시적으로 로그인 셸을 거친다.
 */
export class ScriptRunner {
  private running = new Map<string, Running>()
  /** (workspaceId, kind) 별 누적 출력의 꼬리. 프로세스가 끝나도 다음 실행 전까지 남겨 둔다. */
  private history = new Map<string, string>()

  /**
   * @param onExit 스크립트 프로세스가 종료될 때(정상/비정상 무관) 불린다. setup 결과를
   *   영속화하는 등 종료 결과를 관찰해야 하는 상위 계층에서 사용한다.
   */
  constructor(
    private dispatch: Dispatch,
    private onExit?: (workspaceId: string, scriptId: string, code: number | null) => void
  ) {}

  private key(workspaceId: string, scriptId: string): string {
    return `${workspaceId}:${scriptId}`
  }

  run(
    workspaceId: string,
    scriptId: string,
    command: string,
    cwd: string,
    env?: Record<string, string>
  ): void {
    if (!command.trim()) return
    this.stop(workspaceId, scriptId)

    const shell = process.env.SHELL || '/bin/zsh'
    // detached 로 새 프로세스 그룹을 만든다 — 중지 시 자식이 띄운 손자까지 그룹 단위로 정리한다.
    // env 로 workspace 별 PORT 등을 주입해 병렬 dev 서버가 같은 포트를 다투지 않게 한다.
    const proc = spawn(shell, ['-lc', command], {
      cwd,
      detached: true,
      ...(env ? { env: { ...process.env, ...env } } : {})
    })
    const key = this.key(workspaceId, scriptId)
    // 새 실행은 새 로그다 — 이전 실행의 꼬리가 앞에 남아 있으면 어디부터가 이번 출력인지 알 수 없다.
    this.history.delete(key)
    this.running.set(key, {
      proc,
      exitCode: null,
      pendingOut: '',
      pendingErr: '',
      flushTimer: null
    })

    // 즉시 보내지 않고 모아 둔다 — 폭주 시 IPC 메시지 홍수로 메인 힙이 OOM 되는 것을 막는다.
    proc.stdout?.on('data', (data: Buffer) => {
      const entry = this.running.get(key)
      if (!entry) return
      entry.pendingOut += data.toString()
      if (entry.pendingOut.length > PENDING_LIMIT)
        entry.pendingOut = entry.pendingOut.slice(-PENDING_LIMIT)
      this.scheduleFlush(workspaceId, scriptId)
    })
    proc.stderr?.on('data', (data: Buffer) => {
      const entry = this.running.get(key)
      if (!entry) return
      entry.pendingErr += data.toString()
      if (entry.pendingErr.length > PENDING_LIMIT)
        entry.pendingErr = entry.pendingErr.slice(-PENDING_LIMIT)
      this.scheduleFlush(workspaceId, scriptId)
    })
    proc.on('error', (err) => {
      const chunk = `\n[wooi] failed to start: ${err.message}\n`
      this.remember(key, chunk)
      this.dispatch(IPC.evtScriptOutput, { workspaceId, scriptId, stream: 'stderr', chunk })
    })
    proc.on('close', (code) => {
      // 그 사이 **다른 프로세스가 이 자리를 차지했으면** 이 종료는 남의 것이 아니다.
      //
      // 재시작(run → stop → spawn)은 옛 프로세스를 죽인 뒤 곧바로 새 프로세스를 같은 키에
      // 등록한다. kill 은 비동기라 옛 프로세스의 close 는 그 뒤에 도착하는데, 그때 키로만
      // 찾으면 **새 실행**을 집는다 — 방금 뜬 dev 서버에 종료 이벤트가 나가고, 꼬리 버퍼
      // 맨 앞에 "exited" 가 박히고, setup 재실행은 onExit 훅이 setupState 를 곧바로
      // 'failed' 로 되돌린다(옛 프로세스는 SIGTERM 이라 code=null 이다).
      //
      // "자리가 비었을 때" 까지 막지는 않는다 — stop() 은 엔트리를 지우고 죽이므로, 그것까지
      // 걸러내면 사용자가 직접 중지했을 때 종료 표시가 통째로 사라진다.
      const entry = this.running.get(key)
      if (entry && entry.proc !== proc) return
      // 종료 직전 남은 출력을 마저 비운 뒤 종료를 알린다(순서 보장).
      this.flush(workspaceId, scriptId)
      if (entry) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer)
        entry.flushTimer = null
        entry.exitCode = code
      }
      // 종료 줄은 렌더러가 evtScriptExit 를 받아 직접 붙인다. 나중에 뜬 창도 같은 화면을 보도록
      // 꼬리 버퍼에는 여기서 같은 문구를 남겨 둔다.
      this.remember(key, `\n[wooi] exited (code ${code ?? '?'})\n`)
      this.dispatch(IPC.evtScriptExit, { workspaceId, scriptId, code })
      this.onExit?.(workspaceId, scriptId, code)
    })
  }

  /** 내보낸 출력을 꼬리 버퍼에 누적한다(상한을 넘으면 앞을 잘라 최신 부분만 남긴다). */
  private remember(key: string, chunk: string): void {
    this.history.set(key, appendTail(this.history.get(key) ?? '', chunk))
  }

  /** 다음 flush 가 예약돼 있지 않으면 하나 예약한다(주기적으로 묶어 보냄). */
  private scheduleFlush(workspaceId: string, scriptId: string): void {
    const entry = this.running.get(this.key(workspaceId, scriptId))
    if (!entry || entry.flushTimer) return
    entry.flushTimer = setTimeout(() => this.flush(workspaceId, scriptId), FLUSH_INTERVAL_MS)
  }

  /** 모아 둔 stdout/stderr 를 스트림별로 한 번의 IPC 메시지로 보낸다. */
  private flush(workspaceId: string, scriptId: string): void {
    const entry = this.running.get(this.key(workspaceId, scriptId))
    if (!entry) return
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    const key = this.key(workspaceId, scriptId)
    if (entry.pendingOut) {
      const chunk = entry.pendingOut
      entry.pendingOut = ''
      this.remember(key, chunk)
      this.dispatch(IPC.evtScriptOutput, { workspaceId, scriptId, stream: 'stdout', chunk })
    }
    if (entry.pendingErr) {
      const chunk = entry.pendingErr
      entry.pendingErr = ''
      this.remember(key, chunk)
      this.dispatch(IPC.evtScriptOutput, { workspaceId, scriptId, stream: 'stderr', chunk })
    }
  }

  /**
   * 일회성 명령을 실행하고 종료까지 기다린다(아카이브 스크립트 등).
   * timeout 초과 시 종료를 강제하고 resolve 한다 — 아카이브가 무한정 멈추지 않게.
   *
   * 출력과 종료 코드를 돌려준다. 이 결과를 버리면 `docker compose down` 이 실패해도
   * 아무 데도 남지 않아, 사용자는 컨테이너가 살아 있는 걸 한참 뒤에나 알게 된다.
   * 출력을 실제로 읽는 것은 진단용만이 아니다 — stdio 는 어차피 pipe 로 열리므로,
   * 읽지 않으면 파이프 버퍼가 차는 순간 자식이 write 에서 멈춰 타임아웃까지 끌려간다.
   */
  runOnce(command: string, cwd: string, timeoutMs = 120_000): Promise<RunOnceResult> {
    if (!command.trim()) return Promise.resolve({ code: 0, timedOut: false, output: '' })
    return new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/zsh'
      // run() 과 같은 이유로 detached — 자식이 띄운 손자까지 그룹 단위로 정리한다.
      const proc = spawn(shell, ['-lc', command], { cwd, detached: true })
      let output = ''
      let timedOut = false
      let done = false
      const finish = (code: number | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code, timedOut, output })
      }
      const timer = setTimeout(() => {
        timedOut = true
        killProcessGroup(proc)
        // 그룹을 죽였으니 close 를 더 기다리지 않는다 — 여기까지 모은 출력이 진단의 전부다.
        finish(null)
      }, timeoutMs)
      proc.stdout?.on('data', (data: Buffer) => {
        output = appendTail(output, data.toString())
      })
      proc.stderr?.on('data', (data: Buffer) => {
        output = appendTail(output, data.toString())
      })
      proc.on('error', (err) => {
        // 셸을 띄우지도 못한 경우 — 종료 코드가 없으므로 실패로 보이도록 null 로 끝낸다.
        output = appendTail(output, `\n[wooi] failed to start: ${err.message}\n`)
        finish(null)
      })
      proc.on('close', (code) => finish(code))
    })
  }

  stop(workspaceId: string, scriptId: string): void {
    const entry = this.running.get(this.key(workspaceId, scriptId))
    if (entry) {
      if (entry.flushTimer) clearTimeout(entry.flushTimer)
      killProcessGroup(entry.proc)
    }
    this.running.delete(this.key(workspaceId, scriptId))
  }

  /** 지금까지의 누적 출력(꼬리). 나중에 뜬 창이 이전 로그를 채우는 데 쓴다. */
  getOutput(workspaceId: string, scriptId: string): string {
    return this.history.get(this.key(workspaceId, scriptId)) ?? ''
  }

  getStatus(workspaceId: string): ScriptStatus[] {
    const prefix = `${workspaceId}:`
    const ids = new Set<string>()
    for (const key of [...this.running.keys(), ...this.history.keys()])
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length))
    return [...ids].map((scriptId) => {
      const entry = this.running.get(this.key(workspaceId, scriptId))
      if (!entry) return { scriptId, state: 'idle', exitCode: null }
      if (entry.proc.exitCode === null && !entry.proc.killed) {
        return { scriptId, state: 'running', exitCode: null }
      }
      return { scriptId, state: 'exited', exitCode: entry.exitCode }
    })
  }

  disposeWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`
    for (const key of [...this.running.keys()])
      if (key.startsWith(prefix)) this.stop(workspaceId, key.slice(prefix.length))
    for (const key of [...this.history.keys()]) if (key.startsWith(prefix)) this.history.delete(key)
  }

  disposeAll(): void {
    for (const { proc } of this.running.values()) killProcessGroup(proc)
    this.running.clear()
    this.history.clear()
  }
}
