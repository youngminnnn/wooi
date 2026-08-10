import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, truncateSync } from 'node:fs'
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
 *
 * 이 모듈은 "로그를 남기다가 실패하는 상황"을 스스로 감당해야 한다. 실패를 다시 로그로
 * 남기면 되먹임 고리가 되고, 그 고리는 디스크를 채울 때까지 멈추지 않는다 — 실제로
 * main.log 가 40GB 까지 자란 사고가 있었다. 그래서 아래 세 가지를 불변식으로 지킨다:
 *  1. 콘솔 미러링 실패는 절대 예외로 새어 나가지 않는다(EPIPE → uncaughtException 금지).
 *  2. 로깅 경로에서 난 오류는 다시 로깅하지 않는다(재진입 차단 + 같은 줄 접기).
 *  3. 회전이 어떤 이유로 실패해도 파일 크기는 상한 안에 남는다.
 */

// 1MB 초과 시 main.log.1 로 1세대만 회전한다(.1 은 덮어쓴다).
const MAX_BYTES = 1_000_000

/** 같은 줄이 이만큼 반복되면 한 번 요약을 남긴다(폭주해도 로그가 읽히도록). */
const REPEAT_SUMMARY_EVERY = 1000

let logFile: string | null = null

function file(): string {
  if (logFile) return logFile
  // 이 모듈은 메인과 agent-host(유틸리티 프로세스) 양쪽에서 로드된다. 유틸리티 프로세스에는
  // electron `app` 이 없고 ESM 에서 `import { app } from 'electron'` 자체가 로드 시 throw 하므로
  // electron 을 의존하지 않는다 — userData 는 메인이 startup 에서 설정(WOOI_USER_DATA)하고
  // host fork 시 그 값을 env 로 물려준다. WOOI_LOG_NAME 으로 호스트는 host.log 에 따로 적어
  // 메인의 main.log 와 동시 append 경합을 피한다. env 가 비는 예외 상황만 homedir 로 폴백한다.
  const userData =
    process.env.WOOI_USER_DATA || join(homedir(), 'Library', 'Application Support', 'Wooi')
  const dir = join(userData, 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  logFile = join(dir, process.env.WOOI_LOG_NAME || 'main.log')
  return logFile
}

/** 두 경로가 같은 파일(같은 inode)을 가리키는지. 한쪽이 없으면 false. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a)
    const y = statSync(b)
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * 다음 줄을 붙였을 때 상한을 넘으면 회전한다. 회전이 통하지 않으면 잘라서라도 상한을 지킨다.
 *
 * rename 만 믿으면 안 된다. POSIX 는 원본과 대상이 **같은 파일**이면 rename 이 성공을 돌려주고
 * 아무 것도 하지 않도록 정해 두었다. 그래서 main.log 와 main.log.1 이 한 inode 를 가리키게
 * 되는 순간(하드링크, 혹은 여러 프로세스가 같은 경로를 동시에 rename 하다 남긴 디렉터리 엔트리
 * 이상) 회전은 "성공"만 하고 아무 것도 줄이지 않는다. 크기 검사는 계속 통과하고, append 는
 * 계속 같은 파일에 쌓이고, 예외도 안 나서 아무도 눈치채지 못한다 — 40GB 사고의 정체다.
 *
 * 그래서 회전한 뒤 **실제로 줄었는지 다시 확인하고**, 안 줄었으면 truncate 로 상한을 강제한다.
 */
function rotateIfNeeded(path: string, addition: number): void {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return // 파일이 아직 없다 — 회전할 것도 없다.
  }
  if (size + addition <= MAX_BYTES) return

  const backup = `${path}.1`
  try {
    // 같은 파일이면 rename 은 무의미하다(위 주석). 바로 잘라낸다.
    if (!sameFile(path, backup)) renameSync(path, backup)
  } catch {
    // 권한·경합으로 못 옮겼다. 아래 상한 강제가 받아 준다.
  }

  try {
    if (statSync(path).size + addition > MAX_BYTES) truncateSync(path, 0)
  } catch {
    // 여기까지 실패하면 더 할 수 있는 게 없다. 로그로 남기면 되먹임이 되므로 삼킨다.
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

/** stdout/stderr 가 살아 있는 동안만 콘솔에 미러링한다. 한 번 깨진 파이프는 되살아나지 않는다. */
let mirroring = true
let guarded = false

const GUARD_MARK = Symbol.for('wooi.logger.consoleGuard')

/**
 * stdout/stderr 의 쓰기 실패를 우리가 삼킨다.
 *
 * 파이프의 읽는 쪽이 사라지면(= `npm run dev` 를 띄운 터미널이 죽으면) write 는 EPIPE 로
 * 실패하는데, 이 오류는 **비동기로** 스트림의 'error' 이벤트로 올라온다. 그래서 console.error
 * 를 try/catch 로 감싸도 잡히지 않고, 리스너가 없으면 uncaughtException 이 된다. 그 핸들러가
 * 다시 log.error 를 부르고 → 다시 콘솔에 쓰고 → 다시 EPIPE 가 나는 고리가 여기서 생겼다.
 * 리스너를 달아 두면 고리의 첫 고리가 끊긴다.
 */
function installConsoleGuards(): void {
  if (guarded) return
  guarded = true
  for (const stream of [process.stdout, process.stderr]) {
    try {
      // 번들이 갈려 이 모듈이 두 번 로드돼도 리스너가 겹쳐 쌓이지 않게 표시를 남긴다.
      const marked = stream as unknown as Record<symbol, boolean> | undefined
      if (!marked || marked[GUARD_MARK]) continue
      marked[GUARD_MARK] = true
      stream.on('error', () => {
        mirroring = false
      })
    } catch {
      mirroring = false
    }
  }
}

/** 한 줄을 콘솔과 파일에 실제로 내보낸다. 여기서는 어떤 실패도 밖으로 던지지 않는다. */
function emit(level: Level, line: string): void {
  if (mirroring) {
    installConsoleGuards()
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    try {
      sink(line)
    } catch {
      // 동기 실패(파이프가 이미 닫힘 등)는 미러링을 끄고 파일 기록은 계속한다.
      mirroring = false
    }
  }

  try {
    const path = file()
    const text = `${new Date().toISOString()} [${level}] ${line}\n`
    rotateIfNeeded(path, text.length)
    appendFileSync(path, text, 'utf-8')
  } catch {
    // 파일 쓰기 실패(권한 등)는 무시 — 여기서 다시 로깅하면 그게 되먹임이다.
  }
}

/** 로깅 도중 발생한 로깅을 막는 재진입 플래그. */
let inWrite = false
/** 직전에 내보낸 줄과, 그 뒤로 접어 둔 반복 횟수. */
let lastKey = ''
let repeated = 0

function flushRepeats(): void {
  if (repeated === 0) return
  const times = repeated
  repeated = 0
  // 요약 자체는 lastKey 를 바꾸지 않는다 — 폭주가 이어지면 계속 접어야 한다.
  emit('warn', `last message repeated ${times} times`)
}

function write(level: Level, args: unknown[]): void {
  // 로깅 경로가 스스로 부른 로깅은 버린다. 되먹임의 두 번째 방어선이다.
  if (inWrite) return
  inWrite = true
  try {
    const line = args.map(format).join(' ')
    const key = `${level} ${line}`

    if (key === lastKey) {
      repeated++
      if (repeated >= REPEAT_SUMMARY_EVERY) flushRepeats()
      return
    }

    flushRepeats()
    lastKey = key
    emit(level, line)
  } finally {
    inWrite = false
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
