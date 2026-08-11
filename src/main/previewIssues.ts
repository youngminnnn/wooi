import { session } from 'electron'
import type { WebContents } from 'electron'
import { IPC, PREVIEW_PARTITION } from '@shared/types'
import { addIssue, countIssues, type PreviewIssue } from '@shared/previewIssues'
import { log } from './logger'

type Dispatch = (channel: string, payload: unknown) => void

/**
 * Preview 가 띄운 페이지의 콘솔 에러와 실패한 요청을 모은다.
 *
 * **CDP 를 쓰지 않는다.** 요소 픽커([[previewPicker]])가 debugger 를 쓰는데, `debugger.attach` 는
 * webContents 당 하나뿐이라 여기서도 붙잡고 있으면 둘이 서로를 끊는다. 게다가 이건 Preview 가
 * 열려 있는 내내 돌아야 하므로, 붙여 두는 동안 사용자가 게스트의 DevTools 를 영영 못 열게 된다.
 * 콘솔은 `console-message` 이벤트로, 네트워크는 세션의 webRequest 로 충분히 얻어진다 —
 * 스택 트레이스는 못 얻지만 `파일:줄` 은 나오고, 그 대가로 픽커·DevTools 와 공존한다.
 *
 * 렌더러로는 **개수만** 흘린다. 매 콘솔 줄을 IPC 로 밀면 스크립트 출력에서 겪은 것과 같은 일이
 * 벌어진다 — 폭주하는 로그가 메시지 홍수가 되어 메인 힙을 밀어 올린다([[scripts]] 의 코얼레싱).
 * 목록 자체는 사용자가 패널을 열 때 한 번 가져간다.
 */

/** 워크스페이스당 보관할 문제의 최대 개수. 넘으면 오래된 것부터 버린다. */
const LIMIT = 200

/** 개수 방송을 모아 보내는 주기(ms). 렌더 폭풍을 막는 최소한의 간격. */
const NOTIFY_INTERVAL_MS = 400

/** 이 리소스 종류의 실패는 세지 않는다 — 페이지 동작과 무관하게 늘 실패하는 것들이다. */
const IGNORED_RESOURCES = new Set(['ping', 'cspReport'])

/**
 * 사용자가 취소했거나 우리가 이동시킨 요청. 실패로 보여 주면 "새로고침할 때마다 에러가 뜬다" 가
 * 된다 — 개발자가 고칠 것이 아무것도 없는 에러다.
 */
