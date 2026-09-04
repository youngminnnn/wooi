import { BrowserWindow, Notification, powerMonitor } from 'electron'
import {
  IPC,
  notificationSkipReason,
  workspaceDisplayName,
  type NotificationEvent,
  type NotificationSkip,
  type NotificationSkipReason,
  type Workspace
} from '@shared/types'
import { getStore } from './store'
import { log } from './logger'
import { notifyRemotePush } from './remote'
import { shouldSendRemotePush, type RemotePushKind } from './remote/push'

/**
 * 데스크톱 알림 한 건의 판정·전달. Claude 와 Codex 매니저가 **같은 것**을 쓴다 — 두 매니저의
 * notify() 는 주석을 빼면 글자까지 같았고, 사유 코드를 양쪽에 따로 붙이면 그 순간부터 갈라진다.
 *
 * 알림은 조건이 여러 겹이라(음소거 · 채널 · 포커스 · OS 권한) 안 울렸을 때 어디서 막혔는지
 * 결과만 보고는 알 수 없다. 그래서 모든 경로가 사유 코드를 남긴다.
 */

/** 렌더러가 마지막으로 알려 준, 지금 화면에 떠 있는 워크스페이스. 모르면 null. */
let viewingWorkspaceId: string | null = null

/**
 * 창이 하나도 없을 때 메인 창을 되살리는 방법. 등록되지 않았으면 알림 클릭이 아무 일도 하지
 * 않던 예전 동작 그대로다.
 *
 * 매니저를 거쳐 주입하지 않고 모듈 상태로 두는 것은 바로 위 `viewingWorkspaceId` 와 같은
 * 이유다 — 이 값은 앱에 하나뿐이고, 알림을 띄우는 두 매니저가 각자 다른 창을 열 일이 없다.
 */
let openWindow: (() => void) | null = null

export function setWindowOpener(open: () => void): void {
  openWindow = open
}

/** 마지막으로 건너뛴 알림 1건. 설정 화면이 읽는 진단값이라 디스크에 남기지 않는다. */
let lastSkip: NotificationSkip | null = null

/**
 * 띄우라고 한 알림이 실제로 화면에 떴는지 기다리는 시간.
 *
 * macOS 는 권한이 거부됐거나 집중 모드면 알림을 **조용히** 삼킨다 — Electron 은 오류 없이
 * 반환하고 'failed' 도 오지 않으므로, 'show' 가 제때 안 오는 것으로만 잡아낼 수 있다.
 * 정상 표시는 즉시 오므로 이 값은 넉넉해도 오탐을 만들지 않는다.
 */
const SHOWN_CONFIRM_MS = 2000

export function setViewingWorkspace(workspaceId: string | null): void {
  viewingWorkspaceId = workspaceId
}

export function lastNotificationSkip(): NotificationSkip | null {
  return lastSkip
}

function recordSkip(
  reason: NotificationSkipReason,
  event: NotificationEvent,
  workspaceName: string
): void {
  lastSkip = { reason, event, workspaceName, at: Date.now() }
  log.warn(`notify: skipped ${event} for "${workspaceName}" — ${reason}`)
}

export interface DesktopNotification {
  workspaceId: string
  event: NotificationEvent
  body: string
  /** 제목에 경고 표시를 붙인다(에러·중단처럼 눈에 먼저 걸려야 하는 것). */
  urgent: boolean
  /**
   * 폰 배너의 종류. 기본은 설정 이벤트와 같지만 갈릴 수 있다 — 질문은 설정에서는 'needsInput'
   * 채널을 따르면서도 배너에서는 승인과 다른 말을 해야 한다([[remote/push]]).
   */
  pushKind?: RemotePushKind
}

export interface NotificationDeps {
  /** 파괴된 창이 돌아올 수 있다 — 반드시 liveWindow() 를 거쳐 쓴다. */
  getWindow: () => BrowserWindow | null
  getWorkspace: (workspaceId: string) => Workspace | undefined
  dispatch: (channel: string, payload: unknown) => void
}

/**
 * OS 알림을 띄운다. 클릭하면 창을 포커스하고 해당 workspace 를 연다.
 *
 * 폰 푸시는 이 판정과 **별개**다 — 데스크톱이 눌린 이유(지금 그 워크스페이스를 보고 있다)가
 * 곧 폰을 깨우지 않을 이유이기도 해서 한 조건으로 합치고 싶어지지만, 폰 쪽은 "자리를 비웠는가"
 * 라는 다른 질문에 답한다(입력 유휴 시간까지 본다). 그래서 순서만 지키고 서로를 게이팅하지 않는다.
 */
