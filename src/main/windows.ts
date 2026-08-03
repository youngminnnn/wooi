import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

/**
 * 창(메인·분리한 패널) 공통 배선.
 *
 * 렌더러 번들은 하나뿐이고, 어떤 창인지는 URL 쿼리(`?pane=work`)로만 구분한다([[paneWindows]]).
 * 그래서 로드 방식과 내비게이션 가드도 창마다 따로 쓰지 않고 여기 한곳에 모은다 — 가드가 한
 * 창에만 걸려 있으면 그 창에서만 링크가 앱을 통째로 다른 페이지로 날려 버린다.
 */

/** 모든 창에 같은 preload/샌드박스 설정을 쓴다. */
export function rendererWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(import.meta.dirname, '../preload/index.mjs'),
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false
  }
}

/**
 * 외부 링크·이탈 내비게이션을 막는다.
 *
 * window.open/target=_blank 와 일반 <a> 클릭 모두 기본 브라우저로 넘기고, 그 밖의 이동은
 * 스킴을 가리지 않고 차단한다 — 특히 입력창 밖으로 파일을 떨어뜨리면 브라우저 기본 동작이
 * file:// 로 이동해 앱 화면이 그 파일로 바뀌고 되돌아올 방법이 없다.
 */
export function applyNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
}

/**
 * 렌더러 진입점을 로드한다. query 는 창의 역할(`pane`·`ws`)을 렌더러에 알리는 데 쓴다 —
 * 렌더러는 이 값을 보고 전체 앱 대신 해당 패널만 그린다.
 */
export function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const search = query ? `?${new URLSearchParams(query).toString()}` : ''
    void win.loadURL(`${devUrl}${search}`)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
  }
}
