import { spawn, type ChildProcess } from 'node:child_process'
import { IPC } from '@shared/types'
import type { ScriptKind, ScriptStatus } from '@shared/types'

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

  /**
   * @param onExit 스크립트 프로세스가 종료될 때(정상/비정상 무관) 불린다. setup 결과를
   *   영속화하는 등 종료 결과를 관찰해야 하는 상위 계층에서 사용한다.
   */
  constructor(
    private dispatch: Dispatch,
    private onExit?: (workspaceId: string, kind: ScriptKind, code: number | null) => void
  ) {}

  private key(workspaceId: string, kind: ScriptKind): string {
    return `${workspaceId}:${kind}`
  }

  run(
    workspaceId: string,
    kind: ScriptKind,
    command: string,
    cwd: string,
    env?: Record<string, string>
  ): void {
    if (!command.trim()) return
    this.stop(workspaceId, kind)

    const shell = process.env.SHELL || '/bin/zsh'
    // detached 로 새 프로세스 그룹을 만든다 — 중지 시 자식이 띄운 손자까지 그룹 단위로 정리한다.
    // env 로 workspace 별 PORT 등을 주입해 병렬 dev 서버가 같은 포트를 다투지 않게 한다.
    const proc = spawn(shell, ['-lc', command], {
      cwd,
      detached: true,
      ...(env ? { env: { ...process.env, ...env } } : {})
    })
    const key = this.key(workspaceId, kind)
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
      this.scheduleFlush(workspaceId, kind)
    })
    proc.stderr?.on('data', (data: Buffer) => {
      const entry = this.running.get(key)
      if (!entry) return
      entry.pendingErr += data.toString()
      if (entry.pendingErr.length > PENDING_LIMIT)
        entry.pendingErr = entry.pendingErr.slice(-PENDING_LIMIT)
      this.scheduleFlush(workspaceId, kind)
    })
    proc.on('error', (err) => {
      this.dispatch(IPC.evtScriptOutput, {
        workspaceId,
        kind,
        stream: 'stderr',
        chunk: `\n[ditto] failed to start: ${err.message}\n`
      })
    })
    proc.on('close', (code) => {
      // 종료 직전 남은 출력을 마저 비운 뒤 종료를 알린다(순서 보장).
      this.flush(workspaceId, kind)
      const entry = this.running.get(key)
      if (entry) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer)
        entry.flushTimer = null
        entry.exitCode = code
      }
      this.dispatch(IPC.evtScriptExit, { workspaceId, kind, code })
      this.onExit?.(workspaceId, kind, code)
    })
  }

  /** 다음 flush 가 예약돼 있지 않으면 하나 예약한다(주기적으로 묶어 보냄). */
  private scheduleFlush(workspaceId: string, kind: ScriptKind): void {
    const entry = this.running.get(this.key(workspaceId, kind))
    if (!entry || entry.flushTimer) return
    entry.flushTimer = setTimeout(() => this.flush(workspaceId, kind), FLUSH_INTERVAL_MS)
  }

  /** 모아 둔 stdout/stderr 를 스트림별로 한 번의 IPC 메시지로 보낸다. */
  private flush(workspaceId: string, kind: ScriptKind): void {
    const entry = this.running.get(this.key(workspaceId, kind))
    if (!entry) return
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.pendingOut) {
      const chunk = entry.pendingOut
      entry.pendingOut = ''
      this.dispatch(IPC.evtScriptOutput, { workspaceId, kind, stream: 'stdout', chunk })
    }
    if (entry.pendingErr) {
      const chunk = entry.pendingErr
      entry.pendingErr = ''
      this.dispatch(IPC.evtScriptOutput, { workspaceId, kind, stream: 'stderr', chunk })
    }
  }

  /**
   * 일회성 명령을 실행하고 종료까지 기다린다(아카이브 스크립트 등).
   * timeout 초과 시 종료를 강제하고 resolve 한다 — 아카이브가 무한정 멈추지 않게.
   */
  runOnce(command: string, cwd: string, timeoutMs = 120_000): Promise<void> {
    if (!command.trim()) return Promise.resolve()
    return new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/zsh'
      const proc = spawn(shell, ['-lc', command], { cwd, detached: true })
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      const timer = setTimeout(() => {
        killProcessGroup(proc)
        finish()
      }, timeoutMs)
      proc.on('error', () => {
        clearTimeout(timer)
        finish()
      })
      proc.on('close', () => {
        clearTimeout(timer)
        finish()
      })
    })
  }

  stop(workspaceId: string, kind: ScriptKind): void {
    const entry = this.running.get(this.key(workspaceId, kind))
    if (entry) {
      if (entry.flushTimer) clearTimeout(entry.flushTimer)
      killProcessGroup(entry.proc)
    }
    this.running.delete(this.key(workspaceId, kind))
  }

  getStatus(workspaceId: string): ScriptStatus[] {
    const kinds: ScriptKind[] = ['setup', 'dev']
    return kinds.map((kind) => {
      const entry = this.running.get(this.key(workspaceId, kind))
      if (!entry) return { kind, state: 'idle', exitCode: null }
      if (entry.proc.exitCode === null && !entry.proc.killed) {
        return { kind, state: 'running', exitCode: null }
      }
      return { kind, state: 'exited', exitCode: entry.exitCode }
    })
  }

  disposeWorkspace(workspaceId: string): void {
    this.stop(workspaceId, 'setup')
    this.stop(workspaceId, 'dev')
  }

  disposeAll(): void {
    for (const { proc } of this.running.values()) killProcessGroup(proc)
    this.running.clear()
  }
}
