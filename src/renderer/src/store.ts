import { create } from 'zustand'
import type {
  AppState,
  AuthStatus,
  CarryFailure,
  ChatEnvelope,
  ChatItem,
  GitStatus,
  ImageAttachment,
  PermissionRequest,
  PrStatus,
  ScriptKind,
  ScriptStatus,
  StackCascadeResult,
  UpdateStatus,
  Workspace
} from '@shared/types'
import type { NotificationChannel, NotificationEvent } from '@shared/types'
import { cascadeProblems } from '@shared/types'
import { playNotification } from './lib/sound'

export const scriptKey = (workspaceId: string, kind: ScriptKind): string => `${workspaceId}:${kind}`

/**
 * 특정 워크스페이스에서 (event, channel) 알림이 켜져 있는지. 워크스페이스가 음소거면 항상 false.
 * 알림 설정이 아직 없으면(초기화 전) 보수적으로 false.
 */
function notifyEnabled(
  s: UIState,
  workspaceId: string,
  event: NotificationEvent,
  channel: NotificationChannel
): boolean {
  const w = s.app?.workspaces.find((x) => x.id === workspaceId)
  if (w?.muted) return false
  return !!s.app?.settings.notifications?.[event]?.[channel]
}

/** 실행 중 대기 큐에 보관되는 후속 메시지(텍스트 + 선택적 이미지 첨부). */
export interface QueuedMessage {
  text: string
  images?: ImageAttachment[]
}

/** 컨텍스트 윈도 사용량 스냅샷(마지막 턴). percentage 는 0~1. */
export interface ContextUsage {
  usedTokens: number
  maxTokens: number
  percentage: number
}

export type ToastKind = 'info' | 'success' | 'error'
/** 토스트에 붙는 인라인 액션 버튼(예: "Retry"). 클릭하면 run 실행 후 토스트가 닫힌다. */
export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** 있으면 메시지 아래 버튼으로 렌더된다. 액션이 있으면 자동으로 사라지지 않는다. */
  actions?: ToastAction[]
}

/** 생성 중(아직 worktree 준비 전)인 workspace 의 사이드바 자리표시 행. 영속되지 않는 렌더러 전용 상태. */
export interface PendingWorkspace {
  id: string
  repoId: string
  /** 사용자가 입력한 이름. 자동 생성 모드면 빈 문자열(행에는 "Creating…" 만 표시). */
  name: string
}

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
}
interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

let toastSeq = 0
let pendingSeq = 0

/**
 * 우측 작업 패널의 펼침/접힘 상태를 실행 간에 기억하기 위한 localStorage 키.
 * 권위 있는 기본값은 settings.defaultRightPanelOpen 이지만, 사용자가 한 번이라도 토글하면
 * 그 마지막 상태를 여기 캐시해 다음 실행에서 복원한다(테마 캐시와 같은 방식).
 */
const RIGHT_PANEL_KEY = 'wooi.rightPanelOpen'

/** 기억된 패널 상태를 읽는다. 토글한 적이 없으면(키 없음) null 을 돌려 기본값으로 폴백하게 한다. */
function readRememberedRightPanel(): boolean | null {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY)
    if (v === 'true') return true
    if (v === 'false') return false
  } catch {
    /* private 모드 등에서 실패해도 무시 — 기본값으로 폴백한다. */
  }
  return null
}

/** 현재 패널 상태를 기억해 둔다(다음 실행 복원용). */
function rememberRightPanel(open: boolean): void {
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, String(open))
  } catch {
    /* 무시 — 기억은 편의 기능일 뿐이다. */
  }
}

interface UIState {
  ready: boolean
  app: AppState | null
  selectedWorkspaceId: string | null
  transcripts: Record<string, ChatItem[]>
  loadedTranscripts: Record<string, boolean>
  scriptOutput: Record<string, string>
  scriptStatus: Record<string, ScriptStatus[]>
  gitStatus: Record<string, GitStatus | null>
  prStatus: Record<string, PrStatus | null>
  /** workspace 별 PR 상태 조회 진행 여부(브랜치 전환·새로고침 중 헤더에 로딩 표시). */
  prRefreshing: Record<string, boolean>
  permissions: PermissionRequest[]
  authStatus: AuthStatus | null
  /**
   * gh 연결을 요구하는 액션이 대기 중이면(=연결 모달이 떠 있으면) 그 사유. null 이면 닫힘.
   * gh 는 하드 게이트가 아니라 지연 게이트다 — PR·스택처럼 gh 가 실제로 필요한 액션을 누른
   * 그 순간에만 이 모달이 뜨고, 연결이 끝나면 원래 하려던 액션이 이어서 실행된다.
   */
  githubGate: { reason: string } | null
  /**
   * 자동 업데이트 상태(main 의 evtUpdate). 여러 화면(타이틀바 점, 업데이트 배너, 설정)이
   * 같은 값을 보도록 여기 한 곳에서만 구독한다. 컴포넌트가 늦게 마운트돼도 지나간 방송을
   * 놓치지 않는다.
   */
  updateStatus: UpdateStatus
  /** workspace 별 컨텍스트 윈도 사용량(마지막 턴 기준). 입력창 사용량 미터용. */
  contextUsage: Record<string, ContextUsage>
  /** workspace 별 대화 압축 진행 여부(자동/수동 /compact 진행 중이면 true). */
  compacting: Record<string, boolean>
  /** 응답이 완료됐지만 사용자가 아직 보지 않은 workspace. */
  unread: Record<string, boolean>
  /** workspace 가 실행(running) 상태로 진입한 시각(epoch ms). 경과 시간 표시용. */
  runningSince: Record<string, number>
  /** workspace 전환에도 살아남아야 하는 입력창 초안. */
  drafts: Record<string, string>
  /**
   * 현재 턴이 실행 중일 때 보낸 후속 메시지의 대기 큐(workspace 별, 순서 유지).
   * 백엔드로 즉시 보내지 않고 여기 모았다가, 턴이 끝나면(idle) 순서대로 전송한다.
   * 전송 전이므로 사용자가 취소/수정할 수 있다.
   */
  messageQueue: Record<string, QueuedMessage[]>
  /** workspace 별 대화 스크롤 위치(복원용). */
  scrollPositions: Record<string, number>
  /** workspace 별 스크립트 패널 열림 상태. */
  scriptPanelOpen: Record<string, boolean>
  /** 우측 작업 패널(파일/변경/체크 + 터미널)의 너비(px). 세로 분할 드래그로 조절. */
  rightWidth: number
  /** 우측 작업 패널 표시 여부. 숨기면 대화 영역이 전체 폭을 차지한다. */
  rightPanelOpen: boolean
  /** 우하단 터미널이 우측 컬럼 높이에서 차지하는 비율(0~1). 기본 0.5. 가로 분할 드래그로 조절. */
  terminalRatio: number
  toasts: Toast[]
  confirmState: ConfirmState | null
  /** 생성 중인 workspace 의 자리표시 행(repoId 로 사이드바에 배치). */
  pending: PendingWorkspace[]

