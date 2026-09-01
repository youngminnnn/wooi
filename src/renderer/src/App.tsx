import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { CURRENT_TERMS_VERSION, hasAnyAgent, orderVisibleWorkspaces } from '@shared/types'
import type { AgentBackendId } from '@shared/types'
import { DEFAULT_SIDEBAR_WIDTH, useStore } from './store'
import { nextPermissionMode } from './lib/permission'
import { OPEN_REPO_SETTINGS_EVENT, openRepoSettings } from './lib/repoSettings'
import { OPEN_MIGRATE_EVENT } from './lib/migrate'
import { OPEN_FILE_QUICK_OPEN_EVENT, openFileQuickOpen } from './lib/fileViewer'
import { openNewWorkspaceMenu } from './lib/newWorkspaceMenu'
import { applyTheme } from './lib/theme'
import { finishSwitchHint } from './lib/uiFlags'
import { OPEN_SETTINGS_EVENT } from './lib/settingsNavigation'
import { FOCUS_COMPOSER_EVENT, INSERT_INTO_COMPOSER_EVENT } from './lib/composerFocus'
import { shouldFocusComposerFromEditingKey, shouldRedirectTyping } from './lib/typingRedirect'
import { archivedPreviewTarget, workspaceSurfaces } from './lib/archivedPreview'
import { buildStackLayers } from './lib/stackView'
import TitleBar from './components/TitleBar'
import { UpdateBanner } from './components/UpdateBanner'
import { NoticeBanner } from './components/NoticeBanner'
import Sidebar from './components/Sidebar'
import PrReviewScreen from './components/review/PrReviewScreen'
import FanoutCompareScreen from './components/fanout/FanoutCompareScreen'
import StackScreen from './components/stack/StackScreen'
import { useFeatureNudge } from './lib/featureNudge'
import PrReviewStartModal from './components/review/PrReviewStartModal'
import ChatView from './components/ChatView'
import ArchivedChatView from './components/ArchivedChatView'
import FileViewerOverlay from './components/FileViewerOverlay'
import FileQuickOpen from './components/FileQuickOpen'
import WorkArea from './components/WorkArea'
import Splitter from './components/Splitter'
import EmptyState from './components/EmptyState'
import Overview from './components/Overview'
import SettingsModal from './components/SettingsModal'
import ErrorBoundary from './components/ErrorBoundary'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import NewFromIssueModal from './components/NewFromIssueModal'
import NewFromPrModal from './components/NewFromPrModal'
import RepoConfigModal from './components/RepoConfigModal'
import MigrateModal from './components/MigrateModal'
import OnboardingModal from './components/OnboardingModal'
import ShortcutsHelp from './components/ShortcutsHelp'
import QuickSwitcher from './components/QuickSwitcher'
import TranscriptSearch from './components/TranscriptSearch'
import FeatureTour from './components/FeatureTour'
import GithubConnectModal from './components/GithubConnectModal'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import Hint from './components/Hint'
import Logo from './components/Logo'
import ClaudeLoginModal from './components/ClaudeLoginModal'
import CodexLoginModal from './components/CodexLoginModal'
import type { ExportConversationDetail } from './components/ExportMenu'

/**
 * 대화 입력창이 지금 화면에 닿아 있는가.
 *
 * 리뷰 화면·팬아웃 비교·파일 뷰어는 대화를 통째로 덮는다. 그 위에서 친 글자를 뒤쪽 textarea 에
 * 몰래 넣으면 사용자는 자기 글이 어디로 갔는지 알 수 없다 — ⌘L 이 같은 이유로 같은 판정을 쓴다.
 */
function chatComposerReachable(
  st: {
    selectedWorkspaceId: string | null
    activeReviewId: string | null
    activeFanoutGroupId: string | null
    overlayOpen: boolean
  },
  fileViewerVisible: boolean
): boolean {
  return (
    !!st.selectedWorkspaceId &&
    !st.activeReviewId &&
    !st.activeFanoutGroupId &&
    !st.overlayOpen &&
    !fileViewerVisible
  )
}

