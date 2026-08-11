import type { WebContents } from 'electron'
import type { PickedElement } from '@shared/previewPick'
import { log } from './logger'

/**
 * Preview 요소 픽커 — 미리보는 페이지에서 요소 하나를 집어 "이거요" 라고 가리키는 장치.
 *
 * 화면을 보며 "이 버튼 간격이 이상해" 라고 말하려면 지금은 사람이 DevTools 를 열어 클래스 이름을
 * 베껴 오거나, 스크린샷만 던지고 에이전트가 소스에서 그 요소를 찾아 헤매야 한다. 픽커는 그
 * 왕복을 없앤다 — 클릭 한 번으로 **무엇을 가리키는지**(선택자·outerHTML)와 **왜 그렇게
 * 보이는지**(적용된 CSS 규칙), 그리고 **어떻게 보이는지**(요소만 잘라낸 그림)를 한꺼번에 모은다.
 *
 * DevTools 프로토콜(CDP)을 쓰는 이유는 이것들이 전부 **게스트 바깥에서** 얻어져야 하기 때문이다.
 * 스크립트를 주입해 같은 일을 하면 미리보는 페이지를 오염시키고(전역·리스너·오버레이 DOM),
 * 무엇보다 `getMatchedStylesForNode` 에 해당하는 것을 페이지 안에서는 만들 수 없다 —
 * `getComputedStyle` 은 최종값만 알려 줄 뿐 **어느 규칙이 그 값을 만들었는지**는 잃어버린다.
 * 고쳐야 할 소스를 찾는 데 필요한 건 최종값이 아니라 그 규칙 쪽이다.
 */

/** 첨부 한 건에 실을 outerHTML 상한(자). 넘으면 뒤를 자른다. */
const MAX_HTML = 4000
/** 첨부 한 건에 실을 CSS 요약 상한(자). */
const MAX_CSS = 4000
/** 요소 크롭 캡처의 가로 상한(px). 전체 캡처(MAX_CAPTURE_WIDTH)보다 작게 잡아도 충분하다. */
const MAX_CROP_WIDTH = 1200
/** 크롭에 넣을 여백(CSS px). 요소만 딱 자르면 무엇에 둘러싸인 것인지 안 보인다. */
const CROP_PADDING = 8

/** 사용자가 아무것도 고르지 않고 놔둔 픽커를 언제까지 켜 둘지. */
const PICK_TIMEOUT_MS = 120_000

/** 게스트별로 진행 중인 픽. 두 번 켜지 못하게 하고, 취소 시 정리 대상을 찾는 데 쓴다. */
const active = new Map<number, { cancel: (reason: string) => void }>()

/**
 * CDP 를 켜고 사용자가 요소를 고를 때까지 기다린다.
 *
 * 켤 때만 debugger 를 붙이고 끝나면 반드시 뗀다 — 붙어 있는 동안은 사용자가 그 게스트의
 * DevTools 를 열 수 없고(열면 우리 쪽이 강제로 detach 된다) 렌더링도 느려진다.
 */
export async function pickElement(guest: WebContents): Promise<PickedElement | { error: string }> {
  const id = guest.id
  if (active.has(id)) return { error: 'Already picking an element.' }

  const dbg = guest.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
  } catch (err) {
    // DevTools 가 이미 열려 있으면 붙지 못한다 — 사용자가 이해할 수 있는 말로 돌려준다.
    log.error('preview: debugger attach failed', err)
    return { error: 'Close the preview DevTools first — the element picker needs the debugger.' }
  }

  const send = (method: string, params?: object): Promise<never> =>
    dbg.sendCommand(method, params) as Promise<never>

  return new Promise<PickedElement | { error: string }>((resolve) => {
    let done = false
    const finish = (result: PickedElement | { error: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      active.delete(id)
      dbg.removeListener('message', onMessage)
      dbg.removeListener('detach', onDetach)
      // 오버레이·검사 모드를 끄고 debugger 를 뗀다. 여기서 던져도 결과를 막지 않는다.
      void (async () => {
        try {
          await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} })
          await send('Overlay.disable')
        } catch {
          /* 게스트가 이미 사라졌다 — 뗄 것도 없다. */
        }
        try {
          if (dbg.isAttached()) dbg.detach()
        } catch {
          /* 위와 같다. */
        }
      })()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ error: 'Element picker timed out.' }), PICK_TIMEOUT_MS)
    active.set(id, { cancel: (reason) => finish({ error: reason }) })

    // DevTools 를 열거나 게스트가 이동하면 debugger 가 강제로 떨어진다 — 매달린 채로 두지 않는다.
    const onDetach = (): void => finish({ error: 'The element picker was interrupted.' })

    const onMessage = (_e: unknown, method: string, params: unknown): void => {
      if (method !== 'Overlay.inspectNodeRequested') return
      const backendNodeId = (params as { backendNodeId?: number }).backendNodeId
      if (backendNodeId == null) return finish({ error: 'Could not identify that element.' })
      void collect(guest, send, backendNodeId).then(finish, (err) => {
        log.error('preview: element collect failed', err)
        finish({ error: err instanceof Error ? err.message : 'Could not read that element.' })
      })
    }

    dbg.on('message', onMessage)
    dbg.on('detach', onDetach)
    ;(async () => {
      // DOM.getDocument 를 먼저 불러야 이후 노드 id 들이 유효해진다(CDP 규약).
      await send('DOM.enable')
      await send('CSS.enable')
      await send('Overlay.enable')
      await send('DOM.getDocument', { depth: -1 })
      // DevTools 와 같은 하이라이트를 **게스트가 직접** 그린다. 우리가 오버레이 DOM 을 주입하면
      // 미리보는 페이지가 오염되고, 그 DOM 이 캡처에도 같이 찍힌다.
      await send('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
          marginColor: { r: 246, g: 178, b: 107, a: 0.4 }
        }
      })
    })().catch((err) => {
      log.error('preview: inspect mode failed', err)
      finish({ error: 'Could not start the element picker.' })
    })
  })
}