  init: () => Promise<void>
  /** worktree 생성을 시작하고, 완료될 때까지 사이드바에 스피너 행을 즉시 띄운다. */
  createWorkspace: (
    repoId: string,
    args?: { name?: string; baseBranch?: string; parentWorkspaceId?: string | null },
    displayName?: string
  ) => Promise<void>
  /** stacked 워크스페이스를 최신 base(부모 브랜치) 위로 rebase·force-push 한다. */
  restackWorkspace: (workspaceId: string) => Promise<void>
  /** 외부 병합으로 대기 중인 스택 캐스케이드를 실행한다(rebase + force-push — 사용자 승인 후). */
  applyStackSync: (workspaceId: string) => Promise<void>
  /** 대기 중인 스택 캐스케이드 계획을 무시한다. */
  dismissStackSync: (workspaceId: string) => Promise<void>
  /** 캐스케이드 단계별 결과를 토스트로 알린다(문제가 있으면 브랜치별로 나열). */
  reportCascade: (cascade: StackCascadeResult, successMsg: string) => void
  selectWorkspace: (id: string | null) => Promise<void>
  /** 아직 로드되지 않았으면 해당 workspace 의 트랜스크립트를 불러온다(대시보드 비용 집계 등에서 사용). */
  ensureHistory: (workspaceId: string) => Promise<void>
  refreshGit: (workspaceId: string) => Promise<void>
  /** 진입 여부와 무관하게 모든(비아카이브) 워크스페이스의 git 상태를 한 번에 갱신한다. */
  refreshAllGit: () => Promise<void>
  refreshPr: (workspaceId: string) => Promise<void>
  /** PR 상태를 즉시(낙관적) 설정한다. 브랜치 전환 시 캐시된 값으로 헤더를 바로 갱신할 때 쓴다. */
  setPrStatus: (workspaceId: string, status: PrStatus | null) => void
  refreshScriptStatus: (workspaceId: string) => Promise<void>
  refreshAuth: () => Promise<void>
  /**
   * gh 가 필요한 액션을 실행한다. 이미 연결돼 있으면 그대로 실행하고, 아니면 연결 모달을 띄운 뒤
   * 연결이 끝나는 즉시 action 을 이어서 수행한다(사용자가 닫으면 그냥 버린다).
   * reason 은 모달에 "왜 지금 연결이 필요한지" 로 노출된다.
   */
  requireGithub: (reason: string, action: () => void | Promise<void>) => Promise<void>
  /** 연결이 확인돼 대기 중이던 액션을 실행하고 모달을 닫는다. */
  resolveGithubGate: () => void
  /** 사용자가 모달을 닫았다 — 대기 중이던 액션은 버린다. */
  dismissGithubGate: () => void
  dismissPermission: (requestId: string) => void
  /**
   * 대기 중인 모든 권한 요청을 한 번에 허용한다(병렬 세션의 권한 피로 완화).
   * AskUserQuestion 은 사용자의 답을 입력에 주입해야 하므로 일괄 승인에서 제외하고 그대로 남긴다.
   */
  approveAllPermissions: () => void
  /** 일괄 승인 가능한(=AskUserQuestion 이 아닌) 대기 권한 수. */
  approvablePermissionCount: () => number
  nextUnreadId: () => string | null
  /** 다른 workspace 중 권한 대기 중인 첫 항목. */
  nextPendingPermissionId: () => string | null
  /** 실행 중인 모든 workspace 의 현재 턴을 중단한다(폭주 시 일괄 정지). */
  stopAll: () => Promise<void>
  /** 실행 중일 때 후속 메시지를 대기 큐에 넣는다(턴 종료 시 자동 전송). */
  enqueueMessage: (workspaceId: string, text: string, images?: ImageAttachment[]) => void
  /** 대기 큐에서 index 번째 메시지를 취소(제거)한다. */
  removeQueued: (workspaceId: string, index: number) => void
  setDraft: (workspaceId: string, text: string) => void
  /** /clear — 해당 workspace 의 대화 기록·컨텍스트 사용량을 화면에서 비운다(맥락 초기화). */
  resetTranscript: (workspaceId: string) => void
  setScrollPosition: (workspaceId: string, top: number) => void
  setScriptPanelOpen: (workspaceId: string, open: boolean) => void
  setRightWidth: (px: number) => void
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setTerminalRatio: (ratio: number) => void
  /** 토스트를 띄우고 그 id 를 반환한다. actions 를 주면 인라인 버튼이 붙고 자동으로 닫히지 않는다. */
  pushToast: (kind: ToastKind, message: string, actions?: ToastAction[]) => string
  dismissToast: (id: string) => void
  /** worktree 전달 실패를 사용자에게 알린다. 에이전트 컨텍스트 실패는 error 로 구분해 띄운다. */
  reportCarryFailures: (failures?: CarryFailure[]) => void
  /** setup 스크립트를 다시 실행한다(스크립트 패널을 함께 연다). 결과는 메인이 setupState 로 영속. */
  retrySetup: (workspaceId: string) => void
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void
}

