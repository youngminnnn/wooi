import {
  BrowserWindow,
  Menu,
  clipboard,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import type { HostedViewKind } from '@shared/types'

/**
 * 게스트 뷰 안에서의 우클릭 메뉴.
 *
 * **Electron 은 웹 콘텐츠에 기본 컨텍스트 메뉴를 주지 않는다.** 브라우저처럼 보이는 화면에서
 * 우클릭이 아무 일도 안 하는 것은 사용자에게 "안 되는 기능" 으로 읽히므로, 여기서 직접 짓는다.
 * `<webview>` 시절에도 없었으니 이관으로 생긴 회귀는 아니고, 웹 탭이 생기면서 처음 드러난
 * 구멍이다 — dev 서버만 볼 때는 우클릭할 일이 거의 없었다.
 *
 * 항목은 **무엇을 눌렀는지**(`params`)가 정한다. 링크를 눌렀는데 "이미지 복사" 가 뜨거나,
 * 아무것도 안 골랐는데 "복사" 가 회색으로 떠 있는 메뉴는 없느니만 못하다.
 *
 * 종류마다 메뉴가 다른 것이 핵심이다. 아티팩트는 **모델이 쓴 코드**라 dev·웹과 규칙이 다르다 —
 * 아래 `openExternal` 항목을 본다.
 */

/** 앱 메뉴의 개발자 항목과 같은 신호를 쓴다 — 기준이 갈리면 한쪽만 dev 로 동작한다. */
function isDevRun(): boolean {
  return Boolean(process.env['ELECTRON_RENDERER_URL'])
}

function isWebUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * 이동 항목은 dev·웹에만 둔다.
 *
 * 아티팩트 게스트는 `applyArtifactGuards` 가 자기 origin 밖으로의 이동을 전부 막으므로
 * 히스토리가 사실상 없다. 눌러도 아무 일 없는 "뒤로" 를 그리는 것은 메뉴가 거짓말을 하는 것이다.
 */
function navigationItems(contents: WebContents): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Back',
      enabled: contents.navigationHistory.canGoBack(),
      click: () => contents.navigationHistory.goBack()
    },
    {
      label: 'Forward',
      enabled: contents.navigationHistory.canGoForward(),
      click: () => contents.navigationHistory.goForward()
    },
    { label: 'Reload', click: () => contents.reload() }
  ]
}

/**
 * 편집 가능한 곳에서의 항목.
 *
 * 맞춤법 제안을 맨 위에 두는 이유는 그것이 편집 중 우클릭의 주된 용도이기 때문이다.
 * 스펠체커가 꺼져 있으면 `dictionarySuggestions` 가 비어 있어 이 블록은 통째로 사라진다.
 */
function editableItems(
  contents: WebContents,
  params: ContextMenuParams
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []

  if (params.misspelledWord && params.dictionarySuggestions.length) {
    for (const word of params.dictionarySuggestions) {
      items.push({ label: word, click: () => contents.replaceMisspelling(word) })
    }
    items.push({ type: 'separator' })
  }

  items.push(
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { role: 'selectAll' }
  )
  return items
}

/**
 * 메뉴를 만든다. 비어 있으면 `null` — 띄울 것이 없으면 아무것도 안 띄운다.
 *
 * `kind` 가 여기까지 내려오는 이유는 아티팩트에 **바깥으로 나가는 항목을 주지 않기** 위해서다.
 * `applyArtifactGuards` 는 모델이 쓴 코드가 아무 데도 못 가게 막는데, "브라우저에서 열기" 를
 * 달아 주면 그 울타리가 사용자의 클릭 한 번으로 열린다 — 모델이 링크 글자를 "Documentation"
 * 이라 적고 주소에 방금 읽은 것을 실어 두면, 사용자는 자기가 무엇을 여는지 모른 채 연다.
 * 주소 **복사**는 남긴다. 클립보드는 아무 데도 가지 않고, 사용자가 붙여 넣기 전에 볼 수 있다.
 */
function buildMenu(
  contents: WebContents,
  params: ContextMenuParams,
  kind: HostedViewKind
): Menu | null {
  const sections: MenuItemConstructorOptions[][] = []
  const canLeave = kind !== 'artifact' && kind !== 'visualization'

  if (params.isEditable) {
    sections.push(editableItems(contents, params))
  } else if (params.selectionText.trim()) {
    sections.push([{ role: 'copy' }, { role: 'selectAll' }])
  }

  if (params.linkURL && isWebUrl(params.linkURL)) {
    const link: MenuItemConstructorOptions[] = [
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }
    ]
    if (canLeave) {
      link.unshift({
        label: 'Open Link in Browser',
        click: () => void shell.openExternal(params.linkURL)
      })
    }
    sections.push(link)
  }

  if (params.hasImageContents) {
    const image: MenuItemConstructorOptions[] = [
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) }
    ]
    if (params.srcURL) {
      image.push({
        label: 'Copy Image Address',
        click: () => clipboard.writeText(params.srcURL)
      })
    }
    sections.push(image)
  }

  if (canLeave) sections.push(navigationItems(contents))

  // 페이지 전체를 고를 길은 언제나 남긴다 — 위의 어느 갈래에도 안 걸리는 빈 곳을 눌렀을 때
  // 빈 메뉴가 뜨는 대신 할 수 있는 일이 하나는 보여야 한다.
  if (!sections.length) sections.push([{ role: 'selectAll' }])

  // 개발자 도구는 앱 메뉴와 같은 기준으로 dev 실행에만 둔다. 아티팩트에는 주지 않는다 —
  // 모델이 쓴 페이지를 들여다보는 입구는 소스 보기(아티팩트 탭 툴바)이지 devtools 가 아니다.
  if (isDevRun() && canLeave) {
    sections.push([
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) }
    ])
  }

  const template: MenuItemConstructorOptions[] = []
  for (const section of sections) {
    if (template.length) template.push({ type: 'separator' })
    template.push(...section)
  }
  return template.length ? Menu.buildFromTemplate(template) : null
}

/**
 * 이 게스트에 우클릭 메뉴를 단다.
 *
 * `ownerWindow` 를 클로저로 받는 이유: `WebContentsView` 는 창의 자식이라
 * `BrowserWindow.fromWebContents()` 로 자기 창을 못 찾는다. 그리고 주인 창은 **바뀐다** —
 * 작업 패널을 분리 창으로 떼면 같은 뷰가 다른 창으로 옮겨 붙으므로([[main/webViews]] attach),
 * 지금 값을 캡처해 두면 뗀 뒤에 메뉴가 엉뚱한 창에 뜬다.
 */
export function applyContextMenu(
  contents: WebContents,
  kind: HostedViewKind,
  ownerWindow: () => BrowserWindow | null
): void {
  contents.on('context-menu', (_event, params) => {
    const menu = buildMenu(contents, params, kind)
    if (!menu) return
    const win = ownerWindow()
    // 어느 창에도 안 붙은 뷰는 정상 상태다(에이전트가 만들어 두고 아직 안 연 탭). 그런 뷰는
    // 화면에 없으니 우클릭도 올 수 없지만, 왔다면 띄울 자리가 없는 것이므로 그냥 넘긴다.
    if (!win || win.isDestroyed()) return
    menu.popup({ window: win })
  })
}
