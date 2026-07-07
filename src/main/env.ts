import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './logger'

/**
 * GUI(Finder/dmg)로 띄운 앱은 launchd 가 주는 빈약한 환경만 물려받는다 — 사용자가 셸
 * 설정(.zshrc/.zshenv/.zprofile)에 정의한 PATH 와 환경 변수(JAVA_HOME·AWS_PROFILE·각종
 * API 토큰 등)가 통째로 빠진다. 그 결과 CLI 가 "설치됐는데 미설치"로 보이거나,
 * child 프로세스(인증 탐지·Agent SDK·gh CLI·스크립트·터미널)가 토큰/설정을 못 읽는다.
 *
 * 앱 시작 시 사용자의 로그인+인터랙티브 셸(-ilc)에서 export 된 환경 전체를 한 번
 * 캡처해 process.env 에 병합한다. -ilc 이므로 .zshenv·.zprofile 과 함께 .zshrc(인터랙티브
 * 전용)까지 모두 소스돼, 사용자가 어느 파일에 정의했든 동일하게 반영된다. 이후 모든
 * child spawn 이 올바른 환경을 물려받는다. 캡처 실패에 대비해 PATH 만은 흔한 설치
 * 위치를 함께 덧붙인다.
 */
export function hydrateEnvFromLoginShell(): void {
  const captured = resolveShellEnv()

  if (captured) {
    let applied = 0
    for (const [key, value] of Object.entries(captured)) {
      // PATH 는 fallback 병합을 위해 아래에서 따로 처리. PWD/SHLVL 등 프로브 셸의 일시적
      // 상태 변수는 Electron 프로세스에 넣으면 잘못된 값이 되므로 제외한다.
      if (TRANSIENT_VARS.has(key)) continue
      if (process.env[key] !== value) {
        process.env[key] = value
        applied++
      }
    }
    log.info(`env: hydrated ${applied} vars from login shell`)
  } else {
    log.warn('env: failed to capture login shell environment; applying PATH fallbacks only')
  }

  hydratePath(captured?.PATH ? captured.PATH.split(':') : null)
}

// 캡처한 셸 환경에서 process.env 로 옮기지 않을 변수들. PATH 는 별도 병합, 나머지는
// 프로브 셸의 실행 맥락을 반영할 뿐이라 Electron 프로세스로 옮기면 의미가 어긋난다.
const TRANSIENT_VARS = new Set(['PATH', 'PWD', 'OLDPWD', 'SHLVL', '_'])

/**
 * 캡처한 PATH 를 앞에, 기존 + 알려진 설치 위치를 뒤에 두고 순서 보존 중복 제거 후 반영.
 *
 * fallback 은 로그인 셸 캡처가 실패했을 때의 안전망이다. 특히 git 같은 도구는 호출 빈도가
 * 높아 매번 로그인 셸로 감싸지 않고(git.ts) process.env.PATH 에 직접 의존하므로, 흔한 설치
 * 위치를 빠짐없이 덮어 둔다 — homebrew(arm/intel)·MacPorts·asdf shim 과, GUI launchd 가
 * 기본 제공하는 시스템 경로(/usr/bin 의 Xcode CLT git 등)까지 포함한다.
 */
function hydratePath(captured: string[] | null): void {
  const home = homedir()
  const fallbacks = [
    join(home, '.local', 'bin'),
    join(home, '.asdf', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const current = process.env.PATH ? process.env.PATH.split(':') : []

  const merged: string[] = []
  const seen = new Set<string>()
  for (const dir of [...(captured ?? []), ...current, ...fallbacks]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir)
      merged.push(dir)
    }
  }

  process.env.PATH = merged.join(':')
  log.info(
    `env: PATH hydrated (${captured ? 'from login shell' : 'fallbacks only'}, ${merged.length} entries)`
  )
}

/** 로그인+인터랙티브 셸에서 export 된 환경 전체를 캡처한다. 실패 시 null. */
function resolveShellEnv(): Record<string, string> | null {
  const shell = process.env.SHELL || '/bin/zsh'
  const start = '__DITTO_ENV_START__'
  const end = '__DITTO_ENV_END__'
  try {
    // 인터랙티브(-i)여야 .zshrc 가 소스된다. env 출력을 sentinel 로 감싸 rc 잡음과 분리.
    const out = execFileSync(
      shell,
      ['-ilc', `printf '%s\\n' '${start}'; env; printf '%s\\n' '${end}'`],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    const startIdx = out.indexOf(start)
    const endIdx = out.lastIndexOf(end)
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null

    return parseEnvBlock(out.slice(startIdx + start.length, endIdx))
  } catch (err) {
    log.warn('env: failed to resolve login shell environment', err)
    return null
  }
}

/**
 * `env` 출력(KEY=VALUE 줄바꿈 구분)을 파싱한다. KEY= 형태로 시작하지 않는 줄은 직전
 * 변수의 멀티라인 값 연속으로 보고 이어 붙여, 값에 개행이 든 드문 경우도 보존한다.
 */
function parseEnvBlock(block: string): Record<string, string> {
  const lines = block.replace(/^\n/, '').split('\n')
  // env 출력 끝의 개행이 만든 빈 줄 한 개는 마지막 변수의 값으로 새지 않게 떼어낸다.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const env: Record<string, string> = {}
  let lastKey: string | null = null
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) {
      lastKey = match[1]
      env[lastKey] = match[2]
    } else if (lastKey !== null) {
      env[lastKey] += '\n' + line
    }
  }
  return env
}
