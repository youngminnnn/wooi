import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'

/**
 * Agent SDK 가 spawn 할 Claude Code 네이티브 바이너리의 절대 경로를 돌려준다.
 *
 * 패키징된 앱에서 SDK(sdk.mjs)는 app.asar 안에 있어 import.meta.url 기준으로 바이너리
 * 경로를 app.asar/.../claude 로 계산한다. app.asar 는 디렉토리가 아니라 파일이라 그 경로를
 * 외부 프로세스로 exec 하면 spawn ENOTDIR 로 실패한다(설치 빌드에서 세션이 안 뜨는 원인).
 * 바이너리는 electron-builder 가 app.asar.unpacked 에 실제 파일로 풀어두므로, 그 경로를
 * 명시로 넘겨 우회한다. dev(asar 없음)에서는 null 을 돌려 SDK 기본값을 그대로 쓴다.
 *
 * 이 모듈은 agent-host(유틸리티 프로세스)에서 로드되므로 메인 전용 electron `app` 에
 * 의존하지 않는다. 패키징 여부는 메인이 host fork 시 넘기는 DITTO_PACKAGED 환경변수로 받고,
 * process.resourcesPath 는 유틸리티 프로세스에서도 사용할 수 있다.
 */
let cached: string | null | undefined

export function resolveClaudeExecutable(): string | null {
  if (cached !== undefined) return cached
  cached = compute()
  return cached
}

function compute(): string | null {
  if (process.env.DITTO_PACKAGED !== '1') return null

  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binary = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    'claude'
  )

  if (existsSync(binary)) return binary

  log.warn(`claude: unpacked native binary not found at ${binary}; using SDK default`)
  return null
}