let initialized = false

// 창 포커스 상태(완료를 미확인으로 잡을지 판단용). DOM 의 document.hasFocus() 는 Dock 클릭·앱
// 전환 시 신뢰할 수 없어, main 의 권위 있는 focus/blur 이벤트로 갱신한다. 시작 시 포커스 가정.
let windowFocused = true

// 모든 워크트리의 git 상태를 주기적으로 갱신하기 위한 타이머. 진입하지 않은 워크스페이스도
// 사이드바 배지(변경 파일 수·ahead/behind·충돌)가 최신으로 보이도록 백그라운드에서 폴링한다.
let statusPollTimer: ReturnType<typeof setInterval> | null = null
const STATUS_POLL_INTERVAL_MS = 15_000

// gh 가 미연결로 보이는 동안에만 도는 인증 상태 폴링. 예전 하드 게이트가 3초마다 돌던 폴링을
// 대체한다 — 게이트가 사라졌다고 폴링까지 없애면, `gh auth status` 가 일시적으로 실패했을 때
// (네트워크 순단·SSO 재인증) PR 조회가 조용히 멈춘 채 창 포커스가 바뀔 때까지 회복되지 않는다.
// 연결돼 있으면 아예 돌지 않으므로 기존 사용자에게 추가 비용이 없다.
let authPollTimer: ReturnType<typeof setInterval> | null = null
const AUTH_POLL_INTERVAL_MS = 30_000

// gh 연결 모달이 닫힐 때까지 붙들어 두는, 사용자가 원래 하려던 액션. 상태에 담지 않는 이유는
// 함수라 비교·직렬화 대상이 아니고, 렌더에 영향을 주지 않기 때문이다.
let pendingGithubAction: (() => void | Promise<void>) | null = null

/** gh(GitHub CLI)가 설치·로그인돼 PR·스택 기능을 쓸 수 있는 상태인가. */
function githubConnected(auth: AuthStatus | null): boolean {
  return !!auth && auth.github.installed && auth.github.loggedIn
}

function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const idx = items.findIndex((i) => i.id === item.id)
  if (idx === -1) return [...items, item]
  const next = items.slice()
  next[idx] = item
  return next
}

