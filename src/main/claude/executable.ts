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
 * 이 모듈은 메인과 agent-host(유틸리티 프로세스) 양쪽에서 로드되므로 메인 전용 electron `app`
 * 에 의존하지 않는다. 환경변수(예전의 WOOI_PACKAGED)도 쓰지 않는다 — 그 값은 host fork 시에만
 * 주입돼 메인에서는 비어 있었고, 메인에서 직접 SDK 를 띄우는 PR 리뷰가 패키징 빌드에서 정확히
 * 그 이유로 spawn ENOTDIR 을 맞았다. 대신 풀어둔 바이너리가 실제로 있는지만 본다: 있으면
 * 패키징된 앱이고, 없으면 dev 라 SDK 기본값이 맞다. process.resourcesPath 는 두 프로세스
 * 모두에서 쓸 수 있고, Electron 밖(vitest)에서는 undefined 다.
 */
let cached: string | null | undefined

export function resolveClaudeExecutable(): string | null {
  if (cached !== undefined) return cached
  cached = compute()
  return cached
}

function compute(): string | null {
  const resources = process.resourcesPath
  if (!resources) return null

  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binary = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    'claude'
  )

  if (existsSync(binary)) return binary

  // asar 가 있는데 바이너리가 없다면 패키징이 잘못된 것이다 — dev 와 구분해 알린다.
  if (existsSync(join(resources, 'app.asar'))) {
    log.warn(`claude: unpacked native binary not found at ${binary}; using SDK default`)
  }
  return null
}
