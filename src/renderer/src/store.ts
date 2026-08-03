import { create } from 'zustand'
import type {
  AgentBackendId,
  AgentBackendMeta,
  AppNotice,
  AppState,
  AuthStatus,
  CarryFailure,
  ChatEnvelope,
  ChatItem,
  GitStatus,
  ImageAttachment,
  ModelOption,
  PermissionRequest,
  PrStatus,
  RunningAgent,
  ReviewEnvelope,
  ReviewFinding,
  ReviewVerdict,
  ScriptKind,
  ScriptStatus,
  StackCascadeResult,
  UpdateStatus,
  Workspace
} from '@shared/types'
import type { NotificationChannel, NotificationEvent } from '@shared/types'
import { AGENT_BACKEND_IDS, cascadeProblems } from '@shared/types'
import { playNotification } from './lib/sound'
import { carrySuggestShownFlag, readUiFlag, setUiFlag } from './lib/uiFlags'
import { openRepoSettings } from './lib/repoSettings'
import { bodyOf, emptyView, isPosted, type ReviewViewState } from './lib/review'

export const scriptKey = (workspaceId: string, kind: ScriptKind): string => `${workspaceId}:${kind}`

/**
 * 일괄 승인(⇧⌘A)이 대신 눌러 줘도 되는 요청인지.
 *
 * 제외 대상은 "허용/거부"가 아니라 **무엇을 고를지**를 사용자에게 묻는 요청이다:
 * - AskUserQuestion — 고른 답을 도구 입력에 주입해야 한다(빈 답으로 넘기면 모델이 잘못 진행한다)
 * - 계획 승인(kind==='plan') — 선택에 따라 세션의 권한 모드가 바뀐다(자동으로 정할 일이 아니다)
 */
const isBulkApprovable = (p: PermissionRequest): boolean =>
  p.toolName !== 'AskUserQuestion' && p.kind !== 'plan'

/** 앱 초기화와 Overview가 겹쳐도 backend별 account usage RPC는 하나만 실행한다. */
const accountUsageRefreshes: Partial<Record<AgentBackendId, Promise<AppState>>> = {}