export const useStore = create<UIState>((set, get) => ({
  ready: false,
  app: null,
  selectedWorkspaceId: null,
  transcripts: {},
  loadedTranscripts: {},
  scriptOutput: {},
  scriptStatus: {},
  gitStatus: {},
  prStatus: {},
  prRefreshing: {},
  permissions: [],
  authStatus: null,
  githubGate: null,
  updateStatus: { state: 'idle' },
  contextUsage: {},
  compacting: {},
  unread: {},
  runningSince: {},
  drafts: {},
  messageQueue: {},
  scrollPositions: {},
  scriptPanelOpen: {},
  rightWidth: 460,
  rightPanelOpen: true,
  terminalRatio: 0.5,
  toasts: [],
  confirmState: null,
  pending: [],

  init: async () => {
    if (initialized) return
    initialized = true

    const app = await window.api.getState()
    // 재시작 시점에 이미 running 인 워크스페이스는 진입 시각을 알 수 없으므로 현재 시각으로 근사한다.
    const seededRunningSince: Record<string, number> = {}
    const startedAt = Date.now()
    for (const w of app.workspaces) {
      if (!w.archived && w.status === 'running') seededRunningSince[w.id] = startedAt
    }
    // 우측 패널: 기억된 상태가 있으면 복원하고, 없으면(처음 실행) 설정의 기본값을 따른다.
    const remembered = readRememberedRightPanel()
    const rightPanelOpen = remembered ?? app.settings.defaultRightPanelOpen
    set({ app, ready: true, runningSince: seededRunningSince, rightPanelOpen })
    void get().refreshAuth()

    // 최초 진입 시 모든 워크트리의 git 상태를 한 번 받아오고(진입 전에도 사이드바에 노출),
    // 이후 일정 간격으로 폴링해 백그라운드에서 변한 변경 파일 수·ahead/behind 를 최신으로 유지한다.
    void get().refreshAllGit()
    if (!statusPollTimer) {
      statusPollTimer = setInterval(() => {
        // 창이 가려져 사이드바가 보이지 않을 때는 폴링을 건너뛰고(불필요한 git 프로세스 방지),
        // 다시 포커스되는 순간 onWindowFocus 에서 즉시 한 번 갱신한다.
        if (windowFocused) void get().refreshAllGit()
      }, STATUS_POLL_INTERVAL_MS)
    }

    // gh 미연결로 보이는 동안에만 인증 상태를 다시 확인한다. 앱 밖(터미널)에서 로그인한 경우와
    // `gh auth status` 가 일시적으로 실패했다가 회복된 경우를 모두 스스로 따라잡는다.
    if (!authPollTimer) {
      authPollTimer = setInterval(() => {
        if (!windowFocused) return
        if (githubConnected(get().authStatus)) return
        void get().refreshAuth()
      }, AUTH_POLL_INTERVAL_MS)
    }

    // git 상태와 마찬가지로, 최초 진입 시 모든 활성 workspace 의 PR 상태도 미리 갱신한다.
    // 그러지 않으면 prStatus 가 비어 있어, 해당 세션에 직접 들어가 selectWorkspace 의
    // refreshPr 가 실행되기 전까지 사이드바에 PR 칩이 뜨지 않는다.
    for (const w of app.workspaces) {
      if (!w.archived) void get().refreshPr(w.id)
    }

    // 패널을 토글할 때마다(키보드 ⌘J·버튼·Composer 등 경로 무관) 마지막 상태를 기억해 둔다.
    useStore.subscribe((state, prev) => {
      if (state.rightPanelOpen !== prev.rightPanelOpen) rememberRightPanel(state.rightPanelOpen)
    })

    // gh 가 연결되는 순간(미연결 → 연결) PR 상태를 한 번 훑어 헤더·사이드바의 PR 칩을 즉시 살린다.
    // 미연결 동안에는 PR 조회가 조용히 no-op 이라 캐시가 전부 null 로 남아 있기 때문이다.
    // 반대로 연결이 끊기면(로그아웃·삭제) 캐시를 비워 미연결 UI 로 되돌린다.
    useStore.subscribe((state, prev) => {
      // 최초 로드(null → 값)는 위에서 이미 전체 갱신을 돌렸으므로 건너뛴다.
      if (prev.authStatus === null) return
      const now = githubConnected(state.authStatus)
      if (now === githubConnected(prev.authStatus)) return
      if (!now) {
        set({ prStatus: {} })
        return
      }
      for (const w of state.app?.workspaces ?? []) {
        if (!w.archived) void get().refreshPr(w.id)
      }
    })

    window.api.onState((next) => {
      // 삭제·아카이브된 workspace 의 미확인 표시가 Dock 배지에 남지 않도록 정리한다
      // (배지 카운트는 unread 변화에만 반응하므로, 사라진 workspace 의 항목을 여기서 제거해야 0 으로 떨어진다).
      set((s) => {
        const live = new Set(next.workspaces.filter((w) => !w.archived).map((w) => w.id))
        const stale = Object.keys(s.unread).filter((id) => s.unread[id] && !live.has(id))
        const staleRunning = Object.keys(s.runningSince).filter((id) => !live.has(id))
        const staleQueue = Object.keys(s.messageQueue).filter((id) => !live.has(id))
        if (!stale.length && !staleRunning.length && !staleQueue.length) return { app: next }
        const unread = { ...s.unread }
        for (const id of stale) delete unread[id]
        const runningSince = { ...s.runningSince }
        for (const id of staleRunning) delete runningSince[id]
        const messageQueue = { ...s.messageQueue }
        for (const id of staleQueue) delete messageQueue[id]
        return { app: next, unread, runningSince, messageQueue }
      })
    })

    // OS 알림 클릭 등으로 main 이 요청한 workspace 선택.
    window.api.onSelectWorkspace((workspaceId) => {
      void get().selectWorkspace(workspaceId)
    })

    // 지금 보고 있는 workspace 의 미확인 표시를 해제한다(사용자가 막 들여다봤으므로).
    const clearSelectedUnread = (): void => {
      const s = get()
      const sel = s.selectedWorkspaceId
      if (sel && s.unread[sel]) {
        const unread = { ...s.unread }
        delete unread[sel]
        set({ unread })
      }
    }

    // 창이 다시 활성화되면 인증 상태를 갱신하고(Terminal 로그인 완료 자동 반영) 미확인 표시를 해제한다.
    // main 의 'focus' 이벤트가 신뢰 가능한 트리거이고, DOM 의 window 'focus' 는 보조로 함께 둔다
    // (Dock 클릭·앱 전환 시 DOM 이벤트가 누락되어 배지가 안 사라지던 문제를 막는다).
    window.api.onWindowFocus(() => {
      windowFocused = true
      clearSelectedUnread()
      // 자리를 비운 사이 바뀌었을 수 있으니 모든 워크트리 상태를 즉시 한 번 갱신한다.
      void get().refreshAllGit()
    })
    window.api.onWindowBlur(() => {
      windowFocused = false
    })
    window.addEventListener('focus', () => {
      windowFocused = true
      void get().refreshAuth()
      clearSelectedUnread()
    })
    window.addEventListener('blur', () => {
      windowFocused = false
    })

    // macOS Dock 빨간 배지 = "내 주의가 필요한" workspace 수. 미확인 완료(unread)뿐 아니라
    // 입력 대기(권한 요청·AskUserQuestion 질문)도 포함한다 — auto 모드 백그라운드 세션이
    // 질문에서 멈추면 result 가 없어 unread 가 안 잡히므로, 권한 대기를 세지 않으면 작업이
    // 사실상 끝났는데도 배지가 안 떴다. workspace 단위로 중복 없이 센다(완료+질문이 겹쳐도 1).
    // 선택/열람(unread 해제)·응답(permissions 제거) 시 자동으로 감소한다.
    // 이벤트별 badge 채널 토글과 워크스페이스 음소거를 반영한다. unread 는 완료/에러가 섞여
    // 있으므로 completed.badge 로 대표해 게이팅한다(배지는 세밀한 구분보다 "주의 필요 수"가 핵심).
    const refreshBadge = (state: UIState): void => {
      const n = state.app?.settings.notifications
      const muted = new Set((state.app?.workspaces ?? []).filter((w) => w.muted).map((w) => w.id))
      const needsAttention = new Set<string>()
      if (n?.completed.badge)
        for (const [id, on] of Object.entries(state.unread))
          if (on && !muted.has(id)) needsAttention.add(id)
      if (n?.needsInput.badge)
        for (const p of state.permissions)
          if (!muted.has(p.workspaceId)) needsAttention.add(p.workspaceId)
      void window.api.app.setBadgeCount(needsAttention.size)
    }
    useStore.subscribe((state, prev) => {
      // 알림 설정/음소거(app)나 unread·permissions 가 바뀌면 배지를 다시 계산한다.
      if (
        state.unread !== prev.unread ||
        state.permissions !== prev.permissions ||
        state.app !== prev.app
      ) {
        refreshBadge(state)
      }
    })

    window.api.onChat(({ workspaceId, event }: ChatEnvelope) => {
      const { transcripts } = get()
      const items = transcripts[workspaceId] ?? []

      if (event.type === 'item') {
        set({ transcripts: { ...transcripts, [workspaceId]: upsertItem(items, event.item) } })

        // 응답 완료: 알림음 + git/PR 상태 새로고침
        // (에이전트가 방금 커밋·PR 생성을 했을 수 있으므로 칩이 곧바로 반영되도록).
        // 미확인(unread) 표시는 여기서 하지 않는다 — result 아이템은 자동 압축(auto-compact)·
        // preflight 압축의 중간 턴에서도, 또 대기 큐가 남아 곧 다음 턴이 이어질 때도 방출되므로,
        // "작업이 안 끝났는데 unread(=Next unread)" 가 뜨던 원인이었다. 대신 턴이 실제로 idle 로
        // 정착하고 대기 큐가 빈 시점(아래 status 처리)에서만 unread 를 켠다.
        if (event.item.type === 'result') {
          const s = get()
          if (notifyEnabled(s, workspaceId, 'completed', 'sound')) playNotification()
          void s.refreshGit(workspaceId)
          void s.refreshPr(workspaceId)
        }
      } else if (event.type === 'delta') {
        const idx = items.findIndex((i) => i.id === event.id)
        let next: ChatItem[]
        if (idx === -1) {
          next = [
            ...items,
            {
              id: event.id,
              type: event.itemType,
              text: event.text,
              ts: Date.now(),
              streaming: true
            }
          ]
        } else {
          const target = items[idx]
          next = items.slice()
          next[idx] = {
            ...target,
            text: (target as { text: string }).text + event.text
          } as ChatItem
        }
        set({ transcripts: { ...transcripts, [workspaceId]: next } })
      } else if (event.type === 'status' || event.type === 'session') {
        patchWorkspace(set, get, workspaceId, (w) => {
          if (event.type === 'status') {
            w.status = event.status
          } else {
            w.sessionId = event.sessionId
            if (event.model) w.lastModel = event.model
          }
        })
        // 실행 진입/종료에 맞춰 경과 시간 기준 시각을 갱신한다(running 진입 시 1회 기록).
        if (event.type === 'status') {
          set((s) => {
            const cur = s.runningSince[workspaceId]
            if (event.status === 'running') {
              if (cur) return {}
              return { runningSince: { ...s.runningSince, [workspaceId]: Date.now() } }
            }
            if (!cur) return {}
            const runningSince = { ...s.runningSince }
            delete runningSince[workspaceId]
            return { runningSince }
          })
        }
        // 다시 실행에 들어가면 이전 완료의 미확인 표시를 지운다 — 자동 압축 재실행이나 대기 큐의
        // 후속 턴처럼 "끝난 줄 알았는데 다시 도는" 경우 running 과 unread 가 동시에 켜져
        // Next unread 가 뜨는 것을 막는다(작업 중에는 unread 가 아니어야 한다).
        if (event.type === 'status' && event.status === 'running') {
          set((s) => {
            if (!s.unread[workspaceId]) return {}
            const unread = { ...s.unread }
            delete unread[workspaceId]
            return { unread }
          })
        }
        // 턴이 정상 종료되면 대기 큐에 쌓인 후속 메시지를 순서대로 전송한다(취소 기회는 여기서 끝).
        // 에러 종료 시에는 자동 전송하지 않고 큐를 남겨, 사용자가 검토/취소하도록 둔다.
        if (event.type === 'status' && event.status === 'idle') {
          const queued = get().messageQueue[workspaceId]
          if (queued && queued.length) {
            // 아직 처리할 메시지가 남았으니 곧 다시 running 이 된다 — 여기서는 unread 로 표시하지
            // 않는다(작업이 이어지는데 Next unread 가 뜨면 안 된다).
            set((s) => {
              const messageQueue = { ...s.messageQueue }
              delete messageQueue[workspaceId]
              return { messageQueue }
            })
            for (const m of queued) void window.api.chat.send(workspaceId, m.text, m.images)
          } else {
            // 큐가 비어 턴이 완전히 끝났다. 이제서야 미확인으로 표시한다 — 다른 workspace 의 완료,
            // 또는 창이 비활성일 때 본 workspace 의 완료를 Dock 배지·점프 버튼으로 알린다.
            const s = get()
            if (workspaceId !== s.selectedWorkspaceId || !windowFocused) {
              set({ unread: { ...s.unread, [workspaceId]: true } })
            }
          }
        }
        // 백그라운드 세션이 에러로 끝나면 미확인으로 표시(빨간 점 + 점프 대상).
        if (event.type === 'status' && event.status === 'error') {
          const s = get()
          if (notifyEnabled(s, workspaceId, 'error', 'sound')) playNotification()
          if (workspaceId !== s.selectedWorkspaceId) {
            set({ unread: { ...s.unread, [workspaceId]: true } })
          }
        }
      } else if (event.type === 'context') {
        set({
          contextUsage: {
            ...get().contextUsage,
            [workspaceId]: {
              usedTokens: event.usedTokens,
              maxTokens: event.maxTokens,
              percentage: event.percentage
            }
          }
        })
      } else if (event.type === 'compacting') {
        set({ compacting: { ...get().compacting, [workspaceId]: event.active } })
      } else if (event.type === 'fastMode') {
        // 세션이 알려 준 fast mode 실제 상태(main store 에도 영속된다) — 상태줄이 바로 따라가도록
        // 로컬 사본에도 반영한다. 설정을 켜 뒀어도 미지원 모델·쿨다운이면 여기서 off/cooldown 이 온다.
        patchWorkspace(set, get, workspaceId, (w) => {
          w.fastModeState = event.state
          w.fastModeReason = event.reason ?? null
        })
      }
    })

    // 업데이트 상태: 지금 값을 한 번 받아 두고(창이 늦게 떠서 놓친 방송 보정) 이후 변화를 구독한다.
    void window.api.update.getStatus().then((status) => {
      // 그 사이 방송으로 이미 더 최신 상태를 받았다면 덮어쓰지 않는다.
      if (get().updateStatus.state === 'idle') set({ updateStatus: status })
    })
    window.api.onUpdate((status) => set({ updateStatus: status }))

    window.api.onPermission((req: PermissionRequest) => {
      if (notifyEnabled(get(), req.workspaceId, 'needsInput', 'sound')) playNotification()
      set({ permissions: [...get().permissions, req] })
    })

    window.api.onPermissionCancel((requestId: string) => {
      set({ permissions: get().permissions.filter((p) => p.requestId !== requestId) })
    })

    window.api.onScriptOutput(({ workspaceId, kind, chunk }) => {
      const key = scriptKey(workspaceId, kind)
      const out = get().scriptOutput
      set({ scriptOutput: { ...out, [key]: (out[key] ?? '') + chunk } })
    })

    window.api.onScriptExit(({ workspaceId, kind, code }) => {
      const key = scriptKey(workspaceId, kind)
      const out = get().scriptOutput
      set({
        scriptOutput: {
          ...out,
          [key]: (out[key] ?? '') + `\n[wooi] exited (code ${code ?? '?'})\n`
        }
      })
      void get().refreshScriptStatus(workspaceId)

      // setup 스크립트 실패(0 이 아닌 종료 코드)는 조용히 넘어가면 안 된다 — 사용자는 왜 dev 가
      // 안 뜨는지 모른다. 재시도/출력 보기 버튼이 달린 토스트로 알린다. 실패 상태 자체는 메인이
      // Workspace.setupState 로 영속하므로(헤더/스크립트 패널이 이를 읽음) 여기선 알림만 담당한다.
      // code === null 은 kill(아카이브·중지)이라 실패로 보지 않는다.
      if (kind === 'setup') {
        const failed = code !== null && code !== 0
        if (failed) {
          const ws = get().app?.workspaces.find((w) => w.id === workspaceId)
          const label = ws?.displayName?.trim() || ws?.name || 'workspace'
          get().pushToast('error', `Setup failed in “${label}” (exit code ${code}).`, [
            { label: 'Retry setup', run: () => get().retrySetup(workspaceId) },
            {
              label: 'View output',
              run: () => {
                void get().selectWorkspace(workspaceId)
                get().setScriptPanelOpen(workspaceId, true)
              }
            }
          ])
        }
      }
    })
  },

  createWorkspace: async (repoId, args, displayName) => {
    // worktree 체크아웃(git)은 큰 리포에서 수 초가 걸리므로, 먼저 자리표시 행을 띄워
    // 즉각적인 피드백을 주고 git 은 그동안 백그라운드로 진행한다. 완료 시 실제 행으로 교체된다.
    const placeholderId = `pending:${++pendingSeq}`
    set((s) => ({
      pending: [...s.pending, { id: placeholderId, repoId, name: displayName ?? '' }]
    }))

    let res: {
      workspaceId?: string
      name?: string
      branch?: string
      error?: string
      carryFailures?: CarryFailure[]
    }
    try {
      res = await window.api.workspace.create({ repoId, ...args })
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) }
    }

    set((s) => ({ pending: s.pending.filter((p) => p.id !== placeholderId) }))

    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    if (res.workspaceId) {
      void get().selectWorkspace(res.workspaceId)
      if (res.name && res.branch) {
        get().pushToast('success', `Created workspace “${res.name}” on ${res.branch}`)
      }
      get().reportCarryFailures(res.carryFailures)
    }
  },

  // 전달 실패는 워크스페이스 생성을 막지 않지만, 조용히 넘기면 에이전트가 프로젝트 지침을
  // 못 읽은 채 다르게 동작하는 — 이 기능이 애초에 막으려던 — 상황이 그대로 재현된다.
  // 그래서 에이전트 컨텍스트 파일 실패는 error 로 확실히 띄우고, 나머지는 info 로 알린다.
  reportCarryFailures: (failures) => {
    if (!failures || failures.length === 0) return
    const context = failures.filter((f) => f.agentContext)
    const rest = failures.filter((f) => !f.agentContext)
    if (context.length > 0) {
      get().pushToast(
        'error',
        `Agent context files were not carried into the worktree — the agent may not follow your project rules:\n${context
          .map((f) => `${f.path}: ${f.reason}`)
          .join('\n')}`
      )
    }
    if (rest.length > 0) {
      get().pushToast(
        'info',
        `Some files were not carried into the worktree:\n${rest
          .map((f) => `${f.path}: ${f.reason}`)
          .join('\n')}`
      )
    }
  },

  restackWorkspace: async (workspaceId) => {
    const res = await window.api.workspace.restack(workspaceId)
    if (res.status === 'restacked') {
      get().pushToast(
        'success',
        res.pushed ? 'Restacked onto base and pushed.' : 'Restacked onto base.'
      )
    } else if (res.status === 'up-to-date') {
      get().pushToast('info', 'Already up to date with base.')
    } else if (res.status === 'conflict') {
      get().pushToast(
        'error',
        `Rebase conflict in ${res.conflictedFiles?.length ?? 0} file(s) — resolve in the worktree.`
      )
    } else if (res.status === 'dirty') {
      get().pushToast('error', res.message ?? 'Commit or stash changes before restacking.')
    } else {
      get().pushToast('error', res.message ?? 'Failed to restack.')
    }
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
  },

  applyStackSync: async (workspaceId) => {
    const res = await window.api.stack.syncApply(workspaceId).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
      cascade: undefined
    }))
    if (res.error) get().pushToast('error', `Stack sync failed: ${res.error}`)
    else if (res.cascade) get().reportCascade(res.cascade, 'Stack synced.')
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
  },

  dismissStackSync: async (workspaceId) => {
    await window.api.stack.syncDismiss(workspaceId).catch(() => {})
  },

  reportCascade: (cascade, successMsg) => {
    const problems = cascadeProblems(cascade)
    if (!problems.length) {
      // 실제로 뭔가 한 단계가 있을 때만 성공을 알린다(전부 skipped 면 조용히 넘어간다).
      const acted = cascade.steps.some((s) => s.status === 'ok')
      get().pushToast(acted ? 'success' : 'info', successMsg)
      return
    }
    // 실패·충돌은 브랜치별로 한 줄씩 보여 준다 — 예전처럼 조용히 삼키지 않는다.
    const lines = problems.map((p) => {
      const who = p.prNumber ? `#${p.prNumber} (${p.branch})` : p.branch
      if (p.status === 'conflict') {
        const n = p.conflictedFiles?.length ?? 0
        return `• ${who}: rebase conflict in ${n} file(s) — resolve in the worktree`
      }
      return `• ${who}: ${p.kind} failed — ${p.message ?? 'unknown error'}`
    })
    get().pushToast('error', `Stack cascade needs attention:\n${lines.join('\n')}`)
  },

  selectWorkspace: async (id) => {
    // 선택 시 미확인 표시 해제.
    set((s) => {
      if (!id || !s.unread[id]) return { selectedWorkspaceId: id }
      const unread = { ...s.unread }
      delete unread[id]
      return { selectedWorkspaceId: id, unread }
    })
    if (!id) return

    if (!get().loadedTranscripts[id]) {
      const history = await window.api.chat.getHistory(id)
      set((s) => ({
        transcripts: { ...s.transcripts, [id]: history },
        loadedTranscripts: { ...s.loadedTranscripts, [id]: true }
      }))
    }
    void get().refreshGit(id)
    void get().refreshPr(id)
    void get().refreshScriptStatus(id)
  },

  ensureHistory: async (workspaceId) => {
    if (get().loadedTranscripts[workspaceId]) return
    const history = await window.api.chat.getHistory(workspaceId).catch(() => [])
    set((s) => ({
      transcripts: { ...s.transcripts, [workspaceId]: history },
      loadedTranscripts: { ...s.loadedTranscripts, [workspaceId]: true }
    }))
  },

  refreshGit: async (workspaceId) => {
    const status = await window.api.git.status(workspaceId)
    set((s) => ({ gitStatus: { ...s.gitStatus, [workspaceId]: status } }))
  },

  refreshAllGit: async () => {
    const workspaces = get().app?.workspaces.filter((w) => !w.archived) ?? []
    if (!workspaces.length) return
    // 워크스페이스별로 병렬 조회하되, 결과가 모두 도착한 뒤 한 번만 반영해 리렌더를 줄인다.
    const entries = await Promise.all(
      workspaces.map(async (w) => {
        const status = await window.api.git.status(w.id).catch(() => null)
        return [w.id, status] as const
      })
    )
    set((s) => {
      const gitStatus = { ...s.gitStatus }
      for (const [id, status] of entries) gitStatus[id] = status
      return { gitStatus }
    })
  },

  refreshPr: async (workspaceId) => {
    set((s) => ({ prRefreshing: { ...s.prRefreshing, [workspaceId]: true } }))
    try {
      const status = await window.api.pr.status(workspaceId)
      set((s) => ({ prStatus: { ...s.prStatus, [workspaceId]: status } }))
    } finally {
      set((s) => ({ prRefreshing: { ...s.prRefreshing, [workspaceId]: false } }))
    }
  },

  setPrStatus: (workspaceId, status) =>
    set((s) => ({ prStatus: { ...s.prStatus, [workspaceId]: status } })),

  refreshScriptStatus: async (workspaceId) => {
    const status = await window.api.script.getStatus(workspaceId)
    set((s) => ({ scriptStatus: { ...s.scriptStatus, [workspaceId]: status } }))
  },

  refreshAuth: async () => {
    try {
      const status = await window.api.auth.getStatus()
      set({ authStatus: status })
    } catch {
      set({
        authStatus: {
          claude: { installed: false, loggedIn: false },
          github: { installed: false, loggedIn: false }
        }
      })
    }
  },

  requireGithub: async (reason, action) => {
    // 인증 상태를 아직 한 번도 못 받았으면(앱 기동 직후) 먼저 확인한다 — 실제로는 연결돼 있는데
    // 모달부터 띄우는 오탐을 막기 위함이다.
    if (get().authStatus === null) await get().refreshAuth()
    if (githubConnected(get().authStatus)) {
      await action()
      return
    }
    pendingGithubAction = action
    set({ githubGate: { reason } })
  },

  resolveGithubGate: () => {
    const action = pendingGithubAction
    pendingGithubAction = null
    set({ githubGate: null })
    if (action) void action()
  },

  dismissGithubGate: () => {
    pendingGithubAction = null
    set({ githubGate: null })
  },

  dismissPermission: (requestId) => {
    set({ permissions: get().permissions.filter((p) => p.requestId !== requestId) })
  },

  approveAllPermissions: () => {
    const all = get().permissions
    // AskUserQuestion 은 답을 받아야 하는 질문이라 자동 허용 대상이 아니다 — 남겨 둔다.
    const approvable = all.filter((p) => p.toolName !== 'AskUserQuestion')
    if (!approvable.length) return
    for (const p of approvable) {
      void window.api.permission.respond(p.requestId, { behavior: 'allow' })
    }
    set({ permissions: all.filter((p) => p.toolName === 'AskUserQuestion') })
  },

  approvablePermissionCount: () =>
    get().permissions.filter((p) => p.toolName !== 'AskUserQuestion').length,

  /** 미확인 세션 중 선택 후보 하나(사이드바 순서 기준 첫 항목). */
  nextUnreadId: () => {
    const s = get()
    const order = s.app?.workspaces ?? []
    const found = order.find((w) => s.unread[w.id] && w.id !== s.selectedWorkspaceId)
    return found?.id ?? null
  },

  /** 권한 대기 중인 다른 workspace 중 사이드바 순서상 첫 항목. */
  nextPendingPermissionId: () => {
    const s = get()
    const waiting = new Set(s.permissions.map((p) => p.workspaceId))
    const order = s.app?.workspaces ?? []
    const found = order.find((w) => waiting.has(w.id) && w.id !== s.selectedWorkspaceId)
    return found?.id ?? null
  },

  stopAll: async () => {
    const running = (get().app?.workspaces ?? []).filter(
      (w) => !w.archived && w.status === 'running'
    )
    await Promise.all(running.map((w) => window.api.chat.interrupt(w.id).catch(() => {})))
  },

  enqueueMessage: (workspaceId, text, images) =>
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [workspaceId]: [...(s.messageQueue[workspaceId] ?? []), { text, images }]
      }
    })),

  removeQueued: (workspaceId, index) =>
    set((s) => {
      const cur = s.messageQueue[workspaceId]
      if (!cur) return {}
      const next = cur.filter((_, i) => i !== index)
      const messageQueue = { ...s.messageQueue }
      if (next.length) messageQueue[workspaceId] = next
      else delete messageQueue[workspaceId]
      return { messageQueue }
    }),

  setDraft: (workspaceId, text) => set((s) => ({ drafts: { ...s.drafts, [workspaceId]: text } })),

  resetTranscript: (workspaceId) =>
    set((s) => {
      const contextUsage = { ...s.contextUsage }
      delete contextUsage[workspaceId]
      const compacting = { ...s.compacting }
      delete compacting[workspaceId]
      return {
        transcripts: { ...s.transcripts, [workspaceId]: [] },
        loadedTranscripts: { ...s.loadedTranscripts, [workspaceId]: true },
        contextUsage,
        compacting
      }
    }),

  setScrollPosition: (workspaceId, top) =>
    set((s) => ({ scrollPositions: { ...s.scrollPositions, [workspaceId]: top } })),

  setScriptPanelOpen: (workspaceId, open) =>
    set((s) => ({ scriptPanelOpen: { ...s.scriptPanelOpen, [workspaceId]: open } })),

  // 우측 패널 너비 — 대화/터미널이 너무 좁아지지 않도록 양끝을 클램프한다.
  setRightWidth: (px) => set({ rightWidth: Math.max(320, Math.min(900, Math.round(px))) }),

  // 우측 패널 표시 토글 — 숨기면 대화가 전체 폭을 쓰고, 다시 켜면 마지막 너비로 복귀한다.
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

  // 패널 상태를 직접 지정한다. 온보딩에서 고른 기본값을 지금 화면에도 바로 반영하기 위한 것으로,
  // 토글과 같은 경로를 타므로 localStorage 기억값(⌘J 기록)까지 함께 갱신된다 — 그러지 않으면
  // 이미 토글한 적 있는 기존 사용자에게는 기억값이 새로 고른 기본값을 계속 덮어써 버린다.
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

  // 터미널 비율 — 패널/터미널 어느 쪽도 사라지지 않도록 0.15~0.85 로 클램프한다.
  setTerminalRatio: (ratio) => set({ terminalRatio: Math.max(0.15, Math.min(0.85, ratio)) }),

  pushToast: (kind, message, actions) => {
    const id = `toast:${++toastSeq}`
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, actions }] }))
    // info/success 는 자동으로 사라지고, error 또는 액션이 달린 토스트는 사용자가 닫을 때까지 둔다.
    if (kind !== 'error' && !actions?.length) {
      setTimeout(() => get().dismissToast(id), 4000)
    }
    return id
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  retrySetup: (workspaceId) => {
    // 실패 상태(Workspace.setupState)는 재실행이 끝나면 메인의 onExit 훅이 success/failed 로 갱신한다.
    get().setScriptPanelOpen(workspaceId, true)
    void window.api.script.run(workspaceId, 'setup')
  },

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ confirmState: { ...opts, resolve } })
    }),

  resolveConfirm: (ok) => {
    const cs = get().confirmState
    if (cs) cs.resolve(ok)
    set({ confirmState: null })
  }
}))

function patchWorkspace(
  set: (fn: (s: UIState) => Partial<UIState>) => void,
  get: () => UIState,
  workspaceId: string,
  mutate: (w: Workspace) => void
): void {
  const app = get().app
  if (!app) return
  const workspaces = app.workspaces.map((w) => {
    if (w.id !== workspaceId) return w
    const copy = { ...w }
    mutate(copy)
    return copy
  })
  set(() => ({ app: { ...app, workspaces } }))
}
