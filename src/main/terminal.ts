import * as pty from 'node-pty'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/types'
import type { ChatItem } from '@shared/types'
import { getTranscripts } from './transcripts'

type Dispatch = (channel: string, payload: unknown) => void

/** 재부착 시 재생할 출력 버퍼 상한(바이트 근사). 초과분은 앞에서 잘라낸다. */
const BUFFER_LIMIT = 256 * 1024

/**
 * 출력 코얼레싱 주기(ms). PTY 데이터를 매 청크마다 즉시 renderer 로 보내지 않고 이 간격으로
 * 모아 한 번에 보낸다 — 출력이 폭주하면(빌드/dev 서버 로그, 무한 출력 명령) 매 청크가 별도
 * IPC 메시지가 되어 느린 renderer 뒤로 메인 프로세스 송신 큐가 무한 적재되고, 결국 메인
 * V8 힙 OOM 으로 앱 전체가 죽는다(관측된 크래시). 모아 보내면 메시지 수가 급감해 큐 적체와
 * 메모리 압력을 함께 억제한다.
 */
const FLUSH_INTERVAL_MS = 16

/**
 * 한 번의 flush 로 보낼 누적 출력 상한(바이트 근사). 초과분은 앞에서 잘라 tail 만 남긴다
 * (replay 버퍼와 동일한 절사 정책). flush 사이에 폭주해도 단일 payload·메인 메모리를 묶어 둔다.
 */
const PENDING_LIMIT = 512 * 1024

/** 인라인 `!명령`(execInline)의 출력 갱신 묶음 주기(ms). 폭주 시 IPC 메시지 수를 억제한다. */
const INLINE_FLUSH_MS = 80

/** 인라인 `!명령` 출력 누적 상한(바이트 근사). 초과분은 앞에서 잘라 tail 만 남긴다. */
const INLINE_OUTPUT_LIMIT = 256 * 1024

interface Term {
  proc: pty.IPty
  /** 최근 출력 누적. workspace 전환 후 돌아왔을 때 화면을 복원하기 위해 보관한다. */
  buffer: string
  /** 아직 renderer 로 보내지 않고 모아 둔 출력. flush 시 한 번에 보낸다. */
  pending: string
  /** 예약된 flush 타이머(없으면 null). 청크당 하나만 잡고 재사용한다. */
  flushTimer: ReturnType<typeof setTimeout> | null
}

/**
 * workspace 당 인터랙티브 PTY 1개를 관리한다(우하단 터미널).
 *
 * PTY 는 workspace 수명 동안 살아남아, 다른 workspace 를 보다가 돌아와도 실행 중이던
 * 명령과 셸 상태가 유지된다. 화면(xterm)은 재부착될 때 누적 버퍼를 reset 이벤트로 한 번에
 * 재생해 복원한다 — 출력은 단일 채널(evtTerminalData)로만 흘러 재생/실시간 순서가 보장된다.
 *
 * 로그인 셸로 띄워 nvm/asdf 등으로 구성된 사용자 PATH 를 그대로 쓴다.
 */
export class TerminalManager {
  private terms = new Map<string, Term>()
  /**
   * 진행 중인 인라인 `!명령`(execInline)의 자식 프로세스. 키는 `${workspaceId}:${itemId}`.
   * 실행 중 사용자가 "중단"을 누르면 여기서 찾아 프로세스 그룹째 종료한다. 종료되면 제거한다.
   */
  private inlineProcs = new Map<string, ReturnType<typeof spawn>>()

  constructor(private dispatch: Dispatch) {}

