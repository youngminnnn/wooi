import { app, session } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ARTIFACT_PARTITION, ARTIFACT_SCHEME, IPC } from '@shared/types'
import { parseArtifactUrl } from '@shared/artifactUrl'
import { ArtifactError, getArtifacts } from './artifacts'
import { log } from './logger'

/**
 * 아티팩트 게스트에게 파일을 건네는 문 — 그리고 그 게스트를 가두는 벽.
 *
 * Preview([[main/preview]])와 나눠 놓은 이유는 신뢰 수준이 다르기 때문이다. 미리보는 dev
 * 서버는 **사용자 자신의 코드**라 웹을 자유롭게 돌아다녀도 된다. 아티팩트는 **모델이 쓴
 * 코드**이고, 그 모델은 방금 읽은 저장소에서 프롬프트 인젝션을 당했을 수 있다. 그래서 여기의
 * 기본값은 전부 거절이고, 뚫려 있는 것은 우리가 직접 건네는 파일 세 개뿐이다.
 *
 * 핸들러를 **파티션의** protocol 에 건다는 점이 요점이다. 전역 `protocol` 모듈은
 * defaultSession 에만 등록되므로 앱 렌더러도 아티팩트 본문을 읽을 수 있게 된다. 파티션에
 * 걸면 앱 렌더러와 Preview 파티션 **양쪽 다** 이 스킴에 핸들러가 없어 그냥 실패한다.
 */

/**
 * 게스트 문서에 씌우는 CSP.
 *
 * **이것이 유일한 망 차단 수단이다.** `webRequest` 로 한 겹 더 막지 않는 이유는 중복이라서다 —
 * `connect-src 'none'` 이 fetch·XHR·WebSocket·EventSource·sendBeacon 을 요청이 만들어지기
 * 전에 죽이고, URL 접두사 필터와 달리 리소스 종류를 정확히 안다. 겹치면 우리 자신의
 * 서브리소스를 실수로 끊을 위험만 는다. CSP 가 못 막는 것(최상위 이동)은 아래
 * `will-navigate` 가 맡는다.
 *
 * `script-src` 의 `'unsafe-inline'` 은 **빼면 안 된다** — 아티팩트의 인라인 `<script>` 가 곧
 * 기능이다. "아티팩트로의 XSS" 는 의미 없는 위협이다(넣는 사람과 당하는 사람이 같다).
 * 실제로 값을 하는 통제는 망 차단·이동 차단·preload 제거·세션 분리이고 그건 전부 켜져 있다.
 * `'unsafe-eval'` 은 넣지 않는다 — JSX 트랜스파일은 main 에서 끝내므로 필요가 없다.
 *
 * `style-src` 의 `'unsafe-inline'` 도 필수다 — React 의 인라인 `style`, recharts 가 SVG
 * 노드마다 심는 스타일이 전부 여기 걸린다.
 *
 * CSP 의 `sandbox` 지시문은 **쓰지 않는다.** `allow-same-origin` 없이는 origin 이 opaque 가
 * 되어 `'self'` 가 아무것도 매치하지 않고 우리가 건네는 `module.js`·`style.css` 부터 막힌다.
 * 샌드박스 역할은 세션 격리가 한다.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

function mimeFor(file: string): string {
  const dot = file.lastIndexOf('.')
  return (dot >= 0 && MIME[file.slice(dot)]) || 'application/octet-stream'
}

/**
 * 모든 응답에 같은 헤더를 씌운다.
 *
 * `no-store` 가 없으면 버전 전환이 옛 내용을 보여준다 — 지운 버전의 주소를 재사용하지 않도록
 * 저장소가 번호를 이어 가지만([[main/artifacts]]), 캐시는 그것과 별개로 끈다.
 */
function serve(body: string | null, file: string): Response {
  const headers = {
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
  if (body === null) return new Response('Not found', { status: 404, headers })
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': mimeFor(file) } })
}

/**
 * 벤더 라이브러리(react·recharts 등)가 놓인 디렉터리.
 *
 * `app.getAppPath()` 하나로 정하지 않는다 — 그 값은 패키지된 앱, `electron .`,
 * 번들 엔트리 직접 실행(`npm run dev:sandbox`·e2e 하네스)에서 각각 다르다. 트레이 아이콘이
 * 이미 같은 문제를 밟았고([[main/backgroundMode]] trayIconPath) 해법도 같다 — 후보를 늘어놓고
 * 실제로 있는 것을 고른다.
 *
 * 4단계(`react`) 전까지는 이 디렉터리가 없고, 그때까지 `/v/*` 는 404 다.
 */
function vendorDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'out', 'artifact', 'v'),
    join(import.meta.dirname, '..', 'artifact', 'v'),
    join(process.resourcesPath ?? '', 'app.asar', 'out', 'artifact', 'v')
  ]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