/** 진행 중인 픽을 취소한다(사용자가 Esc 를 눌렀거나 패널이 사라졌을 때). */
export function cancelPick(webContentsId: number): void {
  active.get(webContentsId)?.cancel('cancelled')
}

/** 고른 노드에서 선택자·HTML·CSS·소스 위치·크롭을 모은다. */
async function collect(
  guest: WebContents,
  send: (method: string, params?: object) => Promise<never>,
  backendNodeId: number
): Promise<PickedElement> {
  const { nodeIds } = (await send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId]
  })) as unknown as { nodeIds: number[] }
  const nodeId = nodeIds?.[0]
  if (!nodeId) throw new Error('Could not resolve that element.')

  const [{ outerHTML }, matched, described] = await Promise.all([
    send('DOM.getOuterHTML', { nodeId }) as unknown as Promise<{ outerHTML: string }>,
    send('CSS.getMatchedStylesForNode', { nodeId }) as unknown as Promise<MatchedStyles>,
    // 선택자와 React 소스는 노드를 JS 객체로 되살려 페이지 안에서 계산한다 — 조상 체인을
    // CDP 로 한 단계씩 왕복하는 것보다 훨씬 싸고, 결과도 브라우저가 보는 것과 일치한다.
    describeInPage(send, backendNodeId)
  ])

  const html = clamp(outerHTML ?? '', MAX_HTML)
  const css = clamp(summarizeStyles(matched), MAX_CSS)

  return {
    selector: described.selector,
    html: html.text,
    htmlTruncated: html.truncated,
    css: css.text,
    cssTruncated: css.truncated,
    source: described.source,
    cropBase64: await cropElement(guest, send, nodeId)
  }
}

interface CssStyle {
  cssText?: string
  cssProperties?: { name: string; value: string; disabled?: boolean }[]
}
interface MatchedStyles {
  inlineStyle?: CssStyle
  matchedCSSRules?: {
    rule: {
      origin: string
      selectorList?: { text?: string }
      style?: CssStyle
    }
  }[]
}

/**
 * 적용된 규칙을 사람이 읽는 형태로 줄인다.
 *
 * user-agent 규칙은 뺀다 — 브라우저 기본값은 어느 페이지에나 있고, 고칠 수 있는 것도 아니라서
 * 첨부의 대부분을 잡아먹으면서 아무것도 알려 주지 않는다. 남는 것은 **저자가 쓴 규칙**뿐이다.
 */
function summarizeStyles(matched: MatchedStyles): string {
  const parts: string[] = []

  const inline = styleText(matched.inlineStyle)
  if (inline) parts.push(`/* inline */\nstyle="${inline}"`)

  // CDP 는 명시도가 낮은 것부터 준다 — 마지막에 이긴 규칙이 뒤에 오도록 순서를 뒤집는다.
  for (const { rule } of [...(matched.matchedCSSRules ?? [])].reverse()) {
    if (rule.origin !== 'regular' && rule.origin !== 'author') continue
    const text = styleText(rule.style)
    if (!text) continue
    parts.push(`${rule.selectorList?.text ?? '?'} { ${text} }`)
  }

  return parts.join('\n') || '/* no author CSS rules matched */'
}

function styleText(style?: CssStyle): string {
  if (!style) return ''
  if (style.cssText?.trim()) return style.cssText.trim().replace(/\s+/g, ' ')
  return (style.cssProperties ?? [])
    .filter((p) => !p.disabled)
    .map((p) => `${p.name}: ${p.value};`)
    .join(' ')
}

