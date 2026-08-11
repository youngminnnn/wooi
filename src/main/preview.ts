import { app, session, shell, webContents } from 'electron'
import type { WebContents } from 'electron'
import { PREVIEW_PARTITION } from '@shared/types'
import type { ComposerAttachment, ImageAttachment, PreviewCaptureResult } from '@shared/types'
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
 * 콘솔·네트워크 문제 수집기. main 이 소유하고 개수만 렌더러로 흘린다([[previewIssues]]).
 * 모듈 수준에 두는 이유는 세션 배선(webRequest)이 앱 전체에 하나뿐이기 때문이다.
 */
let issues: PreviewIssueCollector

/** 수집기 접근자 — ipc 계층이 목록 조회·비우기·회신에 쓴다. */
export function previewIssues(): PreviewIssueCollector {
  return issues
}

/**
 * Preview 세션과 webview 울타리를 세운다(앱 기동 시 1회).
 *
 * `web-contents-created` 하나로 모든 창을 덮는 것이 요점이다 — 메인 창과 분리한 패널 창이
 * 각각 webview 를 붙일 수 있는데, 가드를 창마다 걸면 나중에 생긴 창에서 조용히 빠진다.
 */
export function initPreview(dispatch: (channel: string, payload: unknown) => void): void {
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
      if (params.partition !== PREVIEW_PARTITION) {
        log.error(`preview: refused a webview on partition "${params.partition ?? '(none)'}"`)
        event.preventDefault()
      }
    })

    // 여기서부터는 게스트(webview) 자신에게 거는 가드.
    if (contents.getType() !== 'webview') return

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
  issues.watch(workspaceId, target.guest)
}
