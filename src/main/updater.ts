import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, RESTART_SETTLE_MS, type UpdateStatus } from '@shared/types'
import { log } from './logger'
import { getStore } from './store'

const { autoUpdater } = electronUpdater

/**
 * 자동 업데이트(electron-updater + GitHub Releases).
 *
 * - 패키징된 빌드에서만 동작한다. dev/미패키지에서는 IPC 만 등록하고 실제 확인은 no-op.
 * - 확인 시점: 실행 직후 1회 + 2시간마다 + "다시 앱을 보는 순간"(창 포커스 / 절전 복귀).
 *   setInterval 은 맥이 잠들면 밀리므로 이벤트 트리거로 빈 구간을 메운다(최소 30분 간격 스로틀).
 * - 새 버전은 백그라운드로 자동 다운로드하고, 준비되면 renderer 로 방송(배너) + 창이 비활성이면
 *   OS 알림까지 띄운다. 재시작 시점은 사용자가 결정한다(quitAndInstall).
 * - 지금 재시작하는 대신 **"모든 워크스페이스 작업이 끝나면" 예약**할 수도 있다(updateSetRestartWhenIdle).
 *   예약이 걸리면 진행 중인 턴/리뷰를 폴링하다가, 전부 끝나고 잠잠해지면 스스로 재시작한다.
 * - 읽기 전용 위치(DMG/App Translocation)라 스스로 설치할 수 없을 때도 확인은 계속한다.
 *   다운로드만 끄고 "새 버전이 나왔다"는 사실은 알려, 수동 내려받기로 이어지게 한다.
 * - macOS 자동 업데이트는 서명·공증된 앱 + `latest-mac.yml`/zip 이 릴리스에 있어야 한다.
 */

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000 // 2h — 주기 확인
const MIN_CHECK_GAP_MS = 30 * 60 * 1000 // 30m — 이벤트 트리거 스로틀(포커스마다 때리지 않게)
const RENOTIFY_MS = 24 * 60 * 60 * 1000 // 24h — 같은 릴리스 OS 알림 재알림 간격
const FIRST_CHECK_DELAY_MS = 8_000 // 창이 뜬 뒤로 미뤄 초기 로딩과 경쟁하지 않게
const RESUME_CHECK_DELAY_MS = 15_000 // 절전 복귀 직후엔 네트워크가 아직 안 붙어 있을 수 있다
/** 예약 재시작이 걸려 있을 때 "작업이 남았는지" 확인하는 주기. */
const IDLE_POLL_MS = 5_000

/** 렌더러로 마지막에 방송한 상태(예약 정보까지 합친 값). */
let lastStatus: UpdateStatus = { state: 'idle' }
/** 예약 정보를 뺀 순수 업데이트 진행 상태 — autoUpdater 이벤트가 쓰는 쪽. */
let baseStatus: UpdateStatus = { state: 'idle' }
/** "작업이 끝나면 재시작" 예약 여부. 앱을 다시 띄우면 초기화된다(휘발성). */
let restartWhenIdle = false
/** 카운트다운 만료 시각(epoch ms). null 이면 아직 기다리는 중이거나 예약이 없다. */
let restartAt: number | null = null
/** 예약이 기다리는 진행 중 작업 수 — 배너 문구용. */
let busyCount = 0
let idleTimer: ReturnType<typeof setInterval> | null = null
/** 마지막으로 확인을 "시작"한 시각 — 이벤트 트리거 스로틀 기준. */
let lastCheckAt = 0
/** 마지막으로 OS 알림을 띄운 대상(`상태:버전`)과 시각 — 같은 릴리스로 도배하지 않기 위한 기록. */
let notifiedKey: string | null = null
let notifiedAt = 0

