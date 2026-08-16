import * as acp from '@agentclientprotocol/sdk'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { log } from '../logger'

/** ACP 에이전트 실행 명세. 제품별 바이너리·인자는 호출부가 정한다. */
export interface AcpLaunchSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface AcpProcess {
  process: ChildProcess
  stream: acp.Stream
  /** 지금까지 모인 stderr. 연결 실패를 사람이 읽는 오류로 바꿀 때 쓴다. */
  stderr(): string
  /** stdin 을 닫고 프로세스를 정리한다. 여러 번 불러도 안전하다. */
  dispose(): void
}

/**
 * 주어진 명세로 ACP 에이전트를 띄우고 SDK 의 NDJSON 스트림을 연결한다.
 *
 * 프로세스 cwd 와 세션 cwd 는 별개다. 한 연결에 서로 다른 cwd 의 세션을 여러 개 둘 수 있다
 * ([[acp/session]]).
 */
export function spawnAcpProcess(spec: AcpLaunchSpec): AcpProcess {
  const options: SpawnOptions = {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe']
  }
  const proc = spawn(spec.command, spec.args ?? [], options)

  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => (stderr += chunk))
  // spawn 실패(ENOENT·EACCES)는 비동기 `error` 이벤트로 온다. 리스너가 없으면 호출부의
  // try/catch 밖에서 uncaught exception 이 되어 메인 프로세스를 깨뜨릴 수 있다.
  proc.on('error', (err) => {
    stderr += `${stderr ? '\n' : ''}${err.message}`
    log.error('acp: agent spawn failed', err)
  })

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin as NonNullable<typeof proc.stdin>),
    Readable.toWeb(proc.stdout as NonNullable<typeof proc.stdout>)
  )

  let disposed = false
  return {
    process: proc,
    stream,
    stderr: () => stderr,
    dispose: () => {
      if (disposed) return
      disposed = true
      proc.stdin?.end()
      if (!proc.killed) proc.kill('SIGTERM')
    }
  }
}
