import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * main 프로세스 파일 로깅. userData/logs/main.log 에 타임스탬프 라인으로 append 하고
 * 콘솔에도 그대로 미러링한다(dev 터미널 가시성 유지).
 *
 * 배포된 앱은 콘솔이 보이지 않으므로, 사용자가 문제를 신고할 때 첨부할 수 있는
 * 영속 로그가 필요하다(CLI 미탐지·세션 오류 등 진단용). 외부 의존 없이 가볍게
 * 유지하려고 electron-log 대신 직접 구현했고, transcripts/store 와 같은
 * userData + appendFileSync 패턴을 따른다.
 */

// 1MB 초과 시 main.log.1 로 1세대만 회전한다(.1 은 덮어쓴다).
const MAX_BYTES = 1_000_000

let logFile: string | null = null

function file(): string {
  if (logFile) return logFile
  // 이 모듈은 메인과 agent-host(유틸리티 프로세스) 양쪽에서 로드된다. 유틸리티 프로세스에는
  // electron `app` 이 없고 ESM 에서 `import { app } from 'electron'` 자체가 로드 시 throw 하므로
  // electron 을 의존하지 않는다 — userData 는 메인이 startup 에서 설정(DITTO_USER_DATA)하고
  // host fork 시 그 값을 env 로 물려준다. DITTO_LOG_NAME 으로 호스트는 host.log 에 따로 적어
  // 메인의 main.log 와 동시 append 경합을 피한다. env 가 비는 예외 상황만 homedir 로 폴백한다.
  const userData =
    process.env.DITTO_USER_DATA || join(homedir(), 'Library', 'Application Support', 'Ditto')
  const dir = join(userData, 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  logFile = join(dir, process.env.DITTO_LOG_NAME || 'main.log')
  return logFile
}

function rotateIfNeeded(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
  } catch {
    // 회전 실패는 로깅 자체를 막지 않는다.
  }
}

type Level = 'info' | 'warn' | 'error'

function format(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function write(level: Level, args: unknown[]): void {
  const line = args.map(format).join(' ')

  // 콘솔 미러링(dev). 배포 빌드에서도 무해하다.
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(line)

  try {
    const path = file()
    rotateIfNeeded(path)
    appendFileSync(path, `${new Date().toISOString()} [${level}] ${line}\n`, 'utf-8')
  } catch {
    // 파일 쓰기 실패(권한 등)는 무시 — 콘솔에는 이미 남겼다.
  }
}

export const log = {
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args)
}

/** 로그 파일 절대 경로. 진단 안내·UI 노출이 필요할 때 사용한다. */
export function logFilePath(): string {
  return file()
}