/**
 * macOS 에서 앱이 "쓸 수 없는 위치"에 있으면 Squirrel 이 업데이트를 설치할 수 없다.
 * 대표적인 두 경우:
 *  - DMG 안의 앱을 그대로 실행 → 마운트된 볼륨은 읽기 전용(`/Volumes/...`).
 *  - 격리(quarantine) 속성이 붙은 앱을 Finder 로 옮기지 않고 실행 → macOS 가
 *    임시 읽기 전용 사본에서 띄운다(App Translocation, `/private/var/.../AppTranslocation/...`).
 * 이때 설치 단계가 "Cannot update while running on a read-only volume" 로 실패하는데,
 * 원문 에러는 원인을 알기 어려우니 미리 감지해 해결 방법을 담은 메시지를 돌려준다.
 *
 * @returns 업데이트가 불가능한 이유(사용자용 안내). 정상 위치면 null.
 */
function readOnlyInstallReason(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null
  const exe = app.getPath('exe') // …/Wooi.app/Contents/MacOS/Wooi
  if (exe.includes('/AppTranslocation/')) {
    return 'Wooi is running from a temporary read-only copy (macOS App Translocation), so it can’t update itself. Quit Wooi, drag Wooi.app into your Applications folder with Finder, then open it from there.'
  }
  if (exe.startsWith('/Volumes/')) {
    return 'Wooi is running straight from the disk image, which is read-only. Quit Wooi, drag Wooi.app into your Applications folder, eject the disk image, then open it from Applications.'
  }
  // Wooi.app 번들 루트가 쓰기 가능한지 확인(읽기 전용 마운트/권한 등).
  const bundle = path.resolve(exe, '..', '..', '..')
  try {
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return `Wooi can’t update itself because its install location is read-only (${bundle}). Move Wooi.app to your Applications folder and open it from there.`
  }
  return null
}

/**
 * 지금 "끝나기를 기다려야 하는" 작업 수 — 예약 재시작의 발동 조건.
 *
 * 세는 것: 진행 중인 에이전트 턴(workspace.status === 'running')과 진행 중인 PR 리뷰.
 * 세지 않는 것: 스크립트(dev 서버)와 터미널. 사용자가 직접 띄운 장기 실행 프로세스라
 * 끝날 일이 없고, 이것까지 기다리면 예약이 영원히 발동하지 않는다.
 */
function busyWorkCount(): number {
  const state = getStore().getState()
  const turns = state.workspaces.filter((w) => !w.archived && w.status === 'running').length
  const reviews = state.reviews.filter(
    (r) => r.status === 'running' || r.status === 'preparing'
  ).length
  return turns + reviews
}

/** 살아 있는 메인 창(없으면 undefined). */
function liveWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
}

/**
 * 새 버전을 OS 알림으로 알린다 — 배너는 앱을 보고 있어야만 눈에 들어오므로,
 * 앱 밖에 있는 사용자에게 릴리스를 알리는 유일한 통로다.
 *
 * 규칙:
 *  - `상태:버전` 이 같으면 24시간에 한 번까지만(무시한 채 며칠씩 켜 두는 경우의 리마인드).
 *  - 창을 보고 있으면 띄우지 않는다. 배너로 충분하고, 알림은 방해가 된다.
 *    (이때도 "알렸다"고 기록해 두어, 창을 벗어나자마자 튀어나오지 않게 한다.)
 */