export function showDesktopNotification(
  notification: DesktopNotification,
  deps: NotificationDeps
): void {
  const { workspaceId, event, body, urgent } = notification
  const win = liveWindow(deps)
  const ws = deps.getWorkspace(workspaceId)
  const name = ws ? workspaceDisplayName(ws) : 'Workspace'
  const settings = getStore().getState().settings
  const channels = settings.notifications?.[event]

  // 폰 푸시는 데스크톱 판정보다 먼저 정한다. 데스크톱이 눌려도 폰은 울려야 하는 조합이 있다.
  // 포커스는 메인 창이 아니라 Wooi 창 전체로 본다 — 분리한 패널도 데스크톱을 쓰는 중이다.
  if (
    !ws?.muted &&
    channels?.osNotification &&
    shouldSendRemotePush({
      appFocused: BrowserWindow.getFocusedWindow() !== null,
      idleSeconds: powerMonitor.getSystemIdleTime(),
      always: settings.remotePushWhileActive === true
    })
  ) {
    notifyRemotePush(workspaceId, name, notification.pushKind ?? event)
  }

  const reason = notificationSkipReason({
    muted: ws?.muted === true,
    channelOn: channels?.osNotification === true,
    appFocused: win?.isFocused() === true,
    viewingWorkspaceId,
    workspaceId,
    // 이 설정이 없던 파일에서 올라오면 예전 동작(억제)을 그대로 잇는다.
    suppressWhenFocused: settings.suppressWhenFocused !== false,
    supported: Notification.isSupported()
  })
  if (reason) {
    recordSkip(reason, event, name)
    return
  }

  const title = ws ? `${urgent ? '⚠️ ' : ''}${name}` : 'Wooi'
  // OS 알림 소리는 이벤트별 sound 채널을 따른다(설정에서 sound 를 끄면 무음 알림).
  const osNotification = new Notification({ title, body, silent: !channels?.sound })

  // 표시 확인. 'show' 가 오면 성공이고, 오지 않으면 macOS 가 삼킨 것으로 본다.
  let shown = false
  const confirm = setTimeout(() => {
    if (!shown) recordSkip('blocked-by-system', event, name)
  }, SHOWN_CONFIRM_MS)
  // 타이머가 앱 종료를 붙잡지 않게 한다 — 진단값 하나 때문에 quit 가 늦어질 이유가 없다.
  confirm.unref?.()
  osNotification.on('show', () => {
    shown = true
    clearTimeout(confirm)
  })
  osNotification.on('failed', (_event, error) => {
    shown = true
    clearTimeout(confirm)
    recordSkip('blocked-by-system', event, name)
    log.warn(`notify: OS rejected the notification for "${name}"`, error)
  })

  osNotification.on('click', () => {
    const w = liveWindow(deps)
    if (w) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    } else {
      // 창이 없는 동안(백그라운드 모드) 온 알림이다 — 되살려야 클릭이 의미를 갖는다.
      // 아래 방송은 새 창의 렌더러가 준비되면서 다시 상태를 읽으므로 순서를 바꿀 필요는 없다.
      openWindow?.()
    }
    deps.dispatch(IPC.evtSelectWorkspace, workspaceId)
  })
  osNotification.show()
}

/**
 * 살아 있는 메인 창(없거나 이미 파괴됐으면 null).
 *
 * `getWindow()` 는 **파괴된** BrowserWindow 를 돌려줄 수 있고, 그 객체에 무엇을 물어보든
 * `Object has been destroyed` 로 던진다 — `?.` 로는 막히지 않는다(null 이 아니기 때문이다).
 * 여기서 던지면 호출부인 onPermissionRequest 가 승인 요청을 방송하기 **전에** 끊겨,
 * 렌더러에도 폰에도 카드가 뜨지 않고 호스트는 아무도 답하지 않을 프로미스에 매달린다.
 * ipc.ts·updater.ts 가 쓰는 것과 같은 방어다.
 */
function liveWindow(deps: NotificationDeps): BrowserWindow | null {
  const win = deps.getWindow()
  return win && !win.isDestroyed() ? win : null
}