/**
 * 페이지 안에서 노드를 보고 선택자와 (있으면) React 소스 위치를 만든다.
 *
 * 선택자는 id → 안정적인 클래스 → :nth-of-type 순으로 좁히며 조상을 거슬러 올라간다.
 * 해시가 붙은 CSS-module/emotion 클래스(`Button_x7f3a`)는 빌드마다 바뀌므로 건너뛴다 —
 * 그런 이름을 실어 보내면 에이전트가 소스에서 찾을 수 없는 문자열을 쫓게 된다.
 */
async function describeInPage(
  send: (method: string, params?: object) => Promise<never>,
  backendNodeId: number
): Promise<{ selector: string; source: string | null }> {
  const { object } = (await send('DOM.resolveNode', { backendNodeId })) as unknown as {
    object: { objectId?: string }
  }
  if (!object?.objectId) return { selector: '?', source: null }

  const { result } = (await send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const HASHED = /^(.*[-_])?[a-z0-9]{5,}$/i
      const stable = (el) =>
        [...el.classList].filter((c) => !HASHED.test(c) || /^[a-z-]+$/.test(c)).slice(0, 2)
      const part = (el) => {
        if (el.id && !HASHED.test(el.id)) return '#' + CSS.escape(el.id)
        let s = el.tagName.toLowerCase()
        for (const c of stable(el)) s += '.' + CSS.escape(c)
        const siblings = el.parentElement
          ? [...el.parentElement.children].filter((x) => x.tagName === el.tagName)
          : []
        if (siblings.length > 1) s += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')'
        return s
      }
      const path = []
      let el = this
      while (el && el.nodeType === 1 && path.length < 6) {
        const p = part(el)
        path.unshift(p)
        if (p.startsWith('#')) break
        el = el.parentElement
      }

      // React dev 빌드는 fiber 에 소스 위치를 달아 둔다. 있으면 이게 가장 쓸모 있는 단서다.
      let source = null
      for (const key of Object.keys(this)) {
        if (!key.startsWith('__reactFiber$')) continue
        let fiber = this[key]
        while (fiber && !source) {
          const src = fiber._debugSource
          if (src && src.fileName) source = src.fileName + ':' + (src.lineNumber ?? '?')
          fiber = fiber._debugOwner
        }
        break
      }
      return { selector: path.join(' > '), source }
    }`
  })) as unknown as { result: { value?: { selector?: string; source?: string | null } } }

  return {
    selector: result?.value?.selector || '?',
    source: result?.value?.source ?? null
  }
}

/** 요소가 차지한 자리만 잘라 찍는다. 자리를 못 구하면(화면 밖·display:none) 크롭 없이 넘어간다. */
async function cropElement(
  guest: WebContents,
  send: (method: string, params?: object) => Promise<never>,
  nodeId: number
): Promise<string | undefined> {
  try {
    const box = (await send('DOM.getBoxModel', { nodeId })) as unknown as {
      model?: { border?: number[] }
    }
    const q = box.model?.border
    if (!q || q.length < 8) return undefined

    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const x = Math.floor(Math.min(...xs)) - CROP_PADDING
    const y = Math.floor(Math.min(...ys)) - CROP_PADDING
    const width = Math.ceil(Math.max(...xs) - Math.min(...xs)) + CROP_PADDING * 2
    const height = Math.ceil(Math.max(...ys) - Math.min(...ys)) + CROP_PADDING * 2
    if (width <= 0 || height <= 0) return undefined

    // 뷰포트 밖으로 삐져나간 좌표를 그대로 주면 capturePage 가 빈 이미지를 준다 — 잘라 맞춘다.
    // 크기는 CDP 로 묻는다(webContents 에는 게스트 뷰포트를 알려 주는 API 가 없다). 박스 모델
    // 좌표가 CSS px 이므로 여기서도 css* 쪽을 읽어 단위를 맞춘다.
    const metrics = (await send('Page.getLayoutMetrics')) as unknown as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number }
      layoutViewport?: { clientWidth: number; clientHeight: number }
    }
    const view = metrics.cssLayoutViewport ?? metrics.layoutViewport
    if (!view) return undefined
    const rect = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(width, view.clientWidth - Math.max(0, x)),
      height: Math.min(height, view.clientHeight - Math.max(0, y))
    }
    if (rect.width <= 0 || rect.height <= 0) return undefined

    let image = await guest.capturePage(rect)
    if (image.isEmpty()) return undefined
    if (image.getSize().width > MAX_CROP_WIDTH) image = image.resize({ width: MAX_CROP_WIDTH })
    return image.toPNG().toString('base64')
  } catch (err) {
    // 크롭은 있으면 좋은 것이다 — 실패해도 HTML·CSS 는 그대로 보낸다.
    log.error('preview: element crop failed', err)
    return undefined
  }
}

function clamp(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}
