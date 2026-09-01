import { join } from 'node:path'
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage } from 'electron'
import { workspaceDisplayName } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'
import { busyWorkCount } from './busyWork'
import { isInstallingUpdate } from './updater'

/**
 * ⌘Q 를 눌러도 돌던 일이 있으면 창만 닫고 메뉴 막대(Tray)에서 계속 굴린다.
 *
 * **왜 별도의 `before-quit` 리스너가 아닌가.** Electron 은 누가 `preventDefault()` 를 부르든
 * **모든** `before-quit` 리스너를 실행한다. 지금 리스너는 둘이고(index.ts 의 teardown,
 * ipc.ts 의 리뷰 워크트리 정리) 둘 다 "이제 앱은 사라진다" 를 전제로 세션을 내리고, 도구
 * 소켓을 지우고, 대기 중인 승인을 거부로 확정하고, 살아 있어야 할 리뷰의 워크트리를 지운다.
 * 즉 여기서 종료를 막아도 지키려던 일은 이미 죽어 있다. 그래서 가드는 리스너가 아니라
 * **두 리스너가 함께 물어보는 공용 판정**이어야 한다 — 각자 맨 앞에서 early-return 한다.
 *
 * **mac 한정이다.** darwin 이 아니면 `shouldStayAlive()` 가 언제나 false 를 돌려준다.
 * 다른 플랫폼에서 마지막 창을 닫으면 `window-all-closed` 가 곧바로 `app.quit()` 을 부르는데,
 * 그 종료를 여기서 막으면 창도 Dock 도 없이 Tray 하나에 앱이 갇힌다 — 그 UX 를 검증하지 않은
 * 채로 열어 둘 이유가 없다. Tray·Dock 숨김·타이틀 배지도 전부 macOS 관용구다.
 *
 * 어느 쪽을 골라도 **일은 잃지 않는다.** "그래도 종료" 는 [[main/shutdownResume]] 의
 * captureRunningTurns 를 그대로 타고, 백그라운드에서 크래시하면 그쪽의 크래시 감지가 받는다.
 */

/** 백그라운드로 도는 동안 "이제 끝났나" 를 확인하는 주기. 업데이터의 예약 폴링과 같은 값. */
const DRAIN_POLL_MS = 5_000

/** 종료 알림을 띄운 뒤 실제로 꺼지기까지의 유예 — 알림이 OS 로 전달될 시간을 준다. */
const QUIT_AFTER_NOTICE_MS = 1_000

interface Deps {
  /** 메뉴 막대에서 "Show Wooi" 를 골랐을 때 메인 창을 되살린다. */
  showWindow: () => void
  /** 지금 살아 있는 메인 창(없으면 null) — 확인 다이얼로그를 붙일 자리. */
  getWindow: () => BrowserWindow | null
  /** 설정을 바꿨을 때 렌더러가 따라오게 한다. */
  broadcastState: () => void
}

let deps: Deps | null = null
let tray: Tray | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 이번 종료를 막았는가. ipc.ts 의 리스너가 같은 dispatch 안에서 동기적으로 읽는다. */
let staying = false
/**
 * 사용자가 Tray 에서 종료를 골랐거나, 일이 다 끝나 우리가 스스로 끄는 중이다.
 * 이 표식이 없으면 그 `app.quit()` 을 이 가드가 다시 막아 앱이 영원히 안 꺼진다.
 */
let quitting = false

export function initBackgroundMode(next: Deps): void {
  deps = next
}

/**
 * 지금 들어온 종료 요청을 막아야 하는가.
 *
 * `isInstallingUpdate()` 를 **가장 먼저** 본다. macOS 네이티브 `quitAndInstall` 은 창을 모두
 * 닫은 **뒤에** `before-quit` 을 쏘므로, 그 종료는 막는 게 아니라 애초에 판정에 들어오지
 * 않아야 한다 — 막으면 창은 이미 사라졌는데 앱만 남고, 예약(`restartWhenIdle`)은 그 시점에
 * 이미 꺼져 있어 재시도도 없다.
 */