export function refreshAccountUsage(agentId: AgentBackendId): Promise<AppState> {
  const active = accountUsageRefreshes[agentId]
  if (active) return active
  const request = window.api.rateLimits.refresh(agentId).finally(() => {
    if (accountUsageRefreshes[agentId] === request) delete accountUsageRefreshes[agentId]
  })
  accountUsageRefreshes[agentId] = request
  return request
}

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
   * 등록된 에이전트 백엔드의 메타(라벨·권한 모드·effort 선택지·capabilities·가용성).
   * 권한 모드·effort·에이전트 피커 UI 의 유일한 근거다 — 렌더러에 상수로 두지 않는다.
   * 아직 못 읽었으면 빈 배열이며, UI 는 저장된 값을 그대로 보여 주는 것으로 폴백한다.
   */
  backends: AgentBackendMeta[]
  /** 백엔드별 모델 선택지(Claude 는 정적, Codex 는 app-server 카탈로그). */
  models: Partial<Record<AgentBackendId, ModelOption[]>>
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
  /** 현재 앱 버전·시각에 유효한 원격 공지. */
  notices: AppNotice[]
  /** workspace 별 컨텍스트 윈도 사용량(마지막 턴 기준). 입력창 사용량 미터용. */
  contextUsage: Record<string, ContextUsage>
  /** workspace 별 대화 압축 진행 여부(자동/수동 /compact 진행 중이면 true). */
  compacting: Record<string, boolean>
  /** 응답이 완료됐지만 사용자가 아직 보지 않은 workspace. */
  unread: Record<string, boolean>
  /** workspace 가 실행(running) 상태로 진입한 시각(epoch ms). 경과 시간 표시용. */
  runningSince: Record<string, number>
  /**
   * workspace 별로 지금 살아 있는 서브에이전트 목록(사이드바 "Running agents" 패널).
   * 'agents' 이벤트가 전량을 실어 오므로 병합하지 않고 통째로 교체한다. 영속되지 않는 휘발성
   * 상태이므로, 앱을 다시 띄우면 비어 있는 것이 정상이다(그 시점엔 세션도 죽어 있다).
   */
  runningAgents: Record<string, RunningAgent[]>
  /**
   * workspace 별 에이전트 목록 접힘 상태(true = 접힘). 기본값은 펼침이다.
   *
   * 영속하지 않는다 — 에이전트 자체가 휘발성이라(세션이 끝나면 사라진다) 접힘 상태만 디스크에
   * 남으면 다음 실행에서 "왜 안 보이지"가 되기 쉽다. 지금 시끄러운 워크트리를 잠시 접는 용도다.
   */
  agentsCollapsed: Record<string, boolean>
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
  /**
   * 전체 화면을 덮는 모달/오버레이가 떠 있는지(App 이 갱신).
   * 대화 화면의 전역 키(Esc 중단 등)는 이때 양보해야 한다 — 모달이 Esc 로 닫히는 동안
   * 뒤에서 턴이 중단되면 사용자는 자기가 무엇을 눌렀는지 알 수 없다.
   */
  overlayOpen: boolean
  setOverlayOpen: (open: boolean) => void
  /** 생성 중인 workspace 의 자리표시 행(repoId 로 사이드바에 배치). */
  pending: PendingWorkspace[]

  /**
   * 열려 있는 PR 리뷰. null 이 아니면 전체 화면 리뷰 모드다(사이드바·대화창을 대체).
   * 리뷰는 workspace 와 무관하게 임의의 PR 을 대상으로 하므로 별도 축으로 둔다.
   */
  activeReviewId: string | null
  /**
   * reviewId → 화면 상태(사이드카에서 읽어온 diff·지적·활동 + 선택/편집).
   * 리뷰의 **메타데이터는 여기 없다** — `app.reviews` 가 권위이고 상태 방송으로 갱신된다.
   */
  reviewViews: Record<string, ReviewViewState>

  init: () => Promise<void>
  /** worktree 생성을 시작하고, 완료될 때까지 사이드바에 스피너 행을 즉시 띄운다. */
  createWorkspace: (
    repoId: string,
    args?: {
      name?: string
      baseBranch?: string
      parentWorkspaceId?: string | null
      /** 이 워크스페이스를 구동할 에이전트. 생략하면 전역 기본 백엔드. */
      agentBackend?: AgentBackendId
    },
    displayName?: string
  ) => Promise<void>
  /** stacked 워크스페이스를 최신 base(부모 브랜치) 위로 rebase·force-push 한다. */
  restackWorkspace: (workspaceId: string) => Promise<void>
  /** 외부 병합으로 대기 중인 스택 캐스케이드를 실행한다(rebase + force-push — 사용자 승인 후). */
  applyStackSync: (workspaceId: string) => Promise<void>
  /** 대기 중인 스택 캐스케이드 계획을 무시한다. */
  dismissStackSync: (workspaceId: string) => Promise<void>
  /** 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다. */
  retargetBase: (workspaceId: string) => Promise<void>
  /** 어긋난 base 를 그대로 두기로 한다(그 base 를 채택하고 다시 묻지 않는다). */
  keepBase: (workspaceId: string) => Promise<void>
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
  /** 에이전트 백엔드 메타 + 백엔드별 모델 목록을 다시 읽는다(가용성은 실행 중에도 바뀐다). */
  refreshAgents: () => Promise<void>
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
   * 답이나 선택을 받아야 하는 요청은 제외하고 그대로 남긴다(isBulkApprovable 참고).
   */
  approveAllPermissions: () => void
  /** 일괄 승인 가능한 대기 권한 수. */
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
  /** 해당 workspace 의 에이전트 목록 접힘 상태를 뒤집는다. */
  toggleAgentsCollapsed: (workspaceId: string) => void
  setRightWidth: (px: number) => void
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setTerminalRatio: (ratio: number) => void
  /** 토스트를 띄우고 그 id 를 반환한다. actions 를 주면 인라인 버튼이 붙고 자동으로 닫히지 않는다. */
  pushToast: (kind: ToastKind, message: string, actions?: ToastAction[]) => string
  dismissToast: (id: string) => void
  /** worktree 전달 실패를 사용자에게 알린다. 에이전트 컨텍스트 실패는 error 로 구분해 띄운다. */
  reportCarryFailures: (failures?: CarryFailure[]) => void
  /**
   * 전달 목록이 빈 리포에서 worktree 가 만들어졌을 때, 탐지된 후보를 한 번 제안한다.
   * 리포당 최대 한 번만 뜬다(uiFlags 에 기억).
   */
  suggestCarry: (repoId: string, workspaceId: string, suggestions?: string[]) => void
  /** setup 스크립트를 다시 실행한다(스크립트 패널을 함께 연다). 결과는 메인이 setupState 로 영속. */
  retrySetup: (workspaceId: string) => void
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void

  // ── PR 리뷰 모드 ───────────────────────────────────────────────────────
  /** 리뷰를 시작하고 전체 화면 모드로 진입한다. 실패하면 토스트만 띄우고 진입하지 않는다. */
  startReview: (args: {
    repoId: string
    prNumber: number
    prompt: string
    agentBackend: AgentBackendId
  }) => Promise<void>
  /** 사이드바에서 리뷰를 골라 화면에 띄운다(사이드카를 아직 안 읽었으면 함께 읽는다). */
  openReview: (reviewId: string) => void
  /** 리뷰의 diff·지적·활동을 사이드카에서 읽어 화면 상태에 채운다(한 번만). */
  loadReview: (reviewId: string) => Promise<void>
  /** 게시하지 않은 지적이 있으면 확인을 받고 리뷰를 닫는다(사이드바 ×·화면 × 공용). */
  requestCloseReview: (reviewId: string) => Promise<void>
  /** 리뷰를 완전히 삭제한다(워크트리·ref·기록 모두). */
  closeReview: (reviewId: string) => Promise<void>
  /** 워크트리만 지우고 결과는 남긴다. */
  archiveReview: (reviewId: string) => Promise<void>
  /** 아카이브된 리뷰를 되살린다(워크트리 재구성). */
  unarchiveReview: (reviewId: string) => Promise<void>
  /** 실행 중인 리뷰를 중단한다. */
  cancelReview: (reviewId: string) => Promise<void>
  toggleFinding: (reviewId: string, findingId: string) => void
  /** 아직 게시하지 않은 항목 전체를 선택/해제한다. */
  toggleAllFindings: (reviewId: string, on: boolean) => void
  editFinding: (reviewId: string, findingId: string, body: string) => void
  /** 안 달기로 한 지적을 목록에서 버린다. */
  dismissFinding: (reviewId: string, findingId: string) => Promise<void>
  /** 선택된(또는 지정된) 지적을 순서대로 개별 코멘트로 게시한다. */
  postFindings: (reviewId: string, findingIds: string[]) => Promise<{ ok: number; failed: number }>
  /** PR 전체 판정을 제출한다. 성공하면 true. */
  submitReview: (reviewId: string, verdict: ReviewVerdict, body: string) => Promise<boolean>
  /** 활성 리뷰들의 답글·새 커밋을 한 번 확인한다. */
  pollReviews: () => Promise<void>
  /** 인라인 스레드에 답장한다. 성공하면 true. */
  replyToThread: (reviewId: string, commentId: number, body: string) => Promise<boolean>
  /** 앞선 맥락 위에서 추가 지시를 보낸다. */
  followUpReview: (reviewId: string, text: string) => Promise<void>
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

