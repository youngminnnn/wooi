import { app, BrowserWindow, session } from 'electron'
import { IPC } from '@shared/types'
import { applyDevPaths, isDevIsolated, toolShimPath, wooiHome } from './paths'
import { AgentOrchestrator } from './agent/orchestrator'
import { initAgentTools } from './agent/tools'
import { writeWooiPlugins } from './agent/plugin'
import { cancelToolPermissions, initToolPermission } from './agent/tools/permission'
import { startToolSocket, stopToolSocket } from './agent/tools/socket'
import { setCodexStatusProvider } from './auth'
import { PaneWindows } from './paneWindows'
import { ScriptRunner } from './scripts'
import { startAutoRunScripts } from './workspaces'
import { SETUP_SCRIPT_ID } from '@shared/types'
import { flushStore, getStore } from './store'
import { getTranscripts } from './transcripts'
import { flushPendingSyncs } from './fsutil'
import { initHealthLogging } from './health'
import { TerminalManager } from './terminal'
import {
  applyNavigationGuards,
  loadRenderer,
  rendererWebPreferences,
  windowBackgroundColor
} from './windows'
import { registerIpc } from './ipc'
import { disposeRemote, getRemoteBridge, hasLocalRemoteOverride, initRemote } from './remote'
import { pendingPermissions } from './remote/permissions'
import { initStackedWaits } from './stackedWait'
import { rememberCompacting, rememberContextUsage } from './contextUsageCache'
import { rememberRunningAgents } from './runningAgentsCache'
import type { AppState, ChatEvent, PermissionRequest } from '@shared/types'
import { log } from './logger'
import { hydrateEnvFromLoginShell } from './env'
import { initUpdater } from './updater'
import { initNotice } from './notice'
import { initFeatures } from './features'
import { initPreview } from './preview'

let mainWindow: BrowserWindow | null = null

// dev 실행이 설치된 앱의 설정·워크스페이스·트랜스크립트를 건드리지 않도록 userData 를 먼저
// 옮긴다([[paths]]). 아래 WOOI_USER_DATA 캡처보다, 그리고 store/transcripts(lazy 싱글턴)가
// 처음 생성되기보다 반드시 앞서야 한다.
applyDevPaths()

// logger 와 agent-host(유틸리티 프로세스)는 electron `app` 없이 userData 경로를 알아야 하므로
// (ESM 에서 유틸리티 프로세스가 electron 을 import 하면 로드 시 throw) 가장 먼저 env 로 박아 둔다.
// app.getPath 는 ready 이전에도 사용 가능하다. host fork 시 이 값을 그대로 물려준다.
//
// 물려받은 값이 있어도 **덮어쓴다**. Wooi 안의 에이전트·터미널에서 `npm run dev` 를 띄우면 그
// 셸은 설치본이 host fork 에 넣어 둔 WOOI_USER_DATA(설치본 경로)와 WOOI_LOG_NAME(host.log)을
// 그대로 물려받고, dev 인스턴스가 그 값을 쓰면 설치본의 로그 파일에 섞여 쓴다([[paths]] 의
// 대소문자 함정과 같은 부류다). 이 프로세스의 userData 는 언제나 app.getPath 가 진실이다.
process.env.WOOI_USER_DATA = app.getPath('userData')
// 메인은 언제나 main.log 에 적는다. WOOI_LOG_NAME 은 host fork 에게만 주는 값이다.
delete process.env.WOOI_LOG_NAME

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
  mirrorToRemote(channel, payload)
}

/**
 * 렌더러로 나가는 방송을 원격에도 흘린다.
 *
 * 렌더러 방송 **뒤에** 부르고 통째로 try/catch 로 감싼다 — 원격은 부가 기능이고,
 * 여기서 던지면 데스크톱 UI 가 갱신을 잃는다. 원격이 꺼져 있으면 publishState 가
 * 즉시 반환하므로 이 경로의 비용은 함수 호출 하나다.
 *
 */
function mirrorToRemote(channel: string, payload: unknown): void {
  try {
    if (channel === IPC.evtPermission) {
      pendingPermissions.add(payload as PermissionRequest)
    } else if (channel === IPC.evtPermissionCancel) {
      pendingPermissions.remove(payload as string)
    } else if (channel === IPC.evtChat) {
      // 채팅 이벤트는 델타까지 포함해 초당 수십 개가 지나간다. 폰 상태줄이 쓰는 두 종류만
      // 적어 두고 **값이 실제로 바뀌었을 때만** 방송으로 이어 간다 — 나머지는 여기서 끊는다.
      if (!rememberChatStatus(payload)) return
    } else if (channel !== IPC.evtState) {
      return
    }

    const appState = channel === IPC.evtState ? (payload as AppState) : getStore().getState()
    getRemoteBridge().publishState(appState, pendingPermissions.list())
  } catch {
    // 브리지가 아직 초기화되지 않았거나(기동 초기) 원격이 꺼져 있다 — 정상이다.
  }
}

