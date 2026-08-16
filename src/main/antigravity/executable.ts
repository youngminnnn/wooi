import { log } from '../logger'
import { runLoginShell } from '../shell'
import { compareVersions, parseVersion } from '../version'

/**
 * Antigravity CLI 설치 탐지. GUI 프로세스의 빈약한 PATH 에서는 `~/.local/bin`을 놓치므로 Codex 와
 * 마찬가지로 로그인 셸에서 경로와 버전을 확인한다.
 */
export interface AntigravityInstall {
  path: string | null
  version: string | null
  usable: boolean
  reason?: string
}

export const ANTIGRAVITY_INSTALL_HINT =
  'Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash'

/**
 * Wooi 가 의존하는 두 수정이 함께 들어온 1.1.12 를 최소로 잡는다. 그전에는 headless `-p`가
 * `--mode`의 accept-edits·plan 값을 무시해 권한 UI가 거짓말이 되고, 큰 checkout 안의 git repo를
 * submodule·worktree까지 올바르게 찾는 수정도 없어 모든 Wooi worktree 탐지가 실패했다(issue #253).
 */
export const MIN_ANTIGRAVITY_VERSION = '1.1.12'

// 경로·버전 확인으로 프로세스를 두 번 띄우므로 결과를 캐시한다. 앱 실행 중 설치·업데이트할 수 있어
// 영구 보관하지 않고, 창 포커스마다 가용성을 물어도 셸을 반복 실행하지 않을 만큼만 유지한다.
let cached: { at: number; value: AntigravityInstall } | null = null
const CACHE_MS = 10_000

export function invalidateAntigravityInstall(): void {
  cached = null
}

export async function detectAntigravity(): Promise<AntigravityInstall> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = await detect()
  cached = { at: Date.now(), value }
  return value
}

async function detect(): Promise<AntigravityInstall> {
  const { stdout: which, code } = await runLoginShell('command -v agy')
  const path = code === 0 ? which.trim().split('\n')[0] : null
  if (!path) {
    return {
      path: null,
      version: null,
      usable: false,
      reason: `Antigravity CLI (\`agy\`) is not installed. ${ANTIGRAVITY_INSTALL_HINT}`
    }
  }

  const { stdout, stderr, code: vCode } = await runLoginShell('agy --version')
  if (vCode !== 0) {
    log.warn(`antigravity: --version failed (${vCode}) ${stderr.trim()}`)
    // 실행 가능하지만 버전 조회만 실패한 설치를 오탐으로 막지 않는다. 실제 실행이 호환성을 가른다.
    return { path, version: null, usable: true }
  }

  const version = parseVersion(`${stdout} ${stderr}`)
  if (version && compareVersions(version, MIN_ANTIGRAVITY_VERSION) < 0) {
    return {
      path,
      version,
      usable: false,
      reason: `Antigravity ${version} is too old — Wooi needs ${MIN_ANTIGRAVITY_VERSION} or newer. Update with: curl -fsSL https://antigravity.google/cli/install.sh | bash`
    }
  }

  return { path, version, usable: true }
}