export default function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const app = useStore((s) => s.app)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const authStatus = useStore((s) => s.authStatus)
  const rightWidth = useStore((s) => s.rightWidth)
  const setRightWidth = useStore((s) => s.setRightWidth)
  const rightPanelOpen = useStore((s) =>
    selectedId
      ? (s.rightPanelOpen[selectedId] ?? s.app?.settings.defaultRightPanelOpen ?? true)
      : false
  )
  // 작업 패널을 별도 창으로 떼어 뒀으면 여기서는 그리지 않는다 — 분리는 복제가 아니라 이동이다.
  const workPaneDetached = useStore((s) => s.detachedPanes.work)
  const rightBase = useRef(rightWidth)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const sidebarBase = useRef(sidebarWidth)

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
  useEffect(() => {
    const open = (): void => setShowSettings(true)
    window.addEventListener(OPEN_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open)
  }, [])
  // Composer 에서 Settings 전체를 끌어오지 않고도 백엔드 로그인 모달을 열 수 있게 App 이 소유한다.
  const [loginBackend, setLoginBackend] = useState<AgentBackendId | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [newWs, setNewWs] = useState<{
    repoId: string
    parentWorkspaceId: string | null
    agentBackend?: AgentBackendId
    /** 같은 프롬프트를 후보 여럿에게 뿌리는 모드로 연다. */
    fanout?: boolean
  } | null>(null)
  const [configRepoId, setConfigRepoId] = useState<string | null>(null)
  const [migrateFor, setMigrateFor] = useState<{ repoId: string | null } | null>(null)
  // ⌘K 퀵 스위처. ⌘1–9 로 닿지 않는(10번째 이후) 워크스페이스로 이동하는 기본 경로다.
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  // ⇧⌘K 대화 검색. ⌘K 가 "이름으로 이동" 이라면 이쪽은 "내용으로 찾기" 다.
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false)
  // 설정의 "Take a tour" 로 여는 기능 투어. 실제 화면 위에서 진행하도록 앱 레벨에서 렌더한다.
  const [tourOpen, setTourOpen] = useState(false)
  const [reviewStartOpen, setReviewStartOpen] = useState(false)
  const [issueRepoId, setIssueRepoId] = useState<string | null>(null)
  const [prRepoId, setPrRepoId] = useState<string | null>(null)
  // ⇧⌘O 파일 퀵 오픈. 큰 파일 뷰어의 "주소창" 역할을 겸한다.
  const [quickOpenFile, setQuickOpenFile] = useState(false)
  const activeReviewId = useStore((s) => s.activeReviewId)
  const activeFanoutGroupId = useStore((s) => s.activeFanoutGroupId)
  const activeStackWorkspaceId = useStore((s) => s.activeStackWorkspaceId)
  const fileViewer = useStore((s) => s.fileViewer)

  // 업데이트로 새로 생긴 기능을 한 번만 알려 준다(신규 설치 사용자에게는 뜨지 않는다).
  useFeatureNudge()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onOpenLogin = (e: Event): void => {
      setLoginBackend((e as CustomEvent<AgentBackendId>).detail)
    }
    window.addEventListener('wooi:open-login', onOpenLogin)
    return () => window.removeEventListener('wooi:open-login', onOpenLogin)
  }, [])

  // 파일 퀵 오픈은 대상 워크스페이스가 있어야 뜻이 있다 — Overview 로 빠지면 닫는다
  // (열린 채로 남으면 렌더되지 않으면서 전역 단축키만 계속 막는다).
  useEffect(() => {
    if (!selectedId) setQuickOpenFile(false)
  }, [selectedId])

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

  // gh(GitHub CLI)는 하드 게이트가 아니다 — 없어도 리포 연결·워크스페이스 생성·에이전트 실행 등
  // git 만으로 되는 일은 전부 할 수 있고, PR·스택처럼 gh 가 실제로 필요한 액션을 누른 순간에만
  // 연결 모달(GithubConnectModal)이 뜬다. 연결이 끝나면 원래 하려던 액션이 이어서 실행된다.
  const githubGateOpen = useStore((s) => s.githubGate !== null)

  const anyModalOpen =
    showSettings ||
    loginBackend !== null ||
    showShortcuts ||
    quickSwitchOpen ||
    transcriptSearchOpen ||
    newWs !== null ||
    configRepoId !== null ||
    migrateFor !== null ||
    onboardingOpen ||
    githubGateOpen ||
    tourOpen ||
    reviewStartOpen ||
    issueRepoId !== null ||
    prRepoId !== null ||
    quickOpenFile

  // 큰 파일 뷰어가 실제로 화면에 떠 있는지 — 리뷰 화면에 들어가 있으면 가려지므로 아니다.
  const fileViewerVisible =
    !activeReviewId && !activeFanoutGroupId && !!fileViewer && fileViewer.workspaceId === selectedId

  // 모달 상태는 여기(App)에만 있으므로, 대화 화면의 전역 키 핸들러(Composer 의 Esc 등)가
  // 볼 수 있도록 store 로 내보낸다 — 모달이 떠 있을 때 뒤쪽 단축키가 같이 발동하면 안 된다.
  //
  // 파일 뷰어도 같은 이유로 포함한다(Esc·⌘F 를 뷰어가 가져간다). 다만 아래 전역 단축키
  // 핸들러는 뷰어를 막지 않는다 — 워크스페이스 전환(⌘1–9·⌘K)은 뷰어 위에서도 되어야 하고,
  // 전환하면 store 가 뷰어를 알아서 닫는다.
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  useEffect(() => {
    setOverlayOpen(anyModalOpen || fileViewerVisible)
  }, [anyModalOpen, fileViewerVisible, setOverlayOpen])

  // '?' 키(어디서든, 단 입력 중이 아닐 때)로 단축키 도움말을 연다. Overview 등에서
  // 커스텀 이벤트로도 열 수 있다.
  useEffect(() => {
    const onHelp = (): void => setShowShortcuts(true)
    const onReview = (): void => setReviewStartOpen(true)
    const onQuickOpen = (): void => setQuickOpenFile(true)
    window.addEventListener('wooi:open-shortcuts', onHelp)
    window.addEventListener('wooi:open-pr-review', onReview)
    window.addEventListener(OPEN_FILE_QUICK_OPEN_EVENT, onQuickOpen)
    return () => {
      window.removeEventListener('wooi:open-shortcuts', onHelp)
      window.removeEventListener('wooi:open-pr-review', onReview)
      window.removeEventListener(OPEN_FILE_QUICK_OPEN_EVENT, onQuickOpen)
    }
  }, [])

  // 리포 설정 모달은 사이드바 톱니 말고도 여러 곳(토스트 액션·스크립트 패널·⌘K·설정)에서
  // 열린다. 그 전부에 콜백을 꿰는 대신 커스텀 이벤트 한 곳으로 받는다.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const repoId = (e as CustomEvent<string>).detail
      if (repoId) setConfigRepoId(repoId)
    }
    window.addEventListener(OPEN_REPO_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_REPO_SETTINGS_EVENT, onOpen)
  }, [])

  // 옮겨오기 모달도 같은 이유로 이벤트로 받는다 — 사이드바 빈 화면과 설정 양쪽에서 연다.
  useEffect(() => {
    const onOpen = (e: Event): void =>
      setMigrateFor({ repoId: (e as CustomEvent<string | null>).detail ?? null })
    window.addEventListener(OPEN_MIGRATE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_MIGRATE_EVENT, onOpen)
  }, [])

  // 키보드: ⇧⇥ 권한 모드 순환, ⌘1–9 워크스페이스 선택, ⌘↑ / ⌘↓ 이전/다음,
  // ⌘L 메시지 입력창 포커스, ⌘[ 직전에 보던 워크스페이스로 뒤로가기, ⇧⌘R PR 리뷰 시작.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      // 모달이나 confirm 대화상자가 떠 있으면 전역 단축키를 막는다.
      if (anyModalOpen || st.confirmState) return

      // 아카이브된 워크스페이스를 읽기 전용으로 보고 있다면 worktree 가 필요한 단축키는 대상이
      // 없다(⇧⌘E/F/D/S/O·⇧⌘⌫·⌘L·타이핑 리다이렉트). 판정은 한 곳에서 내리고 아래에서 나눠 쓴다.
      const surfaces = workspaceSurfaces(
        !!archivedPreviewTarget(st.app?.workspaces, st.selectedWorkspaceId)
      )

      // 입력창/텍스트영역에 포커스가 있으면 글자 입력·텍스트 편집이 우선이다.
      const typing = (): boolean => {
        const el = document.activeElement as HTMLElement | null
        return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      }

      // ⇧⇥ 만 받는다 — ⌃⇥ 계열은 터미널 탭 전환이라 권한 모드를 건드리면 안 된다.
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ws = st.app?.workspaces.find((w) => w.id === st.selectedWorkspaceId)
        if (!ws) return
        // 순환 목록은 그 워크스페이스의 백엔드가 정한다(Claude 와 Codex 는 모드가 서로 다르다).
        // 카탈로그를 아직 못 읽었으면 바꿀 근거가 없으므로 조용히 무시한다.
        const modes = st.backends.find((b) => b.id === ws.agentBackend)?.permissionModes
        if (!modes?.length) return
        e.preventDefault()
        void window.api.workspace.setPermissionMode(
          ws.id,
          nextPermissionMode(modes, ws.permissionMode)
        )
        return
      }

      // '?' — 단축키 도움말. 입력창/텍스트영역에 포커스가 있으면 무시(글자 입력을 방해하지 않게).
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!typing()) {
          e.preventDefault()
          setShowShortcuts(true)
          return
        }
      }

      // ⌃O — 열려 있는 대화의 도구 결과를 한꺼번에 펼치거나 접는다(Claude Code 의 ctrl+o 와 같은 키).
      // 설정이 아니라 그때그때의 상태라, 지금 보고 있는 워크스페이스에만 걸린다.
      if (e.code === 'KeyO' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (typing() || !st.selectedWorkspaceId) return
        e.preventDefault()
        st.toggleToolVerbose(st.selectedWorkspaceId)
        return
      }

      // 대화를 읽다가 지시를 이어 칠 때 손이 끊기지 않게 한다 — 아무 데나 친 글자가 그대로
      // 입력창 caret 에 들어가고 포커스가 따라간다. ⌘L 을 "먼저" 누르는 박자를 없애는 것이지
      // 대체하는 것은 아니다. 가려짐 판정은 ⌘L 과 같은 것을 쓴다(아래 참조).
      // '?'·⌃O 같은 기존 단축키가 위에서 먼저 return 하므로 그 키들은 여기까지 오지 않는다.
      if (surfaces.composer && chatComposerReachable(st, fileViewerVisible)) {
        if (shouldFocusComposerFromEditingKey(e)) {
          // 기본 동작까지 막아야 한다 — 막지 않으면 이 핸들러가 옮겨 놓은 포커스 위에서
          // Backspace 가 그대로 실행돼, 보이지도 않는 초안의 마지막 글자가 지워진다.
          e.preventDefault()
          window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT))
          return
        }
        if (shouldRedirectTyping(e)) {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent(INSERT_INTO_COMPOSER_EVENT, { detail: e.key }))
          return
        }
      }

      if (!e.metaKey) return

      // ⌘L: 현재 워크스페이스의 메시지 입력창으로 돌아간다. 브라우저의 주소창과 같은
      // "입력을 시작할 곳" 역할이라 기억하기 쉽고, 기존 Wooi 단축키와도 겹치지 않는다.
      // 대화가 다른 화면에 가려졌다면 뒤쪽 textarea 를 몰래 포커스하지 않는다.
      if (e.code === 'KeyL' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (
          surfaces.composer &&
          st.selectedWorkspaceId &&
          !st.activeReviewId &&
          !st.activeFanoutGroupId &&
          !st.activeStackWorkspaceId &&
          !fileViewerVisible
        ) {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT))
        }
        return
      }

      // ⌘Z: 가장 최근 워크스페이스 생성 또는 병합 PR 일괄 아카이브를 되돌린다.
      // 글을 쓰는 중이라면 텍스트 실행취소가 우선이므로 그냥 양보한다 — preventDefault 를
      // 하지 않아야 기본 Edit ▸ Undo 가 그대로 동작한다.
      if (e.code === 'KeyZ' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (typing()) return
        e.preventDefault()
        void st.undoLastWorkspaceAction()
        return
      }

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

      // ⇧⌘R: PR 리뷰 시작 모달. 리뷰는 워크스페이스를 고르지 않은 상태(Overview)에서도, 다른
      // 리뷰를 보는 중에도 시작할 수 있어야 하므로 아래 selId 게이트 바깥에 둔다.
      if (e.shiftKey && e.code === 'KeyR' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        // 리포가 하나도 없으면 고를 PR 도 없다 — ⌘N 과 같은 안내를 준다.
        if (!st.app?.repos.length) {
          st.pushToast('info', 'Add a repository first.')
          return
        }
        setReviewStartOpen(true)
        return
      }

      // ⇧⌘L: 스택 화면. 고른 워크스페이스가 속한 스택을 통째로 편다. 스택이 아니면 열 지도가
      // 없으므로 왜 안 열리는지 말해 준다 — 조용히 무시하면 단축키가 고장 난 것처럼 보인다.
      if (e.code === 'KeyL' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const anchorId = st.selectedWorkspaceId
        if (!anchorId) {
          st.pushToast('info', 'Pick a workspace in a stack first.')
          return
        }
        if (buildStackLayers(st.app?.workspaces ?? [], anchorId).length < 2) {
          st.pushToast('info', 'This workspace is not stacked on anything.')
          return
        }
        st.openStackView(anchorId)
        return
      }

      // ⇧⌘K: 대화 검색 — 워크스페이스를 가로질러 대화 **내용**을 찾는다(⌘K 는 이름으로 이동).
      // 디스크를 훑는 비동기 검색이라 즉답이 생명인 퀵 스위처와 한 글쇠 차이로 갈라 뒀다.
      if (e.code === 'KeyK' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setTranscriptSearchOpen(true)
        return
      }

      // ⌘K: 퀵 스위처. ⌘1–9 는 앞 9개까지만 닿으므로, 그 뒤 워크스페이스는 여기서 검색해 이동한다.
      // 키 판별은 e.code 로 한다 — 한글 IME 에서 e.key 가 'k' 가 아닐 수 있다.
      if (e.code === 'KeyK' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        // 워크스페이스가 아직 없어도 리포가 있으면 연다 — 팔레트가 리포 설정 항목도 담고 있어
        // 이 시점에 오히려 가장 쓸모 있다(막 리포만 추가한 직후).
        if (st.app?.workspaces.some((w) => !w.archived) || st.app?.repos.length) {
          setQuickSwitchOpen(true)
        }
        return
      }

      // ⌘,: 설정 열기(macOS 표준 Preferences 단축키).
      if (e.code === 'Comma' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setShowSettings(true)
        return
      }

      // ⌘N: 기본 에이전트로 즉시 생성. ⇧⌘N: 같은 repo의 + 메뉴를 열어 에이전트를 고른다.
      if (e.code === 'KeyN' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const repoId =
          st.app?.workspaces.find((w) => w.id === st.selectedWorkspaceId)?.repoId ??
          st.app?.repos[0]?.id
        if (!repoId) {
          st.pushToast('info', 'Add a repository first.')
          return
        }
        if (e.shiftKey) {
          openNewWorkspaceMenu(repoId)
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

      // fan-out 비교 화면이 떠 있으면 헤더 도구의 대상이 화면에 없다 — 뒤에 가려진 워크스페이스를
      // 에디터에서 열거나 아카이브하면, 사용자는 자기가 무엇을 건드렸는지 알 수 없다.
      // 워크스페이스 전환(⌘1–9·⌘K·⌘↑↓)은 아래에서 계속 받는다 — 그게 이 화면에서 나가는 길이다.
      if (st.activeFanoutGroupId && (e.shiftKey || e.altKey || e.ctrlKey)) return

      // 우상단 헤더 도구 단축키 — 현재 선택된 workspace 를 대상으로 한다.
      // ⇧⌘ 조합이라 macOS 기본 단축키(⌘S/E/F, ⌘⌫ 등)나 앱 기존 단축키와 충돌하지 않는다.
      const selId = surfaces.worktreeTools ? st.selectedWorkspaceId : null

      // dev 스크립트 실행/중지 — 스크립트 패널 열림 여부와 무관하게 동작한다.
      // ⇧⌘D 와 (구) ⌃⌘R 둘 다 여기로 들어온다.
      const toggleDevScript = (id: string): void => {
        const ws = st.app?.workspaces.find((w) => w.id === id)
        const primary = ws && st.app?.repos.find((r) => r.id === ws.repoId)?.runScripts[0]
        if (!primary?.command.trim()) {
          // 여기까지 온 사용자는 이미 "dev 명령을 쓰고 싶다"고 손을 든 상태다. 설정이 어디
          // 있는지 말로만 알려 주고 끝내지 말고, 바로 그 화면으로 데려간다.
          st.pushToast('info', 'Add a run script for this repository first.', [
            { label: 'Open repository settings', run: () => ws && openRepoSettings(ws.repoId) }
          ])
          return
        }
        const devRunning = (st.scriptStatus[id] ?? []).some(
          (s) => s.scriptId === primary.id && s.state === 'running'
        )
        if (devRunning) {
          void window.api.script.stop(id, primary.id).then(() => st.refreshScriptStatus(id))
        } else {
          // 실행 시 스크립트 패널(dev 탭)을 열어 로그·상태를 바로 볼 수 있게 한다.
          st.setScriptPanelOpen(id, true)
          void window.api.script.run(id, primary.id).then(() => st.refreshScriptStatus(id))
        }
      }

      // 리뷰 화면이 떠 있으면 헤더 도구의 대상은 뒤에 가려진 워크스페이스가 아니라 리뷰다
      // (리뷰를 열어도 selectedWorkspaceId 는 그대로 남는다). 아카이브만 리뷰에 대응하는
      // 동작이 있고, 나머지 ⇧⌘ 도구는 엉뚱한 워크스페이스를 건드리지 않도록 여기서 끊는다.
      if (st.activeReviewId && e.shiftKey) {
        // ⇧⌘⌫: 리뷰 아카이브 — 사이드바의 아카이브 버튼과 같은 경로(확인 후 워크트리만 정리).
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          void st.requestArchiveReview(st.activeReviewId)
        }
        return
      }

      // ⌥⌘⌫: workspace 영구 삭제. 아카이브(⇧⌘⌫)와 한 글쇠 차이지만 결과는 되돌릴 수 없으므로,
      // ⌥ 를 요구해 손이 미끄러져 눌리지 않게 하고 삭제 확인도 반드시 거친다(store 가 처리).
      // 리뷰 화면이 떠 있으면 대상이 되는 워크스페이스가 화면에 없으니 받지 않는다.
      if (selId && !st.activeReviewId && e.altKey && !e.shiftKey && !e.ctrlKey) {
        if (e.code === 'Backspace' || e.code === 'Delete') {
          e.preventDefault()
          void st.requestDeleteWorkspace(selId)
          return
        }
      }

      // ⇧⌘T: 방금 아카이브한 워크스페이스를 다시 연다(브라우저의 "닫은 탭 다시 열기").
      // 아카이브 직후에는 Overview 로 빠져나와 선택이 없으므로, selId 를 요구하는 아래
      // ⇧⌘ 블록보다 앞에 둔다. 되살리는 대상은 아카이브뿐이다 — 영구 삭제는 되돌리지 않는다.
      if (e.shiftKey && e.code === 'KeyT' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void st.reopenLastArchivedWorkspace()
        return
      }

      // 키 판별은 e.code 로 한다 — 한글 IME 등에서 e.key 가 문자가 아닐 수 있다.
      if (selId && e.shiftKey) {
        // ⇧⌘D: dev 스크립트 실행/중지. 다른 헤더 도구 단축키와 같은 ⇧⌘ 계열로 맞췄다.
        if (e.code === 'KeyD') {
          e.preventDefault()
          toggleDevScript(selId)
          return
        }
        // ⇧⌘S: 스크립트 패널 열기/닫기. 별도 창으로 떼어 뒀다면 이미 열려 있는 셈이므로
        // 그 창을 앞으로 가져온다(다른 모니터에 있는 창을 찾아 주는 편이 사용자가 원한 결과다).
        if (e.code === 'KeyS') {
          e.preventDefault()
          if (st.detachedPanes.scripts) void window.api.pane.focus('scripts')
          else st.setScriptPanelOpen(selId, !(st.scriptPanelOpen[selId] ?? false))
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
        // ⇧⌘O: 파일 퀵 오픈 — 고르면 대화창 위의 큰 파일 뷰어로 열린다.
        if (e.code === 'KeyO') {
          e.preventDefault()
          openFileQuickOpen()
          return
        }
        // ⇧⌘X: 대화 내보내기 메뉴 열기(ExportMenu 가 이벤트를 받아 드롭다운을 연다).
        if (e.code === 'KeyX') {
          e.preventDefault()
          window.dispatchEvent(
            new CustomEvent<ExportConversationDetail>('wooi:export-conversation', {
              detail: { workspaceId: selId }
            })
          )
          return
        }
        // ⇧⌘⌫: workspace 아카이브(ChatView 가 확인 다이얼로그와 함께 처리).
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('wooi:archive-workspace', { detail: selId }))
          return
        }
      }

      // ⌃⌘R: ⇧⌘D 이전에 쓰던 dev 단축키. 손에 익은 사용자를 위해 당분간 함께 유지한다.
      // 키 판별은 e.code('KeyR')로 한다 — 한글 IME·Control 조합에서 e.key 가 'r' 이 아닐 수 있다.
      if (selId && e.ctrlKey && e.code === 'KeyR') {
        e.preventDefault()
        toggleDevScript(selId)
        return
      }

      // ⌘[: 직전에 보던 워크스페이스로 돌아간다(브라우저 뒤로가기와 같은 방문 기록 기반).
      // 사이드바 순서상 앞/뒤로 옮기는 ⌘↑ / ⌘↓ 와는 다른 축이다. 목록이 비어 있어도
      // 기록이 남아 있을 수 있으므로 아래 list 게이트보다 앞에 둔다.
      if (e.key === '[' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void st.goBackWorkspace()
        return
      }

      // ⌘]: ⌘[ 로 물러난 길을 되짚어 앞으로 간다. 뒤로만 갈 수 있으면 잘못 누른 ⌘[ 를
      // 되돌릴 방법이 없다 — 짝이 있어야 방문 기록을 오갈 수 있다.
      if (e.key === ']' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void st.goForwardWorkspace()
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
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey) {
        // ⌘↑/⌘↓ 로 사이드바 순서를 위/아래로 훑는다. 세로 목록이라 방향키가 공간적으로
        // 직관적이고, 괄호 키와 달리 키보드 레이아웃을 타지 않는다. 별칭이던 ⌘[ / ⌘] 는
        // 뺐다 — 그 짝은 이제 목록 위치가 아니라 방문 기록을 오가는 뒤로/앞으로가기다.
        // (Composer 의 ↑/↓ 메시지 히스토리는 ⌘ 없는 경우만 처리하도록 막아 뒀다.)
        e.preventDefault()
        const cur = list.findIndex((w) => w.id === st.selectedWorkspaceId)
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const next = cur < 0 ? 0 : (cur + delta + list.length) % list.length
        void st.selectWorkspace(list[next].id)
        // 단축키를 쓸 줄 아는 사용자에게 안내 힌트는 소음이다 — 첫 사용 시점에 영구히 끈다.
        finishSwitchHint()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anyModalOpen, fileViewerVisible])

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
  // 아카이브된 워크스페이스를 골랐으면 읽기 전용 미리보기를 연다 — 되살릴지 판단하려면 안을
  // 봐야 하는데, 지금까지는 되살리는 것이 안을 보는 유일한 길이었다.
  const archivedPreview = archivedPreviewTarget(app.workspaces, selectedId)
  // 에이전트가 **하나도** 연결되지 않았을 때만 경고한다 — Claude 만, 또는 Codex 만 가진 사용자도
  // 정상 사용자이므로 한쪽이 없다는 이유로 배너를 띄우면 안 된다.
  const noAgentConnected = app.settings.onboarded && authStatus !== null && !hasAnyAgent(authStatus)

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

  // 새 workspace 만들기: 수동 설정일 때만 생성 모달을 연다. Solo/팀은 여기서 묻지 않는다 —
  // 새 워크스페이스는 언제나 Solo 로 시작하고, 무엇을 위임할 만한지는 만드는 순간이 아니라
  // 대화 중에 드러난다. 켜는 길은 그때 헤더 배지·사이드바 메뉴·switch_to_agent_team 으로 열려 있다.
  // 자동 생성은 사이드바에 스피너 행을 바로 띄우고 worktree 준비는 백그라운드로 진행한다.
  //
  // agentBackend 는 사이드바의 에이전트 선택에서 온다(에이전트가 둘 이상일 때만). 생략하면
  // main 이 전역 기본 백엔드를 쓴다 — ⌘N 은 그래서 묻지 않고 바로 만든다.
  const handleNewWorkspace = (repoId: string, agentBackend?: AgentBackendId): void => {
    if (app.settings.manualWorkspaceSetup) {
      setNewWs({ repoId, parentWorkspaceId: null, agentBackend })
      return
    }
    void useStore.getState().createWorkspace(repoId, { agentBackend })
  }

  // fan-out: 같은 프롬프트를 후보 여럿에게 동시에 던진다. 프롬프트를 반드시 받아야 하므로
  // manualWorkspaceSetup 과 무관하게 늘 모달을 연다 — 물어볼 것이 있는 생성 경로다.
  const handleFanout = (repoId: string, agentBackend?: AgentBackendId): void => {
    setNewWs({ repoId, parentWorkspaceId: null, agentBackend, fanout: true })
  }

  // stacked PR: 특정 워크스페이스 위에 새 워크스페이스를 쌓는다(base = 부모 브랜치).
  const handleStackWorkspace = (
    repoId: string,
    parentWorkspaceId: string,
    agentBackend?: AgentBackendId
  ): void => {
    if (app.settings.manualWorkspaceSetup) {
      setNewWs({ repoId, parentWorkspaceId })
      return
    }
    void useStore.getState().createWorkspace(repoId, { parentWorkspaceId, agentBackend })
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      <TitleBar onOpenSettings={() => setShowSettings(true)} />

      <NoticeBanner />

      <UpdateBanner />

      {noAgentConnected && (
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
        {/* 사이드바는 리뷰 중에도 그대로 둔다 — 리뷰는 워크스페이스와 병행하는 작업이고,
            사이드바가 그 둘을 오가는 유일한 통로다. */}
        <Sidebar
          width={sidebarWidth}
          onNewWorkspace={handleNewWorkspace}
          onNewFromIssue={setIssueRepoId}
          onNewFromPr={setPrRepoId}
          onFanout={handleFanout}
          onStackWorkspace={handleStackWorkspace}
          onOpenQuickSwitch={() => setQuickSwitchOpen(true)}
        />
        <Splitter
          axis="x"
          label="Resize sidebar"
          onStart={() => (sidebarBase.current = useStore.getState().sidebarWidth)}
          onDelta={(dx) => setSidebarWidth(sidebarBase.current + dx)}
          onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        />
        {/* relative — 큰 파일 뷰어가 이 영역(대화 + 작업 패널)만 덮는 오버레이로 올라탄다. */}
        <div
          ref={contentRef}
          className="relative flex-1 min-w-0 border-l border-[var(--border)] flex"
        >
          {activeFanoutGroupId ? (
            <FanoutCompareScreen key={activeFanoutGroupId} groupId={activeFanoutGroupId} />
          ) : activeReviewId ? (
            <PrReviewScreen key={activeReviewId} reviewId={activeReviewId} />
          ) : activeStackWorkspaceId ? (
            <StackScreen key={activeStackWorkspaceId} workspaceId={activeStackWorkspaceId} />
          ) : selected ? (
            <>
              <div data-tour="chat" className="flex-1 min-w-0">
                <ChatView key={selected.id} workspace={selected} />
              </div>
              {rightPanelOpen && !workPaneDetached && (
                <>
                  <Splitter
                    axis="x"
                    label="Resize work panel"
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
          ) : archivedPreview ? (
            <div className="flex-1 min-w-0">
              <ArchivedChatView key={archivedPreview.id} workspace={archivedPreview} />
            </div>
          ) : app.workspaces.some((w) => !w.archived) ? (
            <Overview />
          ) : (
            <EmptyState />
          )}

          {/* 대화 위에 띄우는 큰 파일 뷰어. 대화·작업 패널은 뒤에 그대로 마운트돼 있어
              닫으면 스크롤 위치와 입력창 초안이 그대로 살아 있다. */}
          {selected && fileViewerVisible && <FileViewerOverlay workspace={selected} />}
        </div>
      </div>

      {(needsConsent || needsOnboarding || needsDefaults) && (
        <OnboardingModal
          needsConsent={needsConsent}
          needsOnboarding={needsOnboarding}
          needsDefaults={needsDefaults}
        />
      )}
      {githubGateOpen && <GithubConnectModal />}
      {reviewStartOpen && <PrReviewStartModal onClose={() => setReviewStartOpen(false)} />}
      {issueRepoId && (
        <NewFromIssueModal repoId={issueRepoId} onClose={() => setIssueRepoId(null)} />
      )}
      {prRepoId && <NewFromPrModal repoId={prRepoId} onClose={() => setPrRepoId(null)} />}
      {migrateFor && (
        <MigrateModal repoId={migrateFor.repoId} onClose={() => setMigrateFor(null)} />
      )}
      {showSettings && (
        // 설정은 백엔드 카탈로그·인증 상태 등 바깥에서 들어오는 값을 많이 읽는다. 그중 하나가
        // 깨져도 앱 전체가 날아가지 않도록 이 서브트리만 격리한다.
        <ErrorBoundary label="Settings">
          <SettingsModal
            onClose={() => setShowSettings(false)}
            onStartTour={() => {
              setShowSettings(false)
              setTourOpen(true)
            }}
          />
        </ErrorBoundary>
      )}
      {tourOpen && <FeatureTour onDone={() => setTourOpen(false)} />}
      {loginBackend === 'claude' && <ClaudeLoginModal onClose={() => setLoginBackend(null)} />}
      {loginBackend === 'codex' && <CodexLoginModal onClose={() => setLoginBackend(null)} />}
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
      {quickSwitchOpen && <QuickSwitcher onClose={() => setQuickSwitchOpen(false)} />}
      {transcriptSearchOpen && <TranscriptSearch onClose={() => setTranscriptSearchOpen(false)} />}
      {quickOpenFile && selected && (
        <FileQuickOpen workspaceId={selected.id} onClose={() => setQuickOpenFile(false)} />
      )}
      {newWs && (
        <NewWorkspaceModal
          repoId={newWs.repoId}
          parentWorkspaceId={newWs.parentWorkspaceId}
          initialAgentBackend={newWs.agentBackend}
          fanout={newWs.fanout}
          onClose={() => setNewWs(null)}
        />
      )}
      {configRepoId && (
        <RepoConfigModal repoId={configRepoId} onClose={() => setConfigRepoId(null)} />
      )}

      {/* 점진적 힌트 호스트는 앱 전체에 하나만, 항상 마운트해 둔다(lib/hints.ts). 모달이 하나라도
          떠 있으면(설정·투어·퀵스위처… 온보딩도 anyModalOpen 안에 포함된다) 뭘 가리키든 그
          모달 뒤에 깔려 안 보이므로 렌더를 꺼야 하지만, **마운트 자체는 건드리지 않는다** —
          Settings 를 열었다 닫을 때마다 리마운트되면 세션 카운터(이번 세션에 몇 개를 소개했는지)
          가 그때마다 리셋된다. 대신 anyModalOpen 을 prop 으로 넘겨 Hint 내부에서 렌더만 끈다. */}
      <Hint anyModalOpen={anyModalOpen} />

      <Toaster />
      <ConfirmDialog />
    </div>
  )
}