const IGNORED_NET_ERRORS = new Set(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'])

export class PreviewIssueCollector {
  /** 워크스페이스별 문제 목록. */
  private issues = new Map<string, PreviewIssue[]>()
  /** 게스트 webContents id → 워크스페이스. webRequest 는 이걸로 요청의 주인을 찾는다. */
  private owner = new Map<number, string>()
  /** 게스트별로 걸어 둔 정리 함수(리스너 해제). */
  private cleanups = new Map<number, () => void>()
  /** 방송이 예약된 워크스페이스(모아 보내기). */
  private pending = new Set<string>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private dispatch: Dispatch) {}

  /**
   * 세션 단위 배선(앱 기동 시 1회). 네트워크 실패는 webContents 가 아니라 **세션**에서 오므로,
   * Preview 파티션에 한 번만 걸고 요청의 webContentsId 로 주인을 되찾는다.
   */
  initSession(): void {
    const wr = session.fromPartition(PREVIEW_PARTITION).webRequest

    wr.onErrorOccurred((details) => {
      if (IGNORED_RESOURCES.has(details.resourceType)) return
      if (IGNORED_NET_ERRORS.has(details.error)) return
      const workspaceId = details.webContentsId && this.owner.get(details.webContentsId)
      if (!workspaceId) return
      this.add(workspaceId, {
        kind: 'network',
        level: 'error',
        text: `${details.error} ${details.method} ${short(details.url)}`,
        source: details.url,
        ts: Date.now()
      })
    })

    wr.onCompleted((details) => {
      if (details.statusCode < 400) return
      if (IGNORED_RESOURCES.has(details.resourceType)) return
      const workspaceId = details.webContentsId && this.owner.get(details.webContentsId)
      if (!workspaceId) return
      this.add(workspaceId, {
        kind: 'network',
        // 4xx 는 앱이 잘못 부른 것일 수도, 정상 흐름(401 로 로그인 유도)일 수도 있다 — 경고로,
        // 5xx 는 서버가 터진 것이므로 에러로 본다.
        level: details.statusCode >= 500 ? 'error' : 'warning',
        text: `${details.statusCode} ${details.method} ${short(details.url)}`,
        source: details.url,
        ts: Date.now()
      })
    })
  }

  /**
   * 이 게스트가 어느 워크스페이스의 것인지 알려 주고 콘솔 수집을 시작한다.
   * 렌더러가 dom-ready 에서 부른다 — 실제 페이지가 로드되기 전이라 첫 줄부터 놓치지 않는다.
   */
  watch(workspaceId: string, guest: WebContents): void {
    const id = guest.id
    this.unwatch(id)
    this.owner.set(id, workspaceId)

    // 메시지 필드는 **첫 인자**(이벤트 객체)에 실려 온다 — 옛 시그니처의 (event, level, …) 가
    // 아니다. 두 번째 인자를 읽으면 조용히 아무것도 안 잡힌다(그렇게 한 번 틀렸다).
    const onConsole = (e: ConsoleParams): void => {
      if (e.level !== 'error' && e.level !== 'warning') return
      // Electron 이 게스트에 직접 찍는 경고는 사용자의 앱 코드가 아니다. 특히 dev 에서는
      // "이 페이지에 CSP 가 없다" 경고가 **매 페이지마다** 뜨는데, 그건 우리가 Preview 파티션에
      // 일부러 CSP 를 씌우지 않아서다([[main/preview]]) — 개발자가 고칠 것이 아무것도 없다.
      if (e.sourceId?.startsWith('node:electron/')) return
      this.add(workspaceId, {
        kind: 'console',
        level: e.level,
        text: e.message,
        source: e.sourceId ? `${short(e.sourceId)}:${e.lineNumber}` : undefined,
        ts: Date.now()
      })
    }

    // 새 페이지로 가면 이전 페이지의 문제는 접어 둔다 — 안 지우면 "고쳤는데도 그대로다" 로 보인다.
    // 같은 페이지 안의 라우팅(did-navigate-in-page)은 새 페이지가 아니므로 그대로 둔다.
    const onNavigate = (): void => this.clear(workspaceId)
    const onDestroyed = (): void => this.unwatch(id)

    guest.on('console-message', onConsole as never)
    guest.on('did-navigate', onNavigate)
    guest.once('destroyed', onDestroyed)

    this.cleanups.set(id, () => {
      // 게스트가 이미 죽었으면 리스너 해제도 던질 수 있다 — 정리가 흐름을 끊지 않게 감싼다.
      try {
        guest.removeListener('console-message', onConsole as never)
        guest.removeListener('did-navigate', onNavigate)
        guest.removeListener('destroyed', onDestroyed)
      } catch (err) {
        log.error('preview: issue listener cleanup failed', err)
      }
    })
  }

  /** 이 게스트의 수집을 멈춘다(Preview 패널이 사라졌거나 게스트가 죽었을 때). */
  unwatch(webContentsId: number): void {
    this.cleanups.get(webContentsId)?.()
    this.cleanups.delete(webContentsId)
    this.owner.delete(webContentsId)
  }

  list(workspaceId: string): PreviewIssue[] {
    return this.issues.get(workspaceId) ?? []
  }

  clear(workspaceId: string): void {
    if (!this.issues.has(workspaceId)) return
    this.issues.delete(workspaceId)
    this.scheduleNotify(workspaceId)
  }

  /** 워크스페이스가 사라질 때 매달린 것을 모두 버린다. */
  disposeWorkspace(workspaceId: string): void {
    this.issues.delete(workspaceId)
    for (const [id, owner] of [...this.owner]) if (owner === workspaceId) this.unwatch(id)
  }

  private add(workspaceId: string, incoming: Omit<PreviewIssue, 'id' | 'count'>): void {
    this.issues.set(workspaceId, addIssue(this.list(workspaceId), incoming, LIMIT))
    this.scheduleNotify(workspaceId)
  }

  /** 개수 방송을 예약한다. 이미 예약돼 있으면 거기에 묻어 간다. */
  private scheduleNotify(workspaceId: string): void {
    this.pending.add(workspaceId)
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      const ids = [...this.pending]
      this.pending.clear()
      for (const id of ids) {
        this.dispatch(IPC.evtPreviewIssues, { workspaceId: id, ...countIssues(this.list(id)) })
      }
    }, NOTIFY_INTERVAL_MS)
  }
}

interface ConsoleParams {
  message: string
  level: 'info' | 'warning' | 'error' | 'debug'
  lineNumber: number
  sourceId: string
}

/** 긴 URL 은 목록에서 한 줄을 통째로 잡아먹는다 — 가운데를 접는다. */
function short(url: string, max = 120): string {
  if (url.length <= max) return url
  return `${url.slice(0, max - 30)}…${url.slice(-25)}`
}
