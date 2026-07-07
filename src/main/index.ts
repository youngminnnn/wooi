import { app, shell, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import { AgentOrchestrator } from './agent/orchestrator'
import { ScriptRunner } from './scripts'
import { getStore } from './store'
import { TerminalManager } from './terminal'
import { registerIpc } from './ipc'
import { log } from './logger'
import { hydrateEnvFromLoginShell } from './env'

let mainWindow: BrowserWindow | null = null

// logger 와 agent-host(유틸리티 프로세스)는 electron `app` 없이 userData 경로를 알아야 하므로
// (ESM 에서 유틸리티 프로세스가 electron 을 import 하면 로드 시 throw) 가장 먼저 env 로 박아 둔다.
// app.getPath 는 ready 이전에도 사용 가능하다. host fork 시 이 값을 그대로 물려준다.
process.env.DITTO_USER_DATA ||= app.getPath('userData')

// 배포 빌드는 콘솔이 보이지 않으므로, 처리되지 않은 오류를 파일 로그로 남겨 진단 가능하게 한다.
process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))

/**
 * 모든 창으로 채널 이벤트를 방송한다 (AgentOrchestrator/ScriptRunner 가 사용).
 *
 * 각 send 를 개별 try/catch 로 감싼다: 파괴된 webContents 로의 송신이나 직렬화 실패(과도하게
 * 큰/직렬화 불가 페이로드)가 던지는 예외가 호출 측 루프를 끊지 않게 한다. 페이로드 크기 자체는
 * 소스(claude/clamp.ts)에서 이미 제한해 네이티브 직렬화 abort 를 막지만, 여기서도 한 번 더 막는다.
 */
function dispatch(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch (err) {
      log.error(`dispatch failed on ${channel}`, err)
    }
  }
}

const sessions = new AgentOrchestrator(dispatch, () => mainWindow)
// setup 스크립트가 끝나면 결과를 workspace 에 영속하고 상태를 방송한다 — 재시작 후에도 성공한
// setup 은 재실행 버튼을 노출하지 않고, 실패했을 때만 Retry 를 보여 주기 위한 것.
const scripts = new ScriptRunner(dispatch, (workspaceId, kind, code) => {
  if (kind !== 'setup') return
  const store = getStore()
  store.update((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (ws) ws.setupState = code === 0 ? 'success' : 'failed'
  })
  dispatch(IPC.evtState, store.getState())
})
const terminals = new TerminalManager(dispatch)

/**
 * 프로덕션에서만 엄격한 Content-Security-Policy 를 응답 헤더로 주입한다.
 * dev(Vite/React HMR)는 인라인 프리앰블 스크립트 + localhost websocket 이 필요하므로
 * index.html 의 완화된 meta CSP 를 그대로 쓰고 여기서는 아무것도 하지 않는다.
 * 프로덕션 번들은 인라인 스크립트·원격 연결을 쓰지 않으므로 script-src 를 'self' 로 좁히고
 * 'unsafe-inline'/ws/localhost 를 제거한다. meta 와 헤더가 함께 적용되면 더 엄격한 쪽이 이긴다.
 */
function applyContentSecurityPolicy(): void {
  if (process.env['ELECTRON_RENDERER_URL']) return

  const policy =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; font-src 'self' data:"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] }
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0c0e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 창이 포커스를 얻으면 renderer 가 보고 있는 workspace 의 미확인 표시를 해제하도록 알린다.
  // DOM 의 window 'focus' 는 Dock 클릭·앱 전환 시 누락될 수 있어, main 의 신뢰 가능한 이벤트로 보완한다.
  mainWindow.on('focus', () => mainWindow?.webContents.send(IPC.evtWindowFocus))
  mainWindow.on('blur', () => mainWindow?.webContents.send(IPC.evtWindowBlur))

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error(`renderer load failed: ${code} ${desc}`)
  })

  // 외부 링크(window.open / target=_blank)는 기본 브라우저로.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 앱 내 일반 링크(<a href> 클릭)가 창을 외부 URL 로 이동시키지 않게 가로채,
  // 사용자의 기본 브라우저로 연다. 개발 서버 URL 로의 이동만 허용.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (/^https?:\/\//.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 인증 탐지·세션 spawn 보다 먼저 셸 환경(PATH + export 변수)을 보정해, 설치된 CLI 가
  // 미설치로 보이거나 child 프로세스가 토큰/설정을 못 읽는 일이 없게 한다.
  hydrateEnvFromLoginShell()
  applyContentSecurityPolicy()
  registerIpc({ sessions, scripts, terminals, getWindow: () => mainWindow })
  createWindow()
  log.info('main ready')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessions.disposeAll()
  scripts.disposeAll()
  terminals.disposeAll()
})