/**
 * 채팅 이벤트에서 폰 상태줄이 쓰는 것(컨텍스트 사용량·압축 진행)을 캐시에 적는다.
 *
 * 이 값들은 AppState 에 없어서(휘발성이라 영속하지 않는다) 미러가 읽을 곳이 따로 필요하다.
 * [[main/contextUsageCache]] 참고.
 *
 * @returns 폰이 보는 값이 바뀌었으면 true — 그때만 상태를 다시 발행한다.
 */
function rememberChatStatus(payload: unknown): boolean {
  const message = payload as { workspaceId?: string; event?: ChatEvent }
  const workspaceId = message?.workspaceId
  const event = message?.event
  if (typeof workspaceId !== 'string' || event === undefined) return false
  if (event.type === 'context') {
    return rememberContextUsage(workspaceId, {
      usedTokens: event.usedTokens,
      maxTokens: event.maxTokens,
      percentage: event.percentage
    })
  }
  if (event.type === 'compacting') return rememberCompacting(workspaceId, event.active)
  if (event.type === 'agents') {
    rememberRunningAgents(workspaceId, event.agents)
    // 폰 상태줄이 쓰지 않는 값이다 — 적어만 두고 재발행을 부르지 않는다.
    return false
  }
  return false
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
const scripts = new ScriptRunner(dispatch, (workspaceId, scriptId, code) => {
  if (scriptId !== SETUP_SCRIPT_ID) return
  const store = getStore()
  const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
  const repo = ws ? store.getState().repos.find((r) => r.id === ws.repoId) : undefined
  store.update((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (ws) ws.setupState = code === 0 ? 'success' : 'failed'
  })
  if (code === 0 && ws && repo) startAutoRunScripts(scripts, ws, repo)
  dispatch(IPC.evtState, store.getState())
})
// Codex 는 인프로세스로 붙을 수 없어 도구 호출이 로컬 소켓으로 들어온다([[agent/tools/socket]]).
// 소켓과 shim 경로를 **여기서** 정해 env 에 박는다 — codex-host(그리고 그가 띄우는 app-server)가
// 그대로 물려받으므로, 어떤 호스트 프로세스를 fork 하기보다 먼저 와야 한다.
//
// 하위 프로세스가 자기 위치로 shim 을 추측하게 두지 않는 이유: import.meta.dirname 이 실행
// 맥락마다 달라(번들 out/main, 소스 src/main/codex) 조용히 등록이 빠질 수 있다. 경로를 아는 건
// 자기 옆에 산출물이 놓이는 메인뿐이다.
process.env.WOOI_TOOL_SOCKET = startToolSocket(app.getPath('userData'))
process.env.WOOI_TOOL_SHIM = toolShimPath()

// 소켓으로 들어온 도구 호출은 기존 권한 카드를 그대로 탄다([[agent/tools/permission]]) —
// Codex 의 app-server 는 MCP 도구에 대해 승인을 물어보지 않기 때문이다.
initToolPermission({ dispatch: (request) => dispatch(IPC.evtPermission, request) })

const terminals = new TerminalManager(dispatch)

const stackedWaits = initStackedWaits({
  sendMessage: (workspaceId, text) => sessions.sendMessage(workspaceId, text),
  postToTranscript: (workspaceId, item) => {
    getTranscripts().upsert(workspaceId, item)
    dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
  },
  broadcastState: () => dispatch(IPC.evtState, getStore().getState())
})

// 에이전트가 Wooi 자체를 조작하는 도구들의 실행부에 필요한 것을 넘긴다([[agent/tools]]).
// scripts·terminals 가 만들어진 뒤여야 한다 — 워크스페이스를 만드는 도구가 셋업 스크립트를
// 돌리고, 아카이브하는 도구가 그 워크스페이스의 터미널을 끊는다.
initAgentTools({
  scripts,
  sessions,
  terminals,
  broadcastState: () => dispatch(IPC.evtState, getStore().getState()),
  sendMessage: (workspaceId, text, opts) =>
    sessions.sendMessage(workspaceId, text, undefined, opts),
  emitChatEvent: (workspaceId, event) => dispatch(IPC.evtChat, { workspaceId, event }),
  listModels: (backend) => sessions.listModels(backend),
  listBackends: () => sessions.listBackends(),
  postToTranscript: (workspaceId, item) => {
    getTranscripts().upsert(workspaceId, item)
    dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
  }
})
stackedWaits.restore()

// `/wooi:*` 슬래시 명령을 담은 Claude 플러그인을 디스크에 만든다([[agent/plugin]]).
// 매번 다시 쓴다 — 카탈로그가 SSOT 이므로 앱을 업데이트하면 명령도 함께 바뀌어야 한다.
// 실패해도 앱은 정상 동작한다 — 그 명령들만 없다(resolveWooiPlugin 이 존재 여부로 거른다).
try {
  writeWooiPlugins()
} catch (err) {
  log.warn('plugin: failed to write /wooi:* slash commands; they will not be available', err)
}

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
    backgroundColor: windowBackgroundColor(),
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
    // 앱을 떠나는 순간은 밀린 쓰기를 내리기 좋은 지점이다 — 사용자가 보고 있지 않으니 몇 ms 의
    // 블로킹이 드러나지 않고, 그대로 잠들거나 강제 종료돼도 상태가 남는다.
    //
    // 단, 분리된 패널 창([[paneWindows]])으로 초점이 옮겨 간 것뿐일 수도 있다. 그때는 사용자가
    // 여전히 앱을 쓰는 중이라 동기 쓰기가 그대로 체감된다 — 초점이 앱 밖으로 나갔을 때만 내린다.
    // 초점 이동은 blur 다음에 반영되므로 한 틱 뒤에 확인한다.
    setImmediate(() => {
      const stillInApp = BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && w.isFocused()
      )
      if (stillInApp) return
      flushStore()
      flushPendingSyncs()
    })
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
  // Preview 게스트의 울타리는 창보다 먼저 세운다 — will-attach-webview 를 놓치면 그 webview 는
  // 우리가 강제하려던 설정 없이 붙는다([[preview]]).
  initPreview(dispatch)
  // 원격 브리지는 IPC 등록보다 **먼저** 만들어야 한다 — 핸들러가 getRemoteBridge() 를 부른다.
  // 만드는 것 자체는 아무 자원도 잡지 않는다(설정을 읽을 뿐이다). 실제 연결은 아래에서
  // 사용자가 켜 둔 경우에만 일어난다.
  // 마지막으로 알던 가용성에서 시작한다 — 플래그는 네트워크로 오므로 기동 직후에는 알 수
  // 없는데, 그때 꺼진 것으로 치면 이미 쓰던 사용자에게서 기능이 깜빡인다.
  const remoteOverride = hasLocalRemoteOverride()
  initRemote(
    (status) => dispatch(IPC.evtRemote, status),
    () => getStore().getState(),
    // 폰이 워크스페이스를 열었다 = 사용자가 그걸 읽었다. 미확인 표시는 렌더러 메모리에만
    // 있으므로 방송하지 않으면 데스크톱은 영원히 안 읽은 상태로 남는다.
    (workspaceId) => dispatch(IPC.evtRemoteRead, workspaceId),
    remoteOverride || getStore().getState().settings.remoteAccessAvailable
  )
  registerIpc({ sessions, scripts, terminals, panes, dispatch, getWindow: () => mainWindow })
  createWindow()
  sessions.prewarm()
  initUpdater(dispatch)
  initNotice(dispatch)
  initFeatures((features) => {
    // 로컬 탈출구가 있으면 원격 플래그가 닫혀 있어도 열어 둔다 — 만든 사람은 스토어에
    // 올라가기 전에도 써야 한다.
    getStore().update((state) => {
      state.settings.remoteAccessAvailable = features.remoteAccess
    })
    getRemoteBridge().setAvailable(remoteOverride || features.remoteAccess)
  })
  // 지난 실행에서 켜 두었다면 복원한다. 실패해도 앱 기동을 막지 않는다 — 상태는 설정 패널에 뜬다.
  // 가용성이 닫혀 있으면 setEnabled 가 거절하므로 여기서 따로 막지 않아도 되지만,
  // 쓸데없는 실패 상태를 만들지 않도록 조건에 함께 둔다.
  if (getStore().getState().settings.remoteEnabled && getRemoteBridge().status().available) {
    void getRemoteBridge()
      .setEnabled(true)
      .catch((err) => log.error('원격 자동 연결 실패', err))
  }
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
  void disposeRemote()
  sessions.disposeAll()
  scripts.disposeAll()
  terminals.disposeAll()
  // 소켓 파일을 남기면 다음 실행의 bind 가 EADDRINUSE 로 실패한다(그쪽에서도 지우지만, 살아
  // 있는 앱이 쓰던 소켓을 지우는 일이 없도록 정상 종료 경로에서 먼저 치운다).
  stopToolSocket(app.getPath('userData'))
  // 응답을 받을 창이 사라지므로 매달린 승인 요청을 거부로 확정한다.
  cancelToolPermissions()
  // 상태 쓰기와 트랜스크립트 fsync 는 성능을 위해 모아서 처리된다 — 프로세스가 사라지기 전에
  // 밀린 것을 마저 내려야 마지막 변경이 유실되지 않는다.
  flushStore()
  flushPendingSyncs()
})
