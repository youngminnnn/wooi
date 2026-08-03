import { app, BrowserWindow, session } from 'electron'
import { IPC } from '@shared/types'
import { applyDevPaths, isDevIsolated, wooiHome } from './paths'
import { AgentOrchestrator } from './agent/orchestrator'
import { setCodexStatusProvider } from './auth'
import { PaneWindows } from './paneWindows'
import { ScriptRunner } from './scripts'
import { flushStore, getStore } from './store'
import { flushPendingSyncs } from './fsutil'
import { initHealthLogging } from './health'
import { TerminalManager } from './terminal'
import { applyNavigationGuards, loadRenderer, rendererWebPreferences } from './windows'
import { registerIpc } from './ipc'
import { log } from './logger'
import { hydrateEnvFromLoginShell } from './env'
import { initUpdater } from './updater'
import { initNotice } from './notice'

let mainWindow: BrowserWindow | null = null

// dev 실행이 설치된 앱의 설정·워크스페이스·트랜스크립트를 건드리지 않도록 userData 를 먼저
// 옮긴다([[paths]]). 아래 WOOI_USER_DATA 캡처보다, 그리고 store/transcripts(lazy 싱글턴)가
// 처음 생성되기보다 반드시 앞서야 한다.
applyDevPaths()

// logger 와 agent-host(유틸리티 프로세스)는 electron `app` 없이 userData 경로를 알아야 하므로
// (ESM 에서 유틸리티 프로세스가 electron 을 import 하면 로드 시 throw) 가장 먼저 env 로 박아 둔다.
// app.getPath 는 ready 이전에도 사용 가능하다. host fork 시 이 값을 그대로 물려준다.
process.env.WOOI_USER_DATA ||= app.getPath('userData')

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
// Codex 의 로그인 상태는 app-server 만 정확히 안다(자격증명이 OS 키체인에 있을 수 있다).
// auth 계층이 에이전트 구현에 의존하지 않도록, 조회 함수만 주입해 준다.
setCodexStatusProvider(async () => {
  const codex = sessions.accountFor('codex')
  if (!codex?.accountStatus) return { installed: true, loggedIn: false }
  return codex.accountStatus()
})
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
// 듀얼 모니터를 위해 작업 패널·스크립트 패널을 별도 창으로 떼어 낼 수 있게 한다([[paneWindows]]).
const panes = new PaneWindows(dispatch)

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
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: rendererWebPreferences()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 분리한 패널 창은 메인 창의 위성이다 — 주인이 닫히면 함께 정리한다.
  mainWindow.on('closed', () => panes.closeAll())

  // 창이 포커스를 얻으면 renderer 가 보고 있는 workspace 의 미확인 표시를 해제하도록 알린다.
  // DOM 의 window 'focus' 는 Dock 클릭·앱 전환 시 누락될 수 있어, main 의 신뢰 가능한 이벤트로 보완한다.
  mainWindow.on('focus', () => mainWindow?.webContents.send(IPC.evtWindowFocus))
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send(IPC.evtWindowBlur)
    // 자리를 뜨는 순간은 밀린 쓰기를 내리기 좋은 시점이다 — 사용자가 앱을 보고 있지 않으니
    // 몇 ms 의 블로킹이 드러나지 않고, 그대로 잠들거나 강제 종료돼도 상태가 남는다.
    flushStore()
    flushPendingSyncs()
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error(`renderer load failed: ${code} ${desc}`)
  })

  // 렌더러의 에러·경고를 메인 로그로 넘긴다. 렌더러가 React 에러로 통째로 언마운트되면 화면은
  // 비어 버리는데, 그 원인은 DevTools 콘솔에만 남아 로그만 봐서는 "앱은 정상 기동"으로 보인다.
  // 이 한 줄이 "아무것도 안 뜬다" 류의 문제를 로그에서 바로 짚을 수 있게 해 준다.
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      log.error(`renderer console [${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    }
  })

  // 외부 링크 처리와 이탈 내비게이션 차단은 모든 창이 같다([[windows]]).
  applyNavigationGuards(mainWindow)

  loadRenderer(mainWindow)
}

app.whenReady().then(() => {
  // 인증 탐지·세션 spawn 보다 먼저 셸 환경(PATH + export 변수)을 보정해, 설치된 CLI 가
  // 미설치로 보이거나 child 프로세스가 토큰/설정을 못 읽는 일이 없게 한다.
  hydrateEnvFromLoginShell()
  applyContentSecurityPolicy()
  registerIpc({ sessions, scripts, terminals, panes, getWindow: () => mainWindow })
  createWindow()
  sessions.prewarm()
  initUpdater(dispatch)
  initNotice(dispatch)
  initHealthLogging(() => sessions.liveSessionCount())
  if (isDevIsolated()) {
    log.info(`dev 격리: userData=${app.getPath('userData')} worktreeRoot=${wooiHome()}`)
  }
  log.info('main ready')

  // Dock 클릭으로 되살릴 창은 **메인 창**이다. 창 개수만 보면 분리한 패널 창만 떠 있을 때
  // 메인 창을 다시 만들지 못해 앱이 패널 하나에 갇힌다.
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessions.disposeAll()
  scripts.disposeAll()
  terminals.disposeAll()
  // 상태 쓰기와 트랜스크립트 fsync 는 성능을 위해 모아서 처리된다 — 프로세스가 사라지기 전에
  // 밀린 것을 마저 내려야 마지막 변경이 유실되지 않는다.
  flushStore()
  flushPendingSyncs()
})