// 리뷰에 달린 답글·새 커밋 폴링. GitHub REST 는 시간당 5000 이고 세션당 셸 호출을 묶어 두어
// 1분 간격이면 넉넉하다. 아카이브됐거나 아직 코멘트를 안 단 세션은 메인에서 알아서 건너뛴다.
let reviewPollTimer: ReturnType<typeof setInterval> | null = null
const REVIEW_POLL_INTERVAL_MS = 60_000

// gh 연결 모달이 닫힐 때까지 붙들어 두는, 사용자가 원래 하려던 액션. 상태에 담지 않는 이유는
// 함수라 비교·직렬화 대상이 아니고, 렌더에 영향을 주지 않기 때문이다.
let pendingGithubAction: (() => void | Promise<void>) | null = null

/** gh(GitHub CLI)가 설치·로그인돼 PR·스택 기능을 쓸 수 있는 상태인가. */
function githubConnected(auth: AuthStatus | null): boolean {
  return !!auth && auth.github.installed && auth.github.loggedIn
}

/**
 * 값이 실질적으로 같은지(JSON 기준). 폴링으로 다시 읽은 결과가 이전과 같으면 set 을 건너뛰어
 * 불필요한 리렌더를 막는 용도다 — 작고 평평한 카탈로그 데이터에만 쓴다.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** id 기준 upsert(첫 등장 순서 보존). 스트리밍으로 들어오는 목록에 쓴다. */
