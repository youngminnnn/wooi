import { spawn } from 'node:child_process'
import { log } from './logger'

/**
 * 사용자의 로그인 셸로 명령을 실행한다.
 *
 * GUI 로 띄운 앱의 PATH 는 빈약해서 `claude`(~/.local/bin)·`codex`(npm global)·`gh`(homebrew)
 * 같은 CLI 가 잡히지 않는다. `$SHELL -lc` 로 실행하면 사용자의 rc 파일이 적용돼 실제 터미널과
 * 같은 PATH·환경을 본다. 인증 상태 조회와 CLI 설치 감지가 공통으로 쓴다.
 */
export function runLoginShell(
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const proc = spawn(shell, ['-lc', command])
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs
      ? setTimeout(() => {
          proc.kill('SIGTERM')
        }, timeoutMs)
      : null
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      log.error(`shell: failed to spawn login shell (${shell})`, err)
      resolve({ stdout, stderr, code: 1 })
    })
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

// 미탐지 진단을 명령당 1회만 남기기 위한 가드(인증 폴링이 짧은 주기로 반복 호출하므로).
const diagnosed = new Set<string>()

/** CLI 가 PATH 에 있는지 확인한다. 미설치와 "설치됐지만 미로그인"을 구분하기 위함이다. */
export async function isInstalled(command: string): Promise<boolean> {
  const { code } = await runLoginShell(`command -v ${command}`)

  // 미탐지 시 진단 정보를 1회 기록한다 — GUI 로 띄운 앱의 PATH 에 CLI 가 안 잡혀
  // "설치됐는데 미설치로 보이는" 흔한 사례를 로그로 가려내기 위함이다.
  if (code !== 0 && !diagnosed.has(command)) {
    diagnosed.add(command)
    const shell = process.env.SHELL || '/bin/zsh'
    const { stdout: path } = await runLoginShell('echo "$PATH"')
    log.warn(`shell: ${command} not found via ${shell} -lc; PATH=${path.trim()}`)
  }

  return code === 0
}