  /**
   * workspace 의 PTY 를 생성·보장한다(이미 있으면 그대로 반환). 화면 재생(reset)은 하지 않는다.
   * 화면이 붙어 있지 않은 상태에서도(우측 패널 숨김 등) 명령을 실행할 수 있도록,
   * start() 와 runCommand() 가 공유하는 PTY 생성 지점이다.
   */
  private ensure(workspaceId: string, cwd: string, cols: number, rows: number): Term {
    let term = this.terms.get(workspaceId)
    if (term) return term

    const shell = process.env.SHELL || '/bin/zsh'
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >
    })
    term = { proc, buffer: '', pending: '', flushTimer: null }
    this.terms.set(workspaceId, term)

    proc.onData((data) => {
      const t = this.terms.get(workspaceId)
      if (!t) return
      t.buffer += data
      if (t.buffer.length > BUFFER_LIMIT) t.buffer = t.buffer.slice(-BUFFER_LIMIT)
      // 즉시 보내지 않고 모아 둔다 — 폭주 시 IPC 메시지 홍수로 메인 힙이 OOM 되는 것을 막는다.
      t.pending += data
      if (t.pending.length > PENDING_LIMIT) t.pending = t.pending.slice(-PENDING_LIMIT)
      this.scheduleFlush(workspaceId)
    })
    proc.onExit(({ exitCode }) => {
      // 종료 직전 남은 출력을 마저 비우고 타이머를 정리한 뒤 종료를 알린다.
      this.flush(workspaceId)
      const t = this.terms.get(workspaceId)
      if (t?.flushTimer) clearTimeout(t.flushTimer)
      this.terms.delete(workspaceId)
      this.dispatch(IPC.evtTerminalExit, { workspaceId, code: exitCode })
    })
    return term
  }

  /**
   * workspace 의 PTY 를 보장하고, 화면 복원을 위해 누적 버퍼를 reset 이벤트로 재생한다.
   * 이미 떠 있으면 새로 만들지 않고 버퍼만 재생한다(전환 후 복귀).
   */
  start(workspaceId: string, cwd: string, cols: number, rows: number): void {
    const existed = this.terms.has(workspaceId)
    const term = this.ensure(workspaceId, cwd, cols, rows)
    // 이미 떠 있던 PTY 면 요청 크기에 맞춰 다시 맞춘다.
    if (existed) this.safeResize(term, cols, rows)

    // reset 재생 전에 대기 중 flush 를 취소·비운다 — buffer 가 이미 그 내용을 포함하므로
    // 재생 직후 pending 을 또 보내면 같은 출력이 중복된다.
    if (term.flushTimer) {
      clearTimeout(term.flushTimer)
      term.flushTimer = null
    }
    term.pending = ''

    // 누적 버퍼를 화면 복원용으로 재생(reset). 실시간 출력과 같은 채널이라 순서가 보장된다.
    this.dispatch(IPC.evtTerminalData, { workspaceId, data: term.buffer, reset: true })
  }

  /**
   * 입력창의 `!명령` 을 PTY 에서 실행한다(Claude Code CLI 의 bash 모드).
   * 화면(xterm)이 아직 안 붙어 있어도 동작하도록 PTY 를 기본 크기로 보장한 뒤 명령을 보낸다.
   * 화면이 나중에 붙으면 누적 버퍼(명령 + 출력)가 재생되어 그대로 복원된다.
   */
  runCommand(workspaceId: string, cwd: string, command: string): void {
    const cmd = command.trim()
    if (!cmd) return
    const term = this.ensure(workspaceId, cwd, 80, 24)
    // 캐리지 리턴으로 셸에 한 줄을 제출한다. 줄 끝의 개행은 셸이 알아서 처리한다.
    term.proc.write(`${cmd}\r`)
  }

  /**
   * 입력창의 `!명령` 을 1회 실행하고 출력을 대화 흐름(트랜스크립트)에 인라인으로 보여 준다.
   * Claude Code CLI 처럼 — 우측 터미널 패널이 아니라 메시지 영역에 명령/출력이 함께 쌓인다.
   *
   * PTY(인터랙티브 셸)가 아니라 로그인 셸의 1회성 프로세스로 돌려, stdout/stderr 를 묶어
   * 캡처한다. stdout 이 TTY 가 아니므로 대부분의 도구는 색 코드를 끄고 평문을 낸다.
   * 실행 중에는 같은 id 로 출력을 갱신(throttle)하고, 종료 시에만 트랜스크립트에 영속화한다.
   */
  execInline(workspaceId: string, cwd: string, command: string): void {
    const cmd = command.trim()
    if (!cmd) return

    const id = `bash:${randomUUID()}`
    const ts = Date.now()
    let output = ''
    let settled = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const send = (running: boolean, exitCode: number | null): void => {
      const item: ChatItem = { id, type: 'bash', command: cmd, output, exitCode, running, ts }
      this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
    }

    // 실행 시작을 즉시 알린다(스피너 + 명령 표시). 영속화는 종료 시 1회만 한다.
    send(true, null)

    // 출력 폭주 시 매 청크마다 IPC 를 보내지 않도록 갱신을 묶어 보낸다.
    const scheduleSend = (): void => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (!settled) send(true, null)
      }, INLINE_FLUSH_MS)
    }

    const onChunk = (d: Buffer | string): void => {
      output += d.toString()
      if (output.length > INLINE_OUTPUT_LIMIT) output = output.slice(-INLINE_OUTPUT_LIMIT)
      scheduleSend()
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      this.inlineProcs.delete(`${workspaceId}:${id}`)
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const item: ChatItem = {
        id,
        type: 'bash',
        command: cmd,
        output,
        exitCode,
        running: false,
        ts
      }
      getTranscripts().upsert(workspaceId, item)
      this.dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
    }

    const shell = process.env.SHELL || '/bin/zsh'
    let proc: ReturnType<typeof spawn>
    try {
      // detached: true → 새 프로세스 그룹으로 띄운다. 중단 시 셸뿐 아니라 셸이 낳은
      // 자식들(빌드/watcher 등)까지 그룹째(process.kill(-pid)) 종료하기 위해서다.
      proc = spawn(shell, ['-l', '-c', cmd], { cwd, detached: true })
    } catch (err) {
      output += (err as Error).message
      finish(null)
      return
    }

    this.inlineProcs.set(`${workspaceId}:${id}`, proc)
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)
    proc.on('error', (err) => {
      output += `${output && !output.endsWith('\n') ? '\n' : ''}${err.message}\n`
      finish(null)
    })
    // 신호로 종료된 경우(중단 버튼 등) code 는 null 이므로, 실패로 보이도록 exit code 를 매핑한다.
    proc.on('close', (code, signal) => finish(code == null && signal ? 143 : code))
  }

  /**
   * 진행 중인 인라인 `!명령`을 중단한다(대화 흐름의 "중단" 버튼). 프로세스 그룹째 SIGTERM 을
   * 보내고, 유예 후에도 살아 있으면 SIGKILL 로 강제 종료한다. 이미 끝났으면 아무 것도 안 한다.
   */
  killInline(workspaceId: string, itemId: string): void {
    const proc = this.inlineProcs.get(`${workspaceId}:${itemId}`)
    if (proc) this.killInlineProc(proc)
  }

  /** 인라인 프로세스를 그룹째 종료한다. 그룹 종료가 안 되면 프로세스 단독 종료로 폴백한다. */
  private killInlineProc(proc: ReturnType<typeof spawn>): void {
    const pid = proc.pid
    if (pid == null) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        // 이미 종료됨.
      }
    }
    // 유예 후에도 살아 있으면 강제 종료. 이미 죽었으면 신호 전송이 던지므로 무시한다.
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // 이미 종료됨.
      }
    }, 2000)
  }

  /** 다음 flush 가 예약돼 있지 않으면 하나 예약한다(청크당 하나만, 주기적으로 묶어 보냄). */
  private scheduleFlush(workspaceId: string): void {
    const term = this.terms.get(workspaceId)
    if (!term || term.flushTimer) return
    term.flushTimer = setTimeout(() => this.flush(workspaceId), FLUSH_INTERVAL_MS)
  }

  /** 모아 둔 출력을 한 번의 IPC 메시지로 renderer 에 보낸다. */
  private flush(workspaceId: string): void {
    const term = this.terms.get(workspaceId)
    if (!term) return
    if (term.flushTimer) {
      clearTimeout(term.flushTimer)
      term.flushTimer = null
    }
    if (!term.pending) return
    const data = term.pending
    term.pending = ''
    this.dispatch(IPC.evtTerminalData, { workspaceId, data })
  }

  write(workspaceId: string, data: string): void {
    this.terms.get(workspaceId)?.proc.write(data)
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    const term = this.terms.get(workspaceId)
    if (term) this.safeResize(term, cols, rows)
  }

  private safeResize(term: Term, cols: number, rows: number): void {
    try {
      term.proc.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      // PTY 가 막 종료된 경우 등 — 무시.
    }
  }

  /** workspace 의 PTY 를 종료한다(아카이브/삭제 시). */
  disposeWorkspace(workspaceId: string): void {
    // 진행 중인 인라인 `!명령`도 함께 정리한다(그룹째 종료).
    for (const [key, proc] of this.inlineProcs) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.killInlineProc(proc)
        this.inlineProcs.delete(key)
      }
    }
    const term = this.terms.get(workspaceId)
    if (!term) return
    if (term.flushTimer) clearTimeout(term.flushTimer)
    this.terms.delete(workspaceId)
    try {
      term.proc.kill()
    } catch {
      // 이미 종료됨.
    }
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.disposeWorkspace(id)
  }
}
