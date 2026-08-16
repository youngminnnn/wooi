import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { log } from '../logger'
import type { AntigravityStreamReader } from './stream'

export interface AntigravityExecDeps {
  cwd: string
  abort: AbortController
  onSpawn?: (child: ChildProcess) => void
}

export interface AntigravityExecOutcome {
  error: string | null
  aborted: boolean
  stderr: string
  exitCode: number | null
}

export function execAntigravity(
  executable: string,
  args: string[],
  deps: AntigravityExecDeps,
  reader: AntigravityStreamReader
): Promise<AntigravityExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: deps.cwd,
      // Windows 에서 stdin=ignore 면 stdout 이 사라지는 사례(#187)가 있고, 열린 stdin 은 종료 뒤
      // 피드백 입력을 시도해 SIGTTIN 으로 멈춘다(#700). pipe 를 즉시 닫아 EOF 를 준다.
      stdio: ['pipe', 'pipe', 'pipe'],
      // 사용자 셸에서 하이드레이트된 PATH·자격증명 환경을 그대로 물려준다.
      env: process.env,
      signal: deps.abort.signal
    })
    deps.onSpawn?.(child)

    const out: AntigravityExecOutcome = {
      error: null,
      aborted: false,
      stderr: '',
      exitCode: null
    }
    // 청크별 toString 은 경계에 걸친 다중 바이트 문자의 양쪽을 U+FFFD 로 만든다. ASCII 테스트는
    // 이를 못 잡았지만 3바이트인 한글에는 흔하며, JSON 문자열 안의 U+FFFD 는 파싱도 성공해 조용히
    // 훼손된다(사용자 트랜스크립트의 `있` → `���`로 발견). StringDecoder 는 미완성 바이트를 다음
    // 청크까지 보류한다. stdout/stderr 는 독립된 바이트 스트림이므로 디코더도 각각 둔다.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')

    child.stdout.on('data', (chunk: Buffer) => reader.push(stdoutDecoder.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => {
      out.stderr += stderrDecoder.write(chunk)
    })
    child.on('error', (err) => {
      if (deps.abort.signal.aborted) out.aborted = true
      else out.error = String(err)
    })
    child.on('close', (code) => {
      // 스트림이 문자 중간에서 끝날 수도 있다. 꼬리를 버리면 마지막 문자가 조용히 사라진다.
      const stdoutRemainder = stdoutDecoder.end()
      if (stdoutRemainder) reader.push(stdoutRemainder)
      out.stderr += stderrDecoder.end()
      reader.end()
      out.exitCode = code
      if (deps.abort.signal.aborted) out.aborted = true
      if (!out.aborted && !out.error && code !== 0) {
        out.error = truncateStderr(out.stderr) || `Antigravity exited with code ${code}.`
      }
      // headless 는 승인 필요 도구를 soft-deny 하면서 성공 종료하고 stderr 에만 알린다(#794,
      // CHANGELOG 1.1.3). 호출부에는 원문을 보존하되 로그만 제한한다.
      if (out.stderr.trim()) log.warn(`antigravity exec: stderr — ${truncateStderr(out.stderr)}`)
      resolve(out)
    })

    child.stdin.on('error', () => {
      /* 프로세스가 먼저 죽으면 EPIPE 가 난다 — 종료 처리는 close 에서 한다. */
    })
    child.stdin.end()
  })
}

function truncateStderr(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}
