import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, type UpdateStatus } from '@shared/types'
import { log } from './logger'

const { autoUpdater } = electronUpdater

/**
 * 자동 업데이트(electron-updater + GitHub Releases).
 *
 * - 패키징된 빌드에서만 동작한다. dev/미패키지에서는 IPC 만 등록하고 실제 확인은 no-op.
 * - 실행 시 한 번, 이후 6시간마다 확인한다. 새 버전은 백그라운드로 자동 다운로드하고,
 *   준비되면 상태만 renderer 로 방송한다(재시작 시점은 사용자가 결정 → quitAndInstall).
 * - macOS 자동 업데이트는 서명·공증된 앱 + `latest-mac.yml`/zip 이 릴리스에 있어야 한다.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

let lastStatus: UpdateStatus = { state: 'idle' }

/**
 * macOS 에서 앱이 "쓸 수 없는 위치"에 있으면 Squirrel 이 업데이트를 설치할 수 없다.
 * 대표적인 두 경우:
 *  - DMG 안의 앱을 그대로 실행 → 마운트된 볼륨은 읽기 전용(`/Volumes/...`).
 *  - 격리(quarantine) 속성이 붙은 앱을 Finder 로 옮기지 않고 실행 → macOS 가
 *    임시 읽기 전용 사본에서 띄운다(App Translocation, `/private/var/.../AppTranslocation/...`).
 * 이때 checkForUpdates 는 "Cannot update while running on a read-only volume" 로 실패하는데,
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

export function initUpdater(dispatch: (channel: string, payload: unknown) => void): void {
  const emit = (status: UpdateStatus): void => {
    lastStatus = status
    dispatch(IPC.evtUpdate, status)
  }

  // 현재 앱 버전 조회(설정 화면 표시용) — 패키징 여부와 무관하게 동작.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  // 수동 확인 — 최신 상태를 즉시 되돌려주고, 확인을 트리거한다.
  ipcMain.handle(IPC.updateCheck, async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) {
      const s: UpdateStatus = { state: 'not-available', version: app.getVersion() }
      emit(s)
      return s
    }
    const blocked = readOnlyInstallReason()
    if (blocked) {
      const s: UpdateStatus = { state: 'blocked', error: blocked }
      emit(s)
      return s
    }
    try {
      emit({ state: 'checking' })
      await autoUpdater.checkForUpdates()
    } catch (err) {
      emit({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return lastStatus
  })

  // 다운로드 완료된 업데이트를 설치(앱 재시작).
  ipcMain.handle(IPC.updateQuitAndInstall, () => {
    if (lastStatus.state !== 'ready') return
    // isSilent=false(설치 마법사 표시 안 함, mac 은 무의미), forceRunAfter=true(설치 후 재실행)
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  })

  if (!app.isPackaged) {
    log.info('updater: dev/unpackaged — auto-check disabled')
    return
  }

  // 읽기 전용 위치면 백그라운드 확인도 의미가 없다(다운로드해도 설치 불가). 상태만 알린다.
  const blocked = readOnlyInstallReason()
  if (blocked) {
    log.warn(`updater: disabled — ${blocked}`)
    emit({ state: 'blocked', error: blocked })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m) => log.info(`updater: ${m}`),
    warn: (m) => log.warn(`updater: ${m}`),
    error: (m) => log.error(`updater: ${m}`),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () =>
    emit({ state: 'not-available', version: app.getVersion() })
  )
  autoUpdater.on('download-progress', (p) =>
    emit({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) =>
    emit({ state: 'error', error: err instanceof Error ? err.message : String(err) })
  )

  // 시작 직후 1회 + 주기적으로 확인. 네트워크·릴리스 미존재 등 오류는 위 error 핸들러가 삼킨다.
  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => log.error('updater: check failed', err))
  }
  // 창이 뜬 뒤로 약간 미뤄, 초기 로딩과 경쟁하지 않게 한다.
  setTimeout(check, 8_000)
  setInterval(check, CHECK_INTERVAL_MS)
}