export function shouldStayAlive(): boolean {
  if (quitting) return false
  if (isInstallingUpdate()) return false
  if (process.platform !== 'darwin') return false
  if (!getStore().getState().settings.keepWorkingInBackground) return false
  return busyWorkCount() > 0
}

export function isStayingAlive(): boolean {
  return staying
}

/**
 * 종료를 막고 백그라운드로 넘어간다.
 *
 * 확인은 **비동기**로 묻는다(`showMessageBox`). 동기 버전은 체크박스 결과를 돌려주지 않아
 * "다시 묻지 않기" 를 기억할 수 없기 때문이다. `before-quit` 은 이미 preventDefault 된 뒤라
 * 답을 기다리는 동안 앱은 그대로 살아 있고, 사용자가 "그래도 종료" 를 고르면 그때 다시
 * `app.quit()` 을 부른다 — 그 두 번째 종료는 `quitting` 표식 덕에 이 가드를 그냥 통과한다.
 */
export function enterBackground(): void {
  if (staying) return
  staying = true
  const settings = getStore().getState().settings
  if (settings.confirmSkips?.keepWorkingInBackground) {
    goBackground()
    return
  }
  void askAndSettle()
}

/** Tray 를 걷고 Dock 을 되돌린다. 종료 직전과 "그래도 종료" 양쪽에서 부른다. */
export function leaveBackground(): void {
  staying = false
  stopPoll()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.dock?.show()
}

/**
 * 남은 일이 있는지 다시 세고, 없으면 **진짜로** 종료한다.
 *
 * 진짜 종료여야 하는 이유가 하나 더 있다 — `autoUpdater.autoInstallOnAppQuit`([[main/updater]])이
 * 받아 둔 업데이트를 설치하는 유일한 시점이 앱 종료다. 백그라운드로 며칠씩 떠 있으면 그동안
 * 업데이트는 영영 깔리지 않는다.
 */
export function noteWorkDrained(): void {
  if (!staying) return
  const busy = busyWorkCount()
  refreshTray(busy)
  if (busy > 0) return
  log.info('backgroundMode: all work finished — quitting')
  notifyDrained()
  quitNow(QUIT_AFTER_NOTICE_MS)
}

async function askAndSettle(): Promise<void> {
  const busy = busyWorkCount()
  const window = liveWindow()
  const options = {
    type: 'question' as const,
    buttons: ['Keep Working in the Background', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Wooi is still working',
    message: busy === 1 ? '1 task is still running.' : `${busy} tasks are still running.`,
    detail:
      'Wooi can close its window and keep them running from the menu bar, then quit on its own when everything finishes. Either way nothing is lost — unfinished turns are picked up the next time Wooi opens.',
    checkboxLabel: 'Don’t ask again',
    checkboxChecked: false
  }

  let response = 0
  let checkboxChecked = false
  try {
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    response = result.response
    checkboxChecked = result.checkboxChecked
  } catch (err) {
    // 물어볼 수 없으면 지키는 쪽을 고른다 — 잘못 종료해서 턴을 끊는 것보다 낫다.
    log.error('backgroundMode: failed to ask about quitting', err)
  }

  const keep = response === 0
  if (checkboxChecked) rememberChoice(keep)
  if (keep) {
    goBackground()
    return
  }
  // 종료를 고른 사용자에게는 사라지는 것 말고 아무 일도 일어나지 않아야 한다.
  staying = false
  quitNow(0)
}

/**
 * "다시 묻지 않기" 의 기억.
 *
 * "그래도 종료" 는 `keepWorkingInBackground` 자체를 끈다 — 그러면 `shouldStayAlive()` 가
 * 언제나 false 라 확인도 백그라운드도 다시 오지 않고, 설정 화면에서 되돌릴 수 있다.
 * "계속" 은 그 설정을 켠 채로 **확인만** 건너뛰어야 하므로 레포에 이미 있는 확인 생략
 * 레지스트리(`confirmSkips`)에 적는다 — 다른 확인들과 같은 자리에서 되돌릴 수 있다.
 */
function rememberChoice(keep: boolean): void {
  getStore().update((state) => {
    if (keep)
      state.settings.confirmSkips = {
        ...state.settings.confirmSkips,
        keepWorkingInBackground: true
      }
    else state.settings.keepWorkingInBackground = false
  })
  deps?.broadcastState()
}

/** 창을 닫고 Dock 을 감춘 뒤 Tray 로 넘어간다. */
function goBackground(): void {
  log.info(`backgroundMode: staying alive for ${busyWorkCount()} running task(s)`)
  ensureTray()
  refreshTray(busyWorkCount())
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close()
  }
  app.dock?.hide()
  startPoll()
}

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(noteWorkDrained, DRAIN_POLL_MS)
  pollTimer.unref?.()
}

