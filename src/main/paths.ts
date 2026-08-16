import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { toolSocketPath } from './agent/tools/socket'

/**
 * dev 실행과 설치된 앱의 데이터 경로를 분리한다.
 *
 * 분리하지 않으면 둘이 완전히 같은 자원을 쓴다:
 *  - userData: package.json 의 name 은 `wooi`, 배포 productName 은 `Wooi` 인데 macOS 기본
 *    파일시스템은 대소문자를 구분하지 않아 `~/Library/Application Support/wooi` 한 곳으로
 *    합쳐진다. 즉 dev 를 띄우면 실제 등록된 리포·workspace·트랜스크립트가 그대로 보이고,
 *    동시에 실행하면 wooi.json 쓰기가 경합한다.
 *  - worktree 루트: 양쪽 다 `~/wooi/workspaces` 라 dev 에서 만든 워크트리가 실제 목록과 섞인다.
 *
 * 그래서 패키징되지 않은 실행(= npm run dev)은 기본적으로 dev 전용 경로를 쓴다.
 * 실제 데이터로 재현해야 하는 디버깅 상황을 위해 `WOOI_DEV_ISOLATION=0` 으로 끌 수 있다.
 */
export function isDevIsolated(): boolean {
  // 지연 평가한다: git.ts 처럼 이 모듈을 import 하는 코드가 electron 런타임 밖(vitest)에서도
  // 로드되므로, 모듈 최상위에서 app 을 건드리면 import 만으로 터진다.
  return !app.isPackaged && process.env.WOOI_DEV_ISOLATION !== '0'
}

/**
 * userData(설정·트랜스크립트·로그·Chromium 프로필)를 dev 전용 디렉토리로 옮긴다.
 *
 * app.getPath('userData') 를 처음 읽는 코드보다 먼저 — 즉 main 엔트리의 첫 구문에서 —
 * 호출해야 한다. store/transcripts 는 lazy 싱글턴이라 이 시점 이후에 경로를 확정한다.
 */
export function applyDevPaths(): void {
  if (!isDevIsolated()) return
  const dir = join(app.getPath('appData'), 'Wooi (dev)')
  app.setPath('userData', dir)
  // sessionData 는 userData 를 기본값으로 "복사"해 두므로 명시적으로 같이 옮긴다
  // (Chromium 캐시·쿠키가 설치본 프로필에 남지 않게).
  app.setPath('sessionData', dir)
}

/**
 * worktree 등 사용자에게 보이는 산출물을 모아 두는 홈 하위 루트.
 * dev 는 `~/wooi-dev`, 설치본은 `~/wooi`. `WOOI_HOME` 으로 강제 지정할 수 있다.
 */
export function wooiHome(): string {
  const override = process.env.WOOI_HOME?.trim()
  if (override) return override
  return join(app.getPath('home'), isDevIsolated() ? 'wooi-dev' : 'wooi')
}

/** Electron 밖의 Node 프로세스가 실행할 MCP shim 경로. 패키징 때는 asar 밖 파일을 가리킨다. */
export function toolShimPath(): string {
  const unpacked = join(process.resourcesPath ?? '', 'app.asar.unpacked', 'out', 'main', 'toolShim.js')
  if (process.resourcesPath && existsSync(unpacked)) return unpacked
  return join(import.meta.dirname, 'toolShim.js')
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 현재 실행본의 dev/설치 경계를 그대로 반영한 외부 Claude Code 등록 명령. */
export function externalClaudeMcpSetupCommand(): string {
  return [
    'claude mcp add wooi',
    `--env WOOI_TOOL_SOCKET=${shellWord(toolSocketPath(app.getPath('userData')))}`,
    '--env WOOI_TOOL_EXTERNAL=1',
    '-- node',
    shellWord(toolShimPath())
  ].join(' ')
}
