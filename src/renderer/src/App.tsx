import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { CURRENT_TERMS_VERSION, orderVisibleWorkspaces } from '@shared/types'
import { useStore } from './store'
import { nextPermissionMode } from './lib/permission'
import { applyTheme } from './lib/theme'
import TitleBar from './components/TitleBar'
import { UpdateBanner } from './components/UpdateBanner'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import WorkArea from './components/WorkArea'
import Splitter from './components/Splitter'
import EmptyState from './components/EmptyState'
import Overview from './components/Overview'
import SettingsModal from './components/SettingsModal'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import RepoConfigModal from './components/RepoConfigModal'
import OnboardingModal from './components/OnboardingModal'
import ShortcutsHelp from './components/ShortcutsHelp'
import QuickSwitcher from './components/QuickSwitcher'
import FeatureTour from './components/FeatureTour'
import GithubGate from './components/GithubGate'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import Logo from './components/Logo'

export default function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const app = useStore((s) => s.app)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const authStatus = useStore((s) => s.authStatus)
  const rightWidth = useStore((s) => s.rightWidth)
  const setRightWidth = useStore((s) => s.setRightWidth)
  const rightPanelOpen = useStore((s) => s.rightPanelOpen)
  const rightBase = useRef(rightWidth)

  // 사이드바 오른쪽의 메인 컨텐츠 영역 너비를 측정한다. 우측 작업 패널은 고정 px 라서
  // 창이 좁아지면 채팅이 0 으로 찌그러지므로, 측정한 너비로 패널 폭을 동적으로 제한한다.
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentW, setContentW] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContentW(el.clientWidth))
    ro.observe(el)
    setContentW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [newWs, setNewWs] = useState<{ repoId: string; parentWorkspaceId: string | null } | null>(
    null
  )
  const [configRepoId, setConfigRepoId] = useState<string | null>(null)
  // ⌘K 퀵 스위처. ⌘1–9 로 닿지 않는(10번째 이후) 워크스페이스로 이동하는 기본 경로다.
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  // 설정의 "Take a tour" 로 여는 기능 투어. 실제 화면 위에서 진행하도록 앱 레벨에서 렌더한다.
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 권위 있는 설정의 테마를 <html> 에 반영한다(설정 변경·system 선호 변화 추적 포함).
  const theme = app?.settings.theme
  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])

  // 온보딩(약관 동의·계정 연결·기본값 고르기) 모달이 떠 있는 동안에는 전역 단축키도 막아,
  // 동의 전 앱 조작을 차단한다.
  const onboardingOpen =
    !!app &&
    (!app.settings.onboarded ||
      !app.settings.pickedDefaults ||
      app.settings.acceptedTermsVersion !== CURRENT_TERMS_VERSION)

  // gh(GitHub CLI)는 필수다 — "설치 + 로그인"이 모두 끝나기 전에는 본 화면을 막는다(하드 게이트).
  // 온보딩(약관 동의)을 먼저 끝낸 뒤에만 게이트를 띄우고, 인증 상태가 로드되기 전에는 깜빡임을
  // 피하려 띄우지 않는다. gh 가 제거·로그아웃되면 다음 갱신에서 다시 게이트가 뜬다.
  const githubReady =
    authStatus !== null && authStatus.github.installed && authStatus.github.loggedIn
  const githubGateOpen = !!app && !onboardingOpen && authStatus !== null && !githubReady

  const anyModalOpen =
    showSettings ||
    showShortcuts ||
    quickSwitchOpen ||
    newWs !== null ||
    configRepoId !== null ||
    onboardingOpen ||
    githubGateOpen ||
    tourOpen

  // '?' 키(어디서든, 단 입력 중이 아닐 때)로 단축키 도움말을 연다. Overview 등에서
  // 커스텀 이벤트로도 열 수 있다.
  useEffect(() => {
    const onHelp = (): void => setShowShortcuts(true)
    window.addEventListener('wooi:open-shortcuts', onHelp)
    return () => window.removeEventListener('wooi:open-shortcuts', onHelp)
  }, [])

  // 키보드: ⇧⇥ 권한 모드 순환, ⌘1–9 워크스페이스 선택, ⌘[ / ⌘] 이전/다음.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      // 모달이나 confirm 대화상자가 떠 있으면 전역 단축키를 막는다.
      if (anyModalOpen || st.confirmState) return

      if (e.key === 'Tab' && e.shiftKey) {
        const ws = st.app?.workspaces.find((w) => w.id === st.selectedWorkspaceId)
        if (!ws) return
        e.preventDefault()
        void window.api.workspace.setPermissionMode(ws.id, nextPermissionMode(ws.permissionMode))
        return
      }

      // '?' — 단축키 도움말. 입력창/텍스트영역에 포커스가 있으면 무시(글자 입력을 방해하지 않게).
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement as HTMLElement | null
        const typing =
          !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing) {
          e.preventDefault()
          setShowShortcuts(true)
          return
        }
      }

      if (!e.metaKey) return

      // ⇧⌘A: 대기 중인 모든 권한을 한 번에 승인(병렬 세션 권한 피로 완화). 확인 후 실행.
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const count = st.approvablePermissionCount()
        if (count > 0) {
          void st
            .confirm({
              title: `Approve ${count} pending permission${count > 1 ? 's' : ''}?`,
              body: 'Allows every waiting tool request across all workspaces at once. Questions that need an answer are left untouched.',
              confirmLabel: 'Approve all'
            })
            .then((ok) => {
              if (ok) useStore.getState().approveAllPermissions()
            })
        }
        return
      }

      // ⌘K: 퀵 스위처. ⌘1–9 는 앞 9개까지만 닿으므로, 그 뒤 워크스페이스는 여기서 검색해 이동한다.
      // 키 판별은 e.code 로 한다 — 한글 IME 에서 e.key 가 'k' 가 아닐 수 있다.
      if (e.code === 'KeyK' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (st.app?.workspaces.some((w) => !w.archived)) setQuickSwitchOpen(true)
        return
      }

      // ⌘,: 설정 열기(macOS 표준 Preferences 단축키).
      if (e.code === 'Comma' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setShowSettings(true)
        return
      }

      // ⌘N: 현재 포커스된 repo(선택된 workspace 의 repo, 없으면 첫 repo)에 새 워크스페이스 추가.
      // 사이드바의 + 버튼과 같은 경로를 탄다 — 수동 설정이면 모달, 아니면 즉시 자동 생성.
      if (e.code === 'KeyN' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const repoId =
          st.app?.workspaces.find((w) => w.id === st.selectedWorkspaceId)?.repoId ??
          st.app?.repos[0]?.id
        if (!repoId) {
          st.pushToast('info', 'Add a repository first.')
          return
        }
        if (st.app?.settings.manualWorkspaceSetup) setNewWs({ repoId, parentWorkspaceId: null })
        else void st.createWorkspace(repoId)
        return
      }

      // ⌘J: 우측 작업 패널 표시/숨김 토글.
      if (e.key === 'j') {
        e.preventDefault()
        st.toggleRightPanel()
        return
      }

      // ⌘U: 다음 미확인(완료된 응답) 세션으로 이동.
      if (e.key.toLowerCase() === 'u') {
        e.preventDefault()
        const id = st.nextUnreadId()
        if (id) void st.selectWorkspace(id)
        return
      }

      // ⌘I: 다음 권한 대기(입력 필요) 세션으로 이동.
      if (e.key.toLowerCase() === 'i') {
        e.preventDefault()
        const id = st.nextPendingPermissionId()
        if (id) void st.selectWorkspace(id)
        return
      }

      // 우상단 헤더 도구 단축키 — 현재 선택된 workspace 를 대상으로 한다.
      // ⇧⌘ 조합이라 macOS 기본 단축키(⌘S/E/F, ⌘⌫ 등)나 앱 기존 단축키와 충돌하지 않는다.
      // (dev 실행은 아래에서 ⌃⌘R 로 별도 처리 — ⇧⌘R 은 기본 메뉴 Force Reload 와 충돌.)
      const selId = st.selectedWorkspaceId
      // 키 판별은 e.code 로 한다 — 한글 IME 등에서 e.key 가 문자가 아닐 수 있다.
      if (selId && e.shiftKey) {
        // ⇧⌘S: 스크립트 패널 열기/닫기.
        if (e.code === 'KeyS') {
          e.preventDefault()
          st.setScriptPanelOpen(selId, !(st.scriptPanelOpen[selId] ?? false))
          return
        }
        // ⇧⌘E: 에디터에서 열기.
        if (e.code === 'KeyE') {
          e.preventDefault()
          void window.api.workspace.openInEditor(selId)
          return
        }
        // ⇧⌘F: Finder 에서 보기.
        if (e.code === 'KeyF') {
          e.preventDefault()
          void window.api.workspace.revealInFinder(selId)
          return
        }
        // ⇧⌘X: 대화 내보내기 메뉴 열기(ExportMenu 가 이벤트를 받아 드롭다운을 연다).
        if (e.code === 'KeyX') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('wooi:export-conversation', { detail: selId }))
          return
        }
        // ⇧⌘⌫: workspace 아카이브(ChatView 가 확인 다이얼로그와 함께 처리).
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('wooi:archive-workspace', { detail: selId }))
          return
        }
      }

      // ⌃⌘R: dev 스크립트 실행/중지 — 스크립트 패널 열림 여부와 무관하게 동작한다.
      // (⇧⌘R 은 Electron 기본 메뉴의 Force Reload 와 충돌하므로 Control 조합을 쓴다.)
      // 키 판별은 e.code('KeyR')로 한다 — 한글 IME·Control 조합에서 e.key 가 'r' 이 아닐 수 있다.
      if (selId && e.ctrlKey && e.code === 'KeyR') {
        e.preventDefault()
        const ws = st.app?.workspaces.find((w) => w.id === selId)
        const devCmd = ws && st.app?.repos.find((r) => r.id === ws.repoId)?.devScript
        if (!devCmd || !devCmd.trim()) {
          st.pushToast('info', 'No dev command set for this repo — add one in repo settings.')
          return
        }
        const devRunning = (st.scriptStatus[selId] ?? []).some(
          (s) => s.kind === 'dev' && s.state === 'running'
        )
        if (devRunning) {
          void window.api.script.stop(selId, 'dev').then(() => st.refreshScriptStatus(selId))
        } else {
          // 실행 시 스크립트 패널(dev 탭)을 열어 로그·상태를 바로 볼 수 있게 한다.
          st.setScriptPanelOpen(selId, true)
          void window.api.script.run(selId, 'dev').then(() => st.refreshScriptStatus(selId))
        }
        return
      }

      // 사이드바에 보이는 순서(레포 순 → 레포 안에서는 stack 순)와 정확히 같은 목록.
      // Sidebar 의 번호 배지도 같은 함수를 쓰므로 "위에서 n번째 = ⌘n" 이 항상 성립한다.
      const list = orderVisibleWorkspaces(st.app?.repos ?? [], st.app?.workspaces ?? [])
      if (!list.length) return

      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        if (idx < list.length) {
          e.preventDefault()
          void st.selectWorkspace(list[idx].id)
        }
      } else if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        const cur = list.findIndex((w) => w.id === st.selectedWorkspaceId)
        const delta = e.key === ']' ? 1 : -1
        const next = cur < 0 ? 0 : (cur + delta + list.length) % list.length
        void st.selectWorkspace(list[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anyModalOpen])

  if (!ready || !app) {
    return (
      <div className="h-full grid place-items-center bg-[var(--bg)]">
        <div className="flex flex-col items-center gap-3 text-neutral-500">
          <Logo size={40} />
          <span className="text-sm">Loading…</span>
        </div>
      </div>
    )
  }

  const selected = app.workspaces.find((w) => w.id === selectedId && !w.archived) ?? null
  const claudeMissing = app.settings.onboarded && authStatus !== null && !authStatus.claude.loggedIn

  // 우측 패널이 차지할 수 있는 최대 폭 = 사용 가능한 너비 - 채팅 최소 너비.
  // 창이 좁아지면 maxRight 가 줄어 패널이 따라 좁아지고, 다시 넓히면 저장된 rightWidth 로 복원된다.
  const MIN_CHAT_WIDTH = 360
  const maxRight = Math.max(320, contentW - MIN_CHAT_WIDTH)
  const effectiveRightWidth = contentW ? Math.min(rightWidth, maxRight) : rightWidth

  // 약관 미동의(또는 버전 불일치)면 동의 단계부터, 계정 연결이 안 끝났으면 연동 단계를 띄운다.
  // 기본값을 아직 고른 적이 없으면(신규 설치는 물론, 이 단계가 없던 버전에서 올라온 기존 사용자도)
  // 마지막에 "기본값 고르기"를 한 번 띄운다.
  const needsConsent = app.settings.acceptedTermsVersion !== CURRENT_TERMS_VERSION
  const needsOnboarding = !app.settings.onboarded
  const needsDefaults = !app.settings.pickedDefaults

  // 새 workspace 만들기: 수동 설정이면 모달, 아니면 즉시 자동 생성.
  // 자동 생성은 사이드바에 스피너 행을 바로 띄우고 worktree 준비는 백그라운드로 진행한다.
  const handleNewWorkspace = (repoId: string): void => {
    if (app.settings.manualWorkspaceSetup) {
      setNewWs({ repoId, parentWorkspaceId: null })
      return
    }
    void useStore.getState().createWorkspace(repoId)
  }

  // stacked PR: 특정 워크스페이스 위에 새 워크스페이스를 쌓는다(base = 부모 브랜치).
  const handleStackWorkspace = (repoId: string, parentWorkspaceId: string): void => {
    if (app.settings.manualWorkspaceSetup) {
      setNewWs({ repoId, parentWorkspaceId })
      return
    }
    void useStore.getState().createWorkspace(repoId, { parentWorkspaceId })
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      <TitleBar onOpenSettings={() => setShowSettings(true)} />

      <UpdateBanner />

      {claudeMissing && (
        <button
          onClick={() => setShowSettings(true)}
          className="no-drag shrink-0 flex items-center justify-center gap-2 h-8 bg-[var(--warning-500)]/10 border-b border-[var(--warning-500)]/25 text-sm text-[var(--warning-300)] hover:bg-[var(--warning-500)]/15"
        >
          <AlertTriangle size={13} />
          You&rsquo;re not signed in to your AI provider. Agents won&rsquo;t run until you connect —
          click to open Settings.
        </button>
      )}

      <div className="flex-1 flex min-h-0">
        <Sidebar
          onNewWorkspace={handleNewWorkspace}
          onStackWorkspace={handleStackWorkspace}
          onConfigRepo={setConfigRepoId}
          onOpenQuickSwitch={() => setQuickSwitchOpen(true)}
        />
        <div ref={contentRef} className="flex-1 min-w-0 border-l border-[var(--border)] flex">
          {selected ? (
            <>
              <div data-tour="chat" className="flex-1 min-w-0">
                <ChatView key={selected.id} workspace={selected} />
              </div>
              {rightPanelOpen && (
                <>
                  <Splitter
                    axis="x"
                    onStart={() => (rightBase.current = useStore.getState().rightWidth)}
                    // 분할바를 오른쪽으로 끌면(dx>0) 우측 패널이 좁아진다.
                    // 채팅이 maxRight 미만으로 줄지 않도록 드래그 폭도 함께 제한한다.
                    onDelta={(dx) => setRightWidth(Math.min(rightBase.current - dx, maxRight))}
                  />
                  <div
                    data-tour="work-panel"
                    style={{ width: effectiveRightWidth }}
                    className="shrink-0 border-l border-[var(--border)] min-w-0"
                  >
                    <WorkArea key={selected.id} workspace={selected} />
                  </div>
                </>
              )}
            </>
          ) : app.workspaces.some((w) => !w.archived) ? (
            <Overview />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>

      {(needsConsent || needsOnboarding || needsDefaults) && (
        <OnboardingModal
          needsConsent={needsConsent}
          needsOnboarding={needsOnboarding}
          needsDefaults={needsDefaults}
        />
      )}
      {githubGateOpen && <GithubGate />}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onStartTour={() => {
            setShowSettings(false)
            setTourOpen(true)
          }}
        />
      )}
      {tourOpen && <FeatureTour onDone={() => setTourOpen(false)} />}
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
      {quickSwitchOpen && <QuickSwitcher onClose={() => setQuickSwitchOpen(false)} />}
      {newWs && (
        <NewWorkspaceModal
          repoId={newWs.repoId}
          parentWorkspaceId={newWs.parentWorkspaceId}
          onClose={() => setNewWs(null)}
        />
      )}
      {configRepoId && (
        <RepoConfigModal repoId={configRepoId} onClose={() => setConfigRepoId(null)} />
      )}

      <Toaster />
      <ConfirmDialog />
    </div>
  )
}
