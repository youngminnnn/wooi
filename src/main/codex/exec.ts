import { spawn } from 'node:child_process'
import type { EffortSetting } from '@shared/types'
import { log } from '../logger'

/**
 * `codex exec` 서브프로세스 구동 — 비대화형 1회 실행의 공통 배관.
 *
 * app-server(codex/host.ts)를 쓰지 않는 경로가 둘이다: PR 리뷰와 위임 실행. 둘 다 워크스페이스가
 * 없는 일회성 실행이라 스레드·승인·트랜스크립트 지속 기계장치가 통째로 걸리적거리고, `codex exec`
 * 가 정확히 그 용도로 만들어진 진입점이다. 프로세스 수명과 스트림 조립만 여기 모으고, **무엇을
 * 읽어낼지는 호출부의 리더**가 정한다.
 */

/** 프로세스 수명에 필요한 최소 의존성. */
export interface CodexExecDeps {
  cwd: string
  abort: AbortController
}

/** stdout 조각을 받아 이벤트로 접는 리더(codex/../review/runCodex.ts 의 createCodexReader). */
export interface CodexStreamReader {
  push: (chunk: string) => void
  end: () => void
}

export interface CodexExecOutcome {
  /** 프로세스가 결과 없이 실패했을 때의 메시지. 정상 종료면 null. */
  error: string | null
  /** 호출부가 중단시켰는지. true 면 error 는 무시해야 한다. */
  aborted: boolean
}

/**
 * codex 를 띄우고 stdout 을 리더에 흘려보낸 뒤 종료 결과를 돌려준다.
 *
 * 프롬프트는 **stdin 으로** 넘긴다. argv 로 넘기면 (1) diff 나 긴 지시문이 인자 길이 한계에
 * 걸리고, (2) `-` 로 시작하는 프롬프트가 샌드박스 플래그 뒤 override 위치의 플래그로 해석될 수
 * 있다. 호출부는 인자 목록 끝에 `-` 를 넣어 stdin 을 읽게 해야 한다.
 */
export function execCodex(
  executable: string,
  args: string[],
  prompt: string,
  deps: CodexExecDeps,
  reader: CodexStreamReader
): Promise<CodexExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: deps.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 사용자 셸에서 하이드레이트된 PATH·자격증명 환경을 그대로 물려준다.
      env: process.env,
      signal: deps.abort.signal
    })

    const out: CodexExecOutcome = { error: null, aborted: false }
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => reader.push(chunk.toString()))

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (deps.abort.signal.aborted) {
        out.aborted = true
        return
      }
      out.error = String(err)
    })

    child.on('close', (code) => {
      reader.end()
      if (deps.abort.signal.aborted) out.aborted = true
      if (!out.aborted && !out.error && code !== 0) {
        out.error = truncateStderr(stderr) || `Codex exited with code ${code}.`
      }
      if (stderr.trim()) log.warn(`codex exec: stderr — ${truncateStderr(stderr)}`)
      resolve(out)
    })

    child.stdin.on('error', () => {
      /* 프로세스가 먼저 죽으면 EPIPE 가 난다 — 종료 처리는 close 에서 한다. */
    })
    child.stdin.end(prompt)
  })
}

function truncateStderr(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}

/**
 * effort 선택값을 `codex exec` 의 `model_reasoning_effort` 값으로 좁힌다.
 *
 * 'ultracode' 는 Claude 전용 모드라 Codex 에는 없다 — 가장 가까운 최고 단계로 환산한다.
 * 'max' 도 Claude 에만 있는 단계라 같은 취급을 한다.
 */
export function codexEffort(effort: EffortSetting | null): string | undefined {
  if (!effort) return undefined
  if (effort === 'ultracode' || effort === 'max') return 'xhigh'
  return effort
}