function notifyNewVersion(status: UpdateStatus): void {
  if (!status.version || !Notification.isSupported()) return

  const key = `${status.state}:${status.version}`
  const now = Date.now()
  if (notifiedKey === key && now - notifiedAt < RENOTIFY_MS) return
  notifiedKey = key
  notifiedAt = now

  const win = liveWindow()
  if (win?.isFocused()) return

  const body =
    status.state === 'ready'
      ? `Version ${status.version} is downloaded. Restart Wooi to finish updating.`
      : `Version ${status.version} is available. Open Wooi to get it.`

  const notification = new Notification({ title: 'Wooi update', body })
  notification.on('click', () => {
    const w = liveWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  notification.show()
}

export function initUpdater(dispatch: (channel: string, payload: unknown) => void): void {
  /** 진행 상태 + 예약 정보를 합쳐 렌더러로 방송한다. */
  const publish = (): void => {
    lastStatus = {
      ...baseStatus,
      ...(restartWhenIdle ? { restartWhenIdle: true, busyCount } : {}),
      ...(restartAt !== null ? { restartAt } : {})
    }
    dispatch(IPC.evtUpdate, lastStatus)
  }

  const emit = (status: UpdateStatus): void => {
    baseStatus = status
    publish()
  }

  const stopIdleWatch = (): void => {
    if (!idleTimer) return
    clearInterval(idleTimer)
    idleTimer = null
  }

  /**
   * 예약이 걸린 동안 주기적으로 도는 판정. 남은 작업이 없으면 카운트다운을 시작하고,
   * 그 사이에 새 작업이 시작되면 카운트다운을 되돌린다(다시 잠잠해질 때까지 기다린다).
   */
  const evaluateIdleRestart = (): void => {
    if (!restartWhenIdle) return

    const busy = busyWorkCount()
    // 아직 받는 중이면 기다린다 — 예약은 유지하고 ready 가 되는 순간부터 카운트다운을 잰다.
    const blocked = baseStatus.state !== 'ready' || busy > 0
    const changed = busy !== busyCount || (blocked && restartAt !== null)
    busyCount = busy
    if (blocked) {
      restartAt = null
      if (changed) publish()
      return
    }

    // 곧바로 끄지 않고 유예를 둔다 — 턴과 턴 사이의 짧은 공백(에이전트가 답을 마치고 사용자가
    // 후속을 입력하는 구간)에 앱이 사라지지 않게 하는 완충이자, 배너에서 취소할 수 있는 창이다.
    if (restartAt === null) {
      restartAt = Date.now() + RESTART_SETTLE_MS
      log.info(`updater: all work finished — restarting in ${RESTART_SETTLE_MS / 1000}s`)
      publish()
      return
    }
    if (changed) publish()
    if (Date.now() < restartAt) return

    stopIdleWatch()
    restartWhenIdle = false
    log.info('updater: installing scheduled update now')
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  }

  // 설치 위치 판정은 실행 중 바뀌지 않으므로 한 번만 계산해 둔다.
  const blockedReason = app.isPackaged ? readOnlyInstallReason() : null

  /**
   * 실제 확인. 결과는 autoUpdater 이벤트 핸들러가 방송한다.
   * @param reason 로그용 트리거 이름
   * @param force  true 면 최소 간격 스로틀을 무시한다(사용자가 직접 누른 확인).
   */
  const check = async (reason: string, force = false): Promise<void> => {
    if (!app.isPackaged) return
    const now = Date.now()
    if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return
    lastCheckAt = now
    log.info(`updater: checking (${reason})`)
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`updater: check failed — ${message}`)
      // blocked 모드에서는 에러로 상태를 덮지 않는다 — 사용자에게 필요한 안내는 이미 blocked 쪽이다.
      if (!blockedReason) emit({ state: 'error', error: message })
    }
  }

  // 현재 앱 버전 조회(설정 화면 표시용) — 패키징 여부와 무관하게 동작.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  // 마지막 상태 조회 — 렌더러가 새로 뜰 때(초기 로드/리로드) 이미 지나간 방송을 놓치지 않도록.
  ipcMain.handle(IPC.updateGetStatus, (): UpdateStatus => lastStatus)

  // 수동 확인 — 스로틀을 무시하고 즉시 확인한다.
  ipcMain.handle(IPC.updateCheck, async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) {
      emit({ state: 'not-available', version: app.getVersion() })
      return lastStatus
    }
    // blocked 안내를 'checking' 으로 덮으면 원인 설명이 사라진다 — 정상 위치일 때만 표시.
    if (!blockedReason) emit({ state: 'checking' })
    await check('manual', true)
    return lastStatus
  })

  // 다운로드 완료된 업데이트를 설치(앱 재시작).
  ipcMain.handle(IPC.updateQuitAndInstall, () => {
    if (baseStatus.state !== 'ready') return
    stopIdleWatch()
    restartWhenIdle = false
    // isSilent=false(설치 마법사 표시 안 함, mac 은 무의미), forceRunAfter=true(설치 후 재실행)
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  })

  // "작업이 다 끝나면 재시작" 예약을 걸거나 해제한다. 판정은 폴링이므로 예약이 걸려 있는 동안만
  // 타이머가 돌고, 해제하면 곧바로 멈춘다.
  ipcMain.handle(IPC.updateSetRestartWhenIdle, (_e, armed: boolean): UpdateStatus => {
    restartWhenIdle = !!armed && app.isPackaged
    restartAt = null
    busyCount = 0
    if (!restartWhenIdle) {
      stopIdleWatch()
      publish()
      return lastStatus
    }
    log.info('updater: restart scheduled for when all work finishes')
    if (!idleTimer) {
      idleTimer = setInterval(evaluateIdleRestart, IDLE_POLL_MS)
      idleTimer.unref?.()
    }
    publish() // 예약이 걸렸다는 사실을 먼저 반영하고,
    evaluateIdleRestart() // 이미 전부 잠잠하면 여기서 곧바로 카운트다운이 시작된다.
    return lastStatus
  })

  if (!app.isPackaged) {
    log.info('updater: dev/unpackaged — auto-check disabled')
    return
  }

  autoUpdater.logger = {
    info: (m) => log.info(`updater: ${m}`),
    warn: (m) => log.warn(`updater: ${m}`),
    error: (m) => log.error(`updater: ${m}`),
    debug: () => {}
  }

  if (blockedReason) {
    // 설치는 못 해도 "새 버전이 나왔다"는 사실은 알려 줄 수 있다. 다운로드를 끄면
    // checkForUpdates 는 릴리스 메타데이터만 읽고 Squirrel(설치 단계)을 건드리지 않는다.
    log.warn(`updater: install blocked — ${blockedReason}`)
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('update-available', (info) => {
      emit({ state: 'blocked', error: blockedReason, version: info.version })
      notifyNewVersion(lastStatus)
    })
    autoUpdater.on('update-not-available', () => emit({ state: 'blocked', error: blockedReason }))
    // 에러가 나도 blocked 안내를 유지한다(원인·해결책이 담긴 쪽이 더 유용하다).
    autoUpdater.on('error', (err) => log.warn(`updater: check error (blocked) — ${String(err)}`))

    emit({ state: 'blocked', error: blockedReason })
  } else {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      emit({ state: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () =>
      emit({ state: 'not-available', version: app.getVersion() })
    )
    autoUpdater.on('download-progress', (p) =>
      emit({ state: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => {
      emit({ state: 'ready', version: info.version })
      notifyNewVersion(lastStatus)
    })
    autoUpdater.on('error', (err) =>
      emit({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    )
  }

  /**
   * 이미 알고 있는 새 버전을 사용자가 계속 무시하고 있으면 다시 알린다.
   * (실제 재알림 간격 판단은 notifyNewVersion 이 한다 — 여기서는 대상만 고른다.)
   * `downloading` 은 진행 중이니 건드리지 않고, `available` 이 오래 남아 있으면
   * 다운로드가 막힌 것이므로 알림 대상에 포함한다.
   */
  const remind = (): void => {
    const s = lastStatus
    if (s.state === 'ready' || s.state === 'available' || (s.state === 'blocked' && s.version)) {
      notifyNewVersion(s)
    }
  }

  // 시작 직후 1회 + 주기 확인. 오류는 위 error 핸들러/ check 의 catch 가 삼킨다.
  setTimeout(() => void check('startup'), FIRST_CHECK_DELAY_MS).unref?.()
  setInterval(() => {
    remind()
    void check('interval')
  }, CHECK_INTERVAL_MS).unref?.()

  // "다시 앱을 보는 순간"과 절전 복귀 — setInterval 이 잠든 사이 밀린 구간을 메운다.
  // 둘 다 30분 스로틀에 걸리므로 창 전환이 잦아도 네트워크를 때리지 않는다.
  app.on('browser-window-focus', () => void check('window-focus'))
  powerMonitor.on('resume', () => {
    setTimeout(() => void check('power-resume'), RESUME_CHECK_DELAY_MS).unref?.()
  })
}
