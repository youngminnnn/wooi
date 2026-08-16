import { log } from '../logger'
import { runLoginShell } from '../shell'

/** ACP stdio 표면을 직접 확인한 가장 낮은 Grok Build 릴리스. */
export const MIN_GROK_VERSION = '0.1.42'

const CACHE_MS = 10_000
let cached: { at: number; value: GrokInstall } | null = null

export interface GrokInstall {
  usable: boolean
  reason?: string
}

/** 설치 직후 가용성 조회가 새 바이너리를 보도록 짧은 캐시를 비운다. */
export function invalidateGrokInstall(): void {
  cached = null
}

/** Grok Build 설치와 버전만 확인한다. 로그인·구독 상태는 첫 세션의 인증 계층이 판단한다. */
export async function detectGrok(): Promise<GrokInstall> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = await detect()
  cached = { at: Date.now(), value }
  return value
}

async function detect(): Promise<GrokInstall> {
  const found = await runLoginShell('command -v grok')
  if (found.code !== 0 || !found.stdout.trim()) {
    return { usable: false, reason: 'Grok Build CLI (`grok`) is not installed' }
  }

  const attempts = ['grok version --json', 'grok version', 'grok --version']
  let output = ''
  for (const command of attempts) {
    const result = await runLoginShell(command)
    if (result.code === 0) {
      output = `${result.stdout} ${result.stderr}`
      break
    }
  }
  if (!output) {
    log.warn('grok: version commands failed')
    // 실행 파일은 확인됐으므로 버전 출력 형식 문제만으로 사용을 막지 않는다.
    return { usable: true }
  }

  const version = parseGrokVersion(output)
  if (version && compareVersions(version, MIN_GROK_VERSION) < 0) {
    return {
      usable: false,
      reason: `Grok Build ${version} is too old — Wooi needs ${MIN_GROK_VERSION} or newer`
    }
  }
  return { usable: true }
}

/** JSON 또는 평문 버전 출력에서 semver 세 자리를 뽑는다. */
export function parseGrokVersion(output: string): string | null {
  try {
    const value = JSON.parse(output.trim()) as Record<string, unknown>
    const version = value.version
    if (typeof version === 'string') return version.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch {
    // 평문 출력은 아래의 공통 정규식으로 읽는다.
  }
  return output.match(/\d+\.\d+\.\d+/)?.[0] ?? null
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}
