/**
 * Preview 가 쓰는 `<webview>` 태그의 타입 보강.
 *
 * `<webview>` 엘리먼트와 그 속성(`partition`·`webpreferences`·`src`)은 @types/react 가 이미
 * 알고 있다. 모르는 것은 **메서드**뿐이라 — React 는 `HTMLWebViewElement` 를 빈 인터페이스로
 * 두고 있다 — 여기서 그 부분만 채운다.
 *
 * electron 의 `WebviewTag` 를 그대로 끌어오지 않는 이유: 렌더러 tsconfig 는 electron 타입을
 * 들이지 않고(`types: ["node"]`), 이 화면이 실제로 쓰는 것은 아래 몇 개뿐이다. 표면을 좁게
 * 적어 두면 "Preview 가 게스트에게 무엇을 시키는가" 가 선언 자체로 드러난다.
 *
 * 이벤트는 React 의 on* prop 이 아니라 addEventListener 로 받는다 — `did-navigate` 같은
 * 이름은 React 의 합성 이벤트 체계에 없는 DOM 커스텀 이벤트라서다.
 */

declare global {
  interface HTMLWebViewElement {
    loadURL(url: string): Promise<void>
    getURL(): string
    reload(): void
    stop(): void
    goBack(): void
    goForward(): void
    canGoBack(): boolean
    canGoForward(): boolean
    /** main 이 캡처 대상을 특정하는 데 쓰는 게스트 webContents id([[main/preview]]). */
    getWebContentsId(): number
  }
}

/** Preview 가 다루는 게스트 뷰. */
export type PreviewWebview = HTMLWebViewElement

/** `did-navigate` / `did-navigate-in-page` 가 실어 오는 필드. */
export interface WebviewNavigateEvent extends Event {
  url: string
  isMainFrame?: boolean
}

/** `did-fail-load` 가 실어 오는 필드. */
export interface WebviewFailLoadEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}