function stopPoll(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function quitNow(delayMs: number): void {
  quitting = true
  leaveBackground()
  if (delayMs <= 0) {
    app.quit()
    return
  }
  const timer = setTimeout(() => app.quit(), delayMs)
  timer.unref?.()
}

function liveWindow(): BrowserWindow | null {
  const win = deps?.getWindow() ?? null
  return win && !win.isDestroyed() ? win : null
}

function ensureTray(): void {
  if (tray) return
  try {
    const icon = nativeImage.createFromPath(trayIconPath())
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('Wooi')
  } catch (err) {
    // Tray 가 없어도 앱은 계속 돈다 — 다만 사용자가 되돌아올 통로가 알림뿐이므로 남겨 둔다.
    log.error('backgroundMode: failed to create the tray icon', err)
  }
}

/**
 * Tray 의 타이틀과 메뉴를 지금 상태로 다시 그린다.
 *
 * 타이틀에 개수를 붙이는 것은 장식이 아니라 **Dock 배지의 대체품**이다 — 배지는 렌더러가
 * 세어 `IPC.appSetBadge` 로 밀어 주는 값이라(store.ts 의 refreshBadge), 창이 사라지면 마지막
 * 값에 그대로 얼어붙는다. 창이 없는 동안 진행 상황을 말할 수 있는 곳은 여기뿐이다.
 */
function refreshTray(busy: number): void {
  if (!tray) return
  const running = getStore()
    .getState()
    .workspaces.filter((w) => !w.archived && w.status === 'running')
  tray.setTitle(busy > 0 ? String(busy) : '')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Wooi', click: () => revealWindow() },
      { type: 'separator' },
      ...(running.length
        ? running.map((ws) => ({ label: workspaceDisplayName(ws), enabled: false }))
        : [{ label: 'Finishing up…', enabled: false }]),
      { type: 'separator' },
      { label: 'Quit Wooi', click: () => quitNow(0) }
    ])
  )
}

/**
 * 창을 되살린다. 메뉴 막대의 "Show Wooi" 와 창이 없을 때의 알림 클릭이 같은 문을 쓴다.
 *
 * 되살리면 백그라운드 모드에서 **나온다.** 사용자가 돌아왔는데도 모드를 유지하면, 그 사람이
 * 창을 보며 다음 지시를 쓰는 동안 마지막 턴이 끝나는 순간 앱이 스스로 꺼진다. 돌아온 이상
 * 다시 평범한 앱이고, 다음 ⌘Q 는 처음처럼 다시 묻는다.
 */
export function revealWindow(): void {
  leaveBackground()
  const win = liveWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  deps?.showWindow()
}

function notifyDrained(): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({
      title: 'Wooi',
      body: 'All work finished. Wooi has quit.'
    }).show()
  } catch (err) {
    log.warn('backgroundMode: failed to show the finished notification', err)
  }
}

/**
 * 메뉴 막대용 템플릿 아이콘의 경로.
 *
 * `build/trayTemplate.png` 는 `package.json` 의 `build.files` 로 asar 안에 함께 들어간다 —
 * 이름이 `…Template` 으로 끝나야 macOS 가 알파만 읽어 밝은/어두운 메뉴 막대에 맞춰 칠한다.
 * dev 에서는 `app.getAppPath()` 가 레포 루트라 같은 상대 경로가 그대로 맞는다.
 */
function trayIconPath(): string {
  return join(app.getAppPath(), 'build', 'trayTemplate.png')
}
