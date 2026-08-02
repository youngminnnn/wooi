import { runLoginShell } from '../shell'
import { log } from '../logger'
import { MIN_CODEX_VERSION, meetsMinimum, parseVersion } from './version'

/**
 * codex CLI 탐지.
 *
 * Claude 와 달리 바이너리를 번들하지 않는다 — `@openai/codex` 는 플랫폼당 ~320MB 라 앱 크기가
 * 두 배가 된다. 대신 사용자가 설치한 CLI 를 로그인 셸 PATH 에서 찾고, 없으면 설치를 안내한다.
 *
 * GUI 로 띄운 앱의 PATH 는 빈약해 npm global(`~/.local/bin`, nvm 등)이 잡히지 않으므로,
 * 반드시 `$SHELL -lc` 를 거치는 shell.ts 의 헬퍼를 쓴다.
 */

export interface CodexInstall {
  /** PATH 에서 찾은 실행 파일 절대 경로. 없으면 null. */
  path: string | null
  /** `codex --version` 에서 읽은 버전. 실행은 되지만 파싱 실패면 null. */
  version: string | null
  /** 지금 이 백엔드를 쓸 수 있는가(설치 + 최소 버전 충족). */
  usable: boolean
  /** usable=false 인 이유(사용자에게 그대로 보여 준다). */
  reason?: string
}

/** 설치 안내 문구. 통합 패널·워크스페이스 피커가 같은 문장을 쓰도록 여기서 정의한다. */
export const CODEX_INSTALL_HINT = 'Install with: npm i -g @openai/codex'

// 탐지는 프로세스를 두 번 spawn 하므로(경로 + 버전) 결과를 캐시한다. 사용자가 앱 실행 중에
// codex 를 설치할 수 있으므로 영구 캐시는 아니고, 창 포커스마다 도는 가용성 조회가 매번
// 셸을 띄우지 않을 정도로만 짧게 유지한다.
let cached: { at: number; value: CodexInstall } | null = null
const CACHE_MS = 10_000

/** 캐시를 즉시 무효화한다(설치 안내를 따라 방금 설치했을 수 있는 시점 등). */
export function invalidateCodexInstall(): void {
  cached = null
}

export async function detectCodex(): Promise<CodexInstall> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = await detect()
  cached = { at: Date.now(), value }
  return value
}

async function detect(): Promise<CodexInstall> {
  const { stdout: which, code } = await runLoginShell('command -v codex')
  const path = code === 0 ? which.trim().split('\n')[0] : null
  if (!path) {
    return {
      path: null,
      version: null,
      usable: false,
      reason: `Codex CLI (\`codex\`) is not installed. ${CODEX_INSTALL_HINT}`
    }
  }

  const { stdout, stderr, code: vCode } = await runLoginShell('codex --version')
  if (vCode !== 0) {
    log.warn(`codex: --version failed (${vCode}) ${stderr.trim()}`)
    // 실행은 되는데 버전 조회가 실패한 경우다. 막지 않는다 — 핸드셰이크에서 진짜 호환성이 걸러진다.
    return { path, version: null, usable: true }
  }

  const version = parseVersion(`${stdout} ${stderr}`)
  if (!meetsMinimum(version)) {
    return {
      path,
      version,
      usable: false,
      reason: `Codex ${version} is too old — Wooi needs ${MIN_CODEX_VERSION} or newer. Update with: npm i -g @openai/codex`
    }
  }

  return { path, version, usable: true }
}