function readVendor(file: string): string | null {
  const dir = vendorDir()
  if (!dir) return null
  // 파일 이름은 `parseArtifactUrl` 이 이미 좁혔지만, 경로 조립에는 봉쇄 검사를 늘 붙인다.
  const root = resolve(dir)
  const target = resolve(root, file)
  if (!target.startsWith(root + sep)) return null
  return existsSync(target) ? readFileSync(target, 'utf-8') : null
}

/**
 * 렌더러로 신호를 보내는 통로. [[main/preview]] 의 `dispatchToRenderer` 와 같은 이유로 여기
 * 들고 있다 — 도구는 main 에서 돌지만 탭을 여는 것은 렌더러의 일이고, 작업 패널은 분리된
 * 창에 있을 수 있어 렌더러 안에서 직접 부를 수 없다.
 */
let dispatchToRenderer: (channel: string, payload: unknown) => void = () => {}

/**
 * 아티팩트 세션과 그 울타리를 세운다(앱 기동 시 1회, ready 뒤).
 *
 * `<webview>` 자체에 거는 가드(preload 제거·sandbox 강제·파티션 검사·이동 차단)는
 * [[main/preview]] 의 `web-contents-created` 훅이 두 파티션을 함께 맡는다 — 창마다 걸면
 * 나중에 생긴 창에서 조용히 빠지기 때문에 그 훅은 앱에 하나여야 한다.
 */
export function initArtifactSession(dispatch: (channel: string, payload: unknown) => void): void {
  dispatchToRenderer = dispatch
  const artifactSession = session.fromPartition(ARTIFACT_PARTITION)

  // 카메라·마이크·알림·위치·클립보드 — 물어보지도 않고 전부 거절한다.
  artifactSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  artifactSession.setPermissionCheckHandler(() => false)
  artifactSession.setDevicePermissionHandler(() => false)

  // 다운로드는 CSP 를 우회하는 디스크 쓰기 원시연산이다(`<a download>`·Content-Disposition).
  artifactSession.on('will-download', (event) => {
    event.preventDefault()
    log.info('artifact: blocked a download')
  })

  artifactSession.protocol.handle(ARTIFACT_SCHEME, (request) => {
    const route = parseArtifactUrl(request.url)
    if (!route) {
      log.info(`artifact: refused ${request.url}`)
      return serve(null, '')
    }

    if (route.kind === 'vendor') return serve(readVendor(route.file), route.file)

    try {
      const body = getArtifacts().readFile(
        route.workspaceId,
        route.artifactId,
        route.version,
        route.file
      )
      return serve(body, route.file)
    } catch (err) {
      // 저장소가 거절한 경로. 문법을 통과했는데 여기까지 왔다면 알아 둘 값이 있다.
      if (err instanceof ArtifactError) log.error(`artifact: ${err.message} (${request.url})`)
      else throw err
      return serve(null, '')
    }
  })
}

/**
 * 아티팩트 탭을 열고 그 버전을 보이라고 알린다.
 *
 * **best-effort 다.** 받을 화면이 없어도(사용자가 다른 워크스페이스를 보고 있거나 앱이 접혀
 * 있어도) 아티팩트는 이미 디스크에 있다. Preview 도구는 게스트가 붙기를 기다렸다가 실패할 수
 * 있지만([[agent/tools/preview]]) 그건 미리보기가 본질적으로 살아 있는 것이기 때문이고,
 * 아티팩트 쓰기는 그렇지 않다 — 배경 워크스페이스의 서브에이전트가 만든 것도 남아야 한다.
 */
export function requestArtifactOpen(
  workspaceId: string,
  artifactId: string,
  version: number
): void {
  dispatchToRenderer(IPC.evtArtifactOpen, { workspaceId, artifactId, version })
}

/** 목록이 바뀌었으니 다시 읽으라고 알린다. */
export function notifyArtifactsChanged(workspaceId: string): void {
  dispatchToRenderer(IPC.evtArtifactsChanged, { workspaceId })
}