function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx < 0) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

/**
 * 후속 턴이 내놓은 지적을 기존 목록에 **덧붙인다**(같은 id 면 갱신).
 * 교체하면 이미 게시한 지적이 목록에서 사라져, 무엇을 달았는지 추적할 수 없게 된다.
 */
function mergeFindings(prev: ReviewFinding[], incoming: ReviewFinding[]): ReviewFinding[] {
  let out = prev
  for (const f of incoming) out = upsertById(out, f)
  return out
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
  backends: [],
  models: {},
  githubGate: null,
  updateStatus: { state: 'idle' },
  notices: [],
  contextUsage: {},
  compacting: {},
  unread: {},
  runningSince: {},
  runningAgents: {},
  agentsCollapsed: {},
  drafts: {},
  messageQueue: {},
  scrollPositions: {},
  scriptPanelOpen: {},
  rightWidth: 460,
  rightPanelOpen: true,
  terminalRatio: 0.5,
  toasts: [],
  confirmState: null,
  overlayOpen: false,
  setOverlayOpen: (open) => {
    if (get().overlayOpen !== open) set({ overlayOpen: open })
  },
  pending: [],
  activeReviewId: null,
  reviewViews: {},

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

    // Overview에 들어간 뒤에야 Codex usage 조회를 시작하면 첫 화면에서 RPC 시간만큼 기다리게 된다.
    // workspace 또는 저장된 스냅샷이 있으면 renderer 초기화와 동시에 미리 갱신한다.
    const hasCodex =
      app.workspaces.some((w) => !w.archived && w.agentBackend === 'codex') ||
      !!app.rateLimitsByAgent?.codex
    if (hasCodex) {
      void refreshAccountUsage('codex').then((next) => set({ app: next }))
    }
    void get().refreshAuth()
    void get().refreshAgents()

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

    // 리뷰 답글 폴링. git 상태 폴링과 같은 규칙 — 창이 가려져 있으면 건너뛰고, 포커스가
    // 돌아오는 순간 한 번 따라잡는다(onWindowFocus 참고).
    if (!reviewPollTimer) {
      reviewPollTimer = setInterval(() => {
        if (windowFocused) void get().pollReviews()
      }, REVIEW_POLL_INTERVAL_MS)
    }
    void get().pollReviews()

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
      void get().pollReviews()
    })
    window.api.onWindowBlur(() => {
      windowFocused = false
    })
    window.addEventListener('focus', () => {
      windowFocused = true
      void get().refreshAuth()
      // 자리를 비운 사이 사용자가 에이전트 CLI 를 설치·제거했을 수 있으므로 가용성도 다시 본다.
      void get().refreshAgents()
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
        // 턴이 끝났으면 압축 진행 배지는 반드시 내린다 — 쉬고 있는 workspace 가 압축 중일 수는
        // 없다. 압축 중에는 입력창을 잠그므로, 배지가 켜진 채 남으면 입력이 굳어 버린다(세션이
        // 압축 도중 죽는 등으로 compacting:false 를 놓치는 경로에 대한 안전망).
        if (event.type === 'status' && event.status !== 'running') {
          set((s) => {
            if (!s.compacting[workspaceId]) return {}
            const compacting = { ...s.compacting }
            delete compacting[workspaceId]
            return { compacting }
          })
        }
        // 실행 중이 아닌 workspace 에 살아 있는 서브에이전트가 있을 수는 없다(세션의 syncStatus 는
        // 서브에이전트가 남아 있으면 running 을 유지한다). 그래서 idle/error 를 보면 목록을 비운다 —
        // 호스트가 죽어 종료 알림이 아예 오지 않는 경로에서 스피너가 영구히 남는 것을 막는 안전망.
        if (event.type === 'status' && event.status !== 'running') {
          set((s) => {
            if (!s.runningAgents[workspaceId]) return {}
            const runningAgents = { ...s.runningAgents }
            delete runningAgents[workspaceId]
            return { runningAgents }
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
      } else if (event.type === 'agents') {
        // REPLACE 시맨틱 — 전량이 실려 오므로 병합하지 않는다. 빈 배열이면 키를 지워, 사이드바가
        // 워크스페이스를 세는 자리에서 "빈 배열이 있는 키"를 따로 걸러내지 않아도 되게 한다.
        set((s) => {
          const runningAgents = { ...s.runningAgents }
          if (event.agents.length === 0) delete runningAgents[workspaceId]
          else runningAgents[workspaceId] = event.agents
          return { runningAgents }
        })
      }
    })

    // 업데이트 상태: 지금 값을 한 번 받아 두고(창이 늦게 떠서 놓친 방송 보정) 이후 변화를 구독한다.
    void window.api.update.getStatus().then((status) => {
      // 그 사이 방송으로 이미 더 최신 상태를 받았다면 덮어쓰지 않는다.
      if (get().updateStatus.state === 'idle') set({ updateStatus: status })
    })
    window.api.onUpdate((status) => set({ updateStatus: status }))

    void window.api.notice.getActive().then((notices) => {
      if (get().notices.length === 0) set({ notices })
    })
    window.api.onNotice((notices) => set({ notices }))

    // 에이전트 계정이 앱 밖에서 바뀌었다(터미널 로그인·토큰 갱신 등). 폴링을 기다리지 않고
    // 즉시 인증 상태를 다시 읽어, 통합 패널과 배너가 곧바로 맞는 값을 보여 주게 한다.
    window.api.onAuthChanged(() => void get().refreshAuth())
    // PR 리뷰 스트림. 레코드(상태·요약)는 evtState 로 오고, 여기로는 덩치 큰 것과
    // 실행 중에만 의미 있는 것(진행 로그)이 흘러온다.
    window.api.onReview(({ reviewId, event }: ReviewEnvelope) => {
      patchReview(set, get, reviewId, (v) => {
        switch (event.type) {
          case 'status':
            return {}
          case 'diff':
            return { diff: event.diff }
          case 'progress':
            // 진행 로그는 화면 표시용이라 무한정 쌓아둘 이유가 없다.
            return { progress: [...v.progress, event.item].slice(-200) }
          case 'findings':
            // 후속 턴의 지적은 기존 목록에 덧붙는다(앞선 지적은 이미 게시됐을 수 있다).
            return { findings: mergeFindings(v.findings, event.findings) }
          case 'activity':
            return { activity: upsertById(v.activity, event.item) }
          case 'error':
            return { error: event.message }
        }
      })
    })

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
      carrySuggestions?: string[]
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
      get().suggestCarry(repoId, res.workspaceId, res.carrySuggestions)
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

  // 구버전(v11 이하)부터 등록해 둔 리포는 마이그레이션이 carryItems 를 빈 배열로 남겨서,
  // 신규 리포와 달리 자동 탐지 혜택을 못 받고 기능의 존재조차 모른 채 지낸다. 그 사이 모든
  // worktree 는 .env·CLAUDE.local.md 없이 만들어지고, 증상은 에러가 아니라 "에이전트가 왜
  // 규칙을 안 지키지" 라는 조용한 오작동이다. 방금 그 일이 실제로 일어난 이 시점에 한 번 묻는다.
  suggestCarry: (repoId, workspaceId, suggestions) => {
    if (!suggestions || suggestions.length === 0) return
    // 워크스페이스를 만들 때마다 반복하면 잔소리가 된다 — 리포당 한 번만. 수락하면 carryItems 가
    // 차서 조건 자체가 다시는 성립하지 않는다.
    if (readUiFlag(carrySuggestShownFlag(repoId))) return
    setUiFlag(carrySuggestShownFlag(repoId), true)

    get().pushToast(
      'info',
      `New worktrees only contain git-tracked files, so this workspace is missing ${suggestions.join(
        ', '
      )}. Carry them into every new workspace?`,
      [
        {
          label: 'Carry them',
          run: () => {
            void (async () => {
              // 설정만 고치면 방금 만든 이 워크스페이스는 여전히 파일이 없는 채로 남는다.
              // workspaceId 를 넘겨 그 worktree 도 지금 바로 채운다.
              const res = await window.api.repo.adoptCarrySuggestions(repoId, workspaceId)
              if (res.error) {
                get().pushToast('error', res.error)
                return
              }
              if (res.added.length > 0) {
                get().pushToast(
                  'success',
                  `Now carrying ${res.added.join(', ')} into new workspaces.`
                )
              }
              get().reportCarryFailures(res.carryFailures)
            })()
          }
        },
        { label: 'Repo settings', run: () => openRepoSettings(repoId) }
      ]
    )
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

  retargetBase: async (workspaceId) => {
    const res = await window.api.stack
      .baseRetarget(workspaceId)
      .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
    if (res.error) get().pushToast('error', `Retarget failed: ${res.error}`)
    else get().pushToast('success', 'Pull request retargeted onto the parent branch.')
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
  },

  keepBase: async (workspaceId) => {
    await window.api.stack.baseKeep(workspaceId).catch(() => {})
    void get().refreshGit(workspaceId)
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
    // 선택 시 미확인 표시 해제. 사이드바 선택은 하나의 축이므로 리뷰 화면에서도 빠져나온다
    // (리뷰 세션 자체는 남아 있어 사이드바에서 다시 고를 수 있다).
    set((s) => {
      if (!id || !s.unread[id]) return { selectedWorkspaceId: id, activeReviewId: null }
      const unread = { ...s.unread }
      delete unread[id]
      return { selectedWorkspaceId: id, unread, activeReviewId: null }
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
      // 폴백은 **등록된 모든 백엔드**를 채워야 한다. 하나라도 빠지면 `authStatus.agents[id]` 를
      // 읽는 모든 패널이 undefined 를 만나 터진다(조회 실패는 앱 기동 직후 흔하다).
      const agents = Object.fromEntries(
        AGENT_BACKEND_IDS.map((id) => [id, { installed: false, loggedIn: false }])
      ) as AuthStatus['agents']
      set({ authStatus: { agents, github: { installed: false, loggedIn: false } } })
    }
  },

  /**
   * 에이전트 카탈로그(백엔드 메타 + 백엔드별 모델 목록)를 새로 읽는다.
   * 백엔드 가용성은 CLI 설치 여부에 따라 앱 실행 중에도 바뀔 수 있으므로(사용자가 그 사이
   * `npm i -g @openai/codex` 를 할 수 있다), 창 포커스·설정 열기 시점에 다시 부른다.
   */
  refreshAgents: async () => {
    try {
      const backends = await window.api.agent.listBackends()
      // 내용이 그대로면 set 하지 않는다. 이 함수는 창 포커스마다 불리는데, 매번 새 배열을 넣으면
      // 참조가 바뀌어 구독하는 모든 컴포넌트가 헛되이 리렌더된다(카탈로그는 거의 안 변한다).
      if (!same(get().backends, backends)) set({ backends })

      const lists = await Promise.all(
        backends.map(async (b) => [b.id, await window.api.agent.listModels(b.id)] as const)
      )
      const models = Object.fromEntries(lists) as Record<AgentBackendId, ModelOption[]>
      if (!same(get().models, models)) set({ models })
    } catch {
      // 카탈로그를 못 읽어도 앱은 동작해야 한다 — UI 는 저장된 값을 그대로 보여 준다.
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
    const approvable = all.filter(isBulkApprovable)
    if (!approvable.length) return
    for (const p of approvable) {
      void window.api.permission.respond(p.requestId, { behavior: 'allow' })
    }
    set({ permissions: all.filter((p) => !isBulkApprovable(p)) })
  },

  approvablePermissionCount: () => get().permissions.filter(isBulkApprovable).length,

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

  toggleAgentsCollapsed: (workspaceId) =>
    set((s) => ({
      agentsCollapsed: { ...s.agentsCollapsed, [workspaceId]: !s.agentsCollapsed[workspaceId] }
    })),

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
  },

  // ── PR 리뷰 모드 ─────────────────────────────────────────────────────────

  startReview: async ({ repoId, prNumber, prompt, agentBackend }) => {
    // PR 조회도 코멘트 게시도 gh 를 쓰므로 다른 PR 기능과 같은 지연 게이트를 태운다.
    await get().requireGithub('Reviewing a pull request needs GitHub.', async () => {
      const res = await window.api.review.start({ repoId, prNumber, prompt, agentBackend })
      if (res.error || !res.reviewId) {
        get().pushToast('error', res.error ?? 'Failed to start the review.')
        return
      }
      // 레코드는 상태 방송으로 들어온다. 여기서는 화면만 전환하고 사이드카를 준비한다.
      const id = res.reviewId
      set({ activeReviewId: id, reviewViews: { ...get().reviewViews, [id]: emptyView() } })
    })
  },

  openReview: (reviewId) => {
    set({ activeReviewId: reviewId })
    void get().loadReview(reviewId)
    // 열어서 봤으므로 미확인 점을 끈다.
    void window.api.review.markSeen(reviewId)
  },

  loadReview: async (reviewId) => {
    if (get().reviewViews[reviewId]?.loaded) return
    const bundle = await window.api.review.load(reviewId)
    patchReview(set, get, reviewId, (v) => ({
      loaded: true,
      diff: bundle.diff ?? v.diff,
      findings: bundle.findings,
      activity: bundle.activity
    }))
  },

  requestCloseReview: async (reviewId) => {
    const session = get().app?.reviews.find((r) => r.id === reviewId)
    const view = get().reviewViews[reviewId]
    if (!session) return
    const unposted = (view?.findings ?? []).filter((f) => !isPosted(session, f.id)).length
    if (unposted > 0) {
      const ok = await get().confirm({
        title: 'Delete this review?',
        body: `${unposted} finding${unposted === 1 ? '' : 's'} haven't been posted yet. This removes the review and its results for good — archive it instead if you might come back.`,
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
    }
    await get().closeReview(reviewId)
  },

  closeReview: async (reviewId) => {
    const { reviewViews, activeReviewId } = get()
    const next = { ...reviewViews }
    delete next[reviewId]
    set({ reviewViews: next, activeReviewId: activeReviewId === reviewId ? null : activeReviewId })
    await window.api.review.close(reviewId)
  },

  archiveReview: async (reviewId) => {
    await window.api.review.archive(reviewId)
    // 아카이브한 리뷰를 열어 두고 있었다면 화면에서 빠져나온다(워크트리가 사라졌다).
    if (get().activeReviewId === reviewId) set({ activeReviewId: null })
  },

  unarchiveReview: async (reviewId) => {
    const res = await window.api.review.unarchive(reviewId)
    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    get().openReview(reviewId)
  },

  cancelReview: async (reviewId) => {
    await window.api.review.cancel(reviewId)
  },

  toggleFinding: (reviewId, findingId) =>
    patchReview(set, get, reviewId, (v) => ({
      selected: { ...v.selected, [findingId]: !v.selected[findingId] }
    })),

  toggleAllFindings: (reviewId, on) =>
    patchReview(set, get, reviewId, (v) => {
      const session = get().app?.reviews.find((r) => r.id === reviewId)
      const selected: Record<string, boolean> = {}
      for (const f of v.findings) {
        // 이미 게시한 항목은 다시 선택되지 않게 둔다(중복 코멘트 방지).
        if (on && !(session && isPosted(session, f.id))) selected[f.id] = true
      }
      return { selected }
    }),

  editFinding: (reviewId, findingId, body) =>
    patchReview(set, get, reviewId, (v) => ({ edits: { ...v.edits, [findingId]: body } })),

  dismissFinding: async (reviewId, findingId) => {
    // 파일에 먼저 남기고 화면에서 지운다 — 반대로 하면 실패했을 때 화면에서만 사라진
    // 지적이 다음 로드에서 되살아난다.
    const res = await window.api.review.dismiss(reviewId, findingId)
    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    patchReview(set, get, reviewId, (v) => {
      const { [findingId]: _selected, ...selected } = v.selected
      const { [findingId]: _edit, ...edits } = v.edits
      const { [findingId]: _posting, ...posting } = v.posting
      return { findings: v.findings.filter((f) => f.id !== findingId), selected, edits, posting }
    })
  },

  postFindings: async (reviewId, findingIds) => {
    // 순차로 보낸다. 같은 PR 에 병렬 POST 를 날리면 GitHub 2차 레이트리밋에 걸려
    // 뒤쪽 코멘트가 통째로 실패한다.
    let ok = 0
    let failed = 0
    for (const findingId of findingIds) {
      const view = get().reviewViews[reviewId]
      const session = get().app?.reviews.find((r) => r.id === reviewId)
      const finding = view?.findings.find((f) => f.id === findingId)
      if (!view || !session || !finding) continue
      if (isPosted(session, findingId)) continue

      patchReview(set, get, reviewId, (v) => ({
        posting: { ...v.posting, [findingId]: { state: 'posting' as const } }
      }))

      const res = await window.api.review.post(reviewId, findingId, bodyOf(view, finding))
      if (res.error) {
        failed++
        patchReview(set, get, reviewId, (v) => ({
          posting: { ...v.posting, [findingId]: { state: 'failed' as const, error: res.error } }
        }))
      } else {
        ok++
        // 성공은 레코드(postedComments)가 기록한다 — 여기서는 진행 표시만 걷어낸다.
        patchReview(set, get, reviewId, (v) => {
          const posting = { ...v.posting }
          delete posting[findingId]
          return { posting, selected: { ...v.selected, [findingId]: false } }
        })
      }
    }

    if (ok && !failed) get().pushToast('success', `Posted ${ok} comment${ok === 1 ? '' : 's'}.`)
    else if (ok && failed) get().pushToast('error', `Posted ${ok}, failed ${failed}.`)
    else if (failed)
      get().pushToast('error', `Failed to post ${failed} comment${failed === 1 ? '' : 's'}.`)
    return { ok, failed }
  },

  submitReview: async (reviewId, verdict, body) => {
    const res = await window.api.review.submit(reviewId, verdict, body)
    if (res.error) {
      get().pushToast('error', res.error)
      return false
    }
    const label =
      verdict === 'approve'
        ? 'Approved'
        : verdict === 'request-changes'
          ? 'Requested changes'
          : 'Commented'
    get().pushToast('success', `${label} on the pull request.`)
    return true
  },

  pollReviews: async () => {
    const reviews = get().app?.reviews ?? []
    // 순차로 돈다. 세션마다 gh 를 병렬로 띄우면 로그인 셸이 한꺼번에 여러 개 뜬다.
    for (const r of reviews) {
      // 추적할 게 없으면 건너뛴다. 코멘트를 안 달았어도 리뷰를 제출했다면 **새 커밋** 은
      // 계속 봐야 한다 — 그 sha 가 "같은 리뷰를 또 낼 수 있는가" 의 판단 근거이기 때문이다.
      if (r.archived || (r.postedComments.length === 0 && !r.lastSubmission)) continue
      await window.api.review.poll(r.id)
    }
  },

  replyToThread: async (reviewId, commentId, body) => {
    const res = await window.api.review.reply(reviewId, commentId, body)
    if (res.error) {
      get().pushToast('error', res.error)
      return false
    }
    return true
  },

  followUpReview: async (reviewId, text) => {
    const res = await window.api.review.followUp(reviewId, text)
    if (res.error) get().pushToast('error', res.error)
  }
}))

/** 리뷰 세션 1개를 불변 갱신한다. 세션이 없으면(이미 닫힘) 아무것도 하지 않는다. */
function patchReview(
  set: (partial: Partial<UIState>) => void,
  get: () => UIState,
  reviewId: string,
  mutate: (v: ReviewViewState) => Partial<ReviewViewState>
): void {
  const views = get().reviewViews
  // 화면 상태가 아직 없으면(방송이 먼저 도착한 경우) 빈 상태를 만들어 얹는다.
  const view = views[reviewId] ?? emptyView()
  set({ reviewViews: { ...views, [reviewId]: { ...view, ...mutate(view) } } })
}

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
