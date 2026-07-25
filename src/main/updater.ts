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
