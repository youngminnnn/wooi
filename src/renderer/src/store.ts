import { create } from 'zustand'
import type {
  AdoptFanoutResult,
  AgentBackendId,
  AgentBackendMeta,
  AppNotice,
  AppState,
  ApiRetryState,
  ArchiveScriptFailure,
  AuthStatus,
  CarryFailure,
  ChatEnvelope,
  ChatItem,
  ComposerAttachment,
  CreateFanoutResult,
  EffortSetting,
  FanoutSlot,
  GitStatus,
  ImageAttachment,
  ModelOption,
  PaneKind,
  PaneState,
  PermissionRequest,
  PrMergeMethod,
  PrStatus,
  RunningAgent,
  WorkspaceGoal,
  ReviewEnvelope,
  ReviewFinding,
  ReviewVerdict,
  ScriptStatus,
  StackCascadeResult,
  StackOpProgress,
  StackTrainResult,
  UpdateStatus,
  Workspace
} from '@shared/types'
import type { NotificationChannel, NotificationEvent } from '@shared/types'
import {
  AGENT_BACKEND_IDS,
  DEFAULT_AGENT_BACKEND,
  cascadeProblems,
  fanoutSlotName,
  workspaceDisplayName
} from '@shared/types'
import { fileDiffHash, isFileViewed, viewedKey } from '@shared/reviewViewed'
import { playNotification } from './lib/sound'
import {
  carryMissingShownFlag,
  carrySuggestShownFlag,
  FORK_SEMANTICS_NOTICE_SEEN,
  readUiFlag,
  setUiFlag
} from './lib/uiFlags'
import { openRepoSettings } from './lib/repoSettings'
import {
  bodyOf,
  emptyView,
  isPosted,
  reviewTitle,
  type ReviewTab,
  type ReviewViewState
} from './lib/review'
import {
  composeDiffCommentsMessage,
  type DiffComment,
  type DiffCommentAnchor
} from './lib/diffComments'
import { popWorkspaceHistory, pushWorkspaceHistory } from './lib/workspaceHistory'
import { UNDO_CREATE_WINDOW_MS, undoCreateVerdict, type UndoableCreate } from './lib/undoCreate'

export const scriptKey = (workspaceId: string, scriptId: string): string =>
  `${workspaceId}:${scriptId}`

/** 대기 중인 첨부가 없을 때 돌려주는 고정 배열(매번 새 배열을 만들면 구독자가 헛되이 다시 그린다). */
const EMPTY_ATTACHMENTS: ComposerAttachment[] = []

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

/** diff 라인 코멘트의 id 카운터. 창 수명 안에서만 유일하면 되므로 단조 증가로 충분하다. */
let diffCommentSeq = 0

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
  /** stacked 생성이면 부모 workspace id. 자리표시 행을 부모 밑에 들여써서 놓는 데 쓴다. */
  parentWorkspaceId: string | null
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

/** 큰 파일 뷰어가 방문한 파일 한 개. */
export interface FileViewerEntry {
  /** worktree 기준 상대 경로. */
  path: string
  /** 열자마자 이동할 줄(1-based). diff·멘션에서 특정 줄로 보낼 때 쓴다. */
  line?: number
}

export interface FileViewerState {
  /** 이 경로들이 속한 worktree. 다른 워크스페이스로 옮기면 뷰어는 닫힌다. */
  workspaceId: string
  /** 방문 기록(뒤로/앞으로). */
  history: FileViewerEntry[]
  /** history 안의 현재 위치. */
  index: number
  /** 왼쪽 파일 트리 표시 여부. */
  treeOpen: boolean
}

/** 뷰어 방문 기록 상한. 브라우저처럼 오래된 것부터 버린다. */
const FILE_HISTORY_MAX = 50

let toastSeq = 0
let pendingSeq = 0

/** "3 commits" / "1 commit" — 확인 다이얼로그 문장을 세는 곳마다 s 를 붙이지 않게. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** 토스트에 붙이는 스크립트 출력 꼬리의 상한. 토스트는 로그 뷰어가 아니다 — 전문은 main 로그에 있다. */
const SCRIPT_TAIL_LINES = 4
const SCRIPT_TAIL_LINE_CHARS = 120

/** 출력의 마지막 몇 줄만, 줄마다 길이도 잘라서 돌려준다. 볼 것이 없으면 빈 문자열. */
function outputTail(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim())
  return lines
    .slice(-SCRIPT_TAIL_LINES)
    .map((line) => {
      const trimmed = line.trimEnd()
      return trimmed.length > SCRIPT_TAIL_LINE_CHARS
        ? `${trimmed.slice(0, SCRIPT_TAIL_LINE_CHARS)}…`
        : trimmed
    })
    .join('\n')
}

/** ["a", "b", "c"] → "a, b and c". 잃는 것을 한 문장으로 나열할 때 쓴다. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * 우측 작업 패널의 workspace 별 펼침/접힘 상태를 실행 간에 기억하기 위한 localStorage 키.
 * 값이 없는 workspace 는 settings.defaultRightPanelOpen 을 따른다.
 */
const RIGHT_PANEL_KEY = 'wooi.rightPanelOpen'
const SIDEBAR_WIDTH_KEY = 'wooi.sidebarWidth'
export const DEFAULT_SIDEBAR_WIDTH = 288

function readRememberedSidebarWidth(): number {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(value) && value > 0) return Math.max(180, Math.min(480, value))
  } catch {
    /* 기억 실패는 기본 너비로 폴백한다. */
  }
  return DEFAULT_SIDEBAR_WIDTH
}

/** 예전 단일 boolean 값도 읽어, 업그레이드 직후 기존 workspace 들의 초기값으로 쓸 수 있게 한다. */
function readRememberedRightPanels(): Record<string, boolean> | boolean | null {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY)
    if (v === 'true') return true
    if (v === 'false') return false
    if (v) {
      const parsed: unknown = JSON.parse(v)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, boolean] => {
            return typeof entry[1] === 'boolean'
          })
        )
      }
    }
  } catch {
    /* private 모드 등에서 실패해도 무시 — 기본값으로 폴백한다. */
  }
  return null
}

/** workspace 별 패널 상태를 기억해 둔다(다음 실행 복원용). */
function rememberRightPanels(openByWorkspace: Record<string, boolean>): void {
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, JSON.stringify(openByWorkspace))
  } catch {
    /* 무시 — 기억은 편의 기능일 뿐이다. */
  }
}

/** 리뷰 행이 기다리는 중인 정리 작업. 화면은 이 값으로 스피너 옆 문구를 고른다. */
export type ReviewBusyKind = 'archiving' | 'unarchiving' | 'deleting'

export const REVIEW_BUSY_LABEL: Record<ReviewBusyKind, string> = {
  archiving: 'Archiving…',
  unarchiving: 'Restoring…',
  deleting: 'Deleting…'
}

/**
 * 이 워크스페이스에 남아 있는 백그라운드 셸(에이전트가 두고 간 프로세스)의 수.
 *
 * 이것만 남았을 때 워크스페이스는 **idle** 이다([[claude/session]] syncStatus) — 그래서 상태 점은
 * 스피너 대신 이 수를 근거로 따로 표시를 낸다. 사이드바·⌘K·Overview 가 같은 판단을 쓰도록
 * 한 곳에 둔다.
 *
 * taskType 이 없는 행(서브에이전트)은 세지 않는다: 그건 살아 있으면 워크스페이스가 running 이라
 * 점이 이미 스피너다.
 */
export function backgroundTaskCount(agents: RunningAgent[] | undefined): number {
  return (agents ?? []).reduce((n, a) => n + (typeof a.taskType === 'string' ? 1 : 0), 0)
}

interface UIState {
  ready: boolean
  app: AppState | null
  selectedWorkspaceId: string | null
  transcripts: Record<string, ChatItem[]>
  loadedTranscripts: Record<string, boolean>
  scriptOutput: Record<string, string>
  scriptStatus: Record<string, ScriptStatus[]>
  /**
   * 컴포저가 아직 집어 가지 않은 첨부 이미지(Preview 스크린샷), 워크스페이스별.
   *
   * 컴포저를 거치지 않고 여기 모으는 이유는 캡처 버튼과 컴포저가 **다른 창**에 있을 수 있어서다
   * (Preview 는 분리한 work 창에서도 돈다). 지금 보고 있지 않은 워크스페이스로 찍었더라도
   * 그 워크스페이스로 돌아가면 컴포저가 그때 집어 간다.
   */
  composerAttachments: Record<string, ComposerAttachment[]>
  gitStatus: Record<string, GitStatus | null>
  prStatus: Record<string, PrStatus | null>
  stackProgress: Record<string, StackOpProgress | null>
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
   * workspace 별로 지금 살아 있는 서브에이전트·백그라운드 task 목록(사이드바 running 패널).
   * 'agents' 이벤트가 전량을 실어 오므로 병합하지 않고 통째로 교체한다. 영속되지 않는 휘발성
   * 상태이므로, 앱을 다시 띄우면 비어 있는 것이 정상이다(그 시점엔 세션도 죽어 있다).
   */
  runningAgents: Record<string, RunningAgent[]>
  /** API 재시도 중에만 존재하는 휘발성 사이드바 상태. */
  apiRetries: Record<string, ApiRetryState>
  /** 응답 본문이 보고한 실제 모델이 설정된 폴백일 때만 존재한다. */
  activeFallbackModels: Record<string, string>
  /** workspace 별 현재 세션 목표. ChatEvent 로만 채우고 디스크에는 쓰지 않는다. */
  goals: Record<string, WorkspaceGoal>
  /** workspace 별 다음 프롬프트 제안. 입력하거나 새 턴을 시작하면 즉시 버린다. */
  promptSuggestions: Record<string, string>
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
  /**
   * Changes 탭 diff 에 달아 둔, 아직 보내지 않은 라인 코멘트(workspace 별, 작성 순서).
   *
   * 초안과 같은 성격이라 workspace 를 오가도 살아남지만 디스크에는 남기지 않는다 — 보내는 순간
   * 대화 기록이 진짜 저장소가 되고, 안 보낸 코멘트를 다음 실행까지 끌고 다닐 이유는 없다.
   */
  diffComments: Record<string, DiffComment[]>
  /** workspace 별 대화 스크롤 위치(복원용). */
  scrollPositions: Record<string, number>
  /** workspace 별 스크립트 패널 열림 상태. */
  scriptPanelOpen: Record<string, boolean>
  /** 우측 작업 패널(파일/변경/체크 + 터미널)의 너비(px). 세로 분할 드래그로 조절. */
  rightWidth: number
  /** 왼쪽 사이드바 너비(px). */
  sidebarWidth: number
  /** workspace 별 우측 작업 패널 표시 여부. 값이 없으면 설정의 기본값을 따른다. */
  rightPanelOpen: Record<string, boolean>
  /** 대화 하나만 잠시 전부 펼치는 workspace 별 휘발성 상태. */
  toolVerbose: Record<string, boolean>
  toggleToolVerbose: (workspaceId: string) => void
  /** 우하단 터미널이 우측 컬럼 높이에서 차지하는 비율(0~1). 기본 0.5. 가로 분할 드래그로 조절. */
  terminalRatio: number
  /**
   * 지금 별도 창으로 떠 있는 패널(main 이 소유하는 값의 사본).
   *
   * 분리는 복제가 아니라 이동이다 — 여기서 true 인 패널은 메인 창에서 그리지 않는다.
   * 창을 닫으면 false 로 돌아오고 패널은 제자리(인라인)로 복귀한다([[paneWindows]]).
   */
  detachedPanes: PaneState
  /**
   * 대화창 위에 띄우는 큰 파일 뷰어. null 이면 닫혀 있다.
   * 우측 패널의 좁은 뷰어로는 코드를 읽기 어려워서, 브라우저처럼 앞/뒤로 오갈 수 있는
   * 전체 폭 뷰어를 따로 둔다(대화는 뒤에 그대로 살아 있고 닫으면 즉시 복귀한다).
   */
  fileViewer: FileViewerState | null
  /** 큰 파일 뷰어 왼쪽 트리의 너비(px). */
  fileViewerTreeWidth: number
  /**
   * 대화 검색(⇧⌘K)에서 고른 결과로 데려갈 항목. 대화창이 그 자리로 스크롤하고 나면 지운다.
   *
   * seq 는 같은 항목을 연달아 고를 때도 이동이 다시 일어나게 하는 토큰이다(값이 같으면
   * 리액트가 변화를 못 보고 두 번째 선택이 조용히 무시된다).
   */
  jumpTarget: { workspaceId: string; itemId: string; seq: number } | null
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
  /** 아카이브 IPC가 끝나기를 기다리는 workspace. 오래 걸리는 archive script 중에도 사이드바에 남겨 표시한다. */
  archivingWorkspaces: Record<string, boolean>
  /** 모든 renderer 진입점이 공유하는 아카이브 실행 경로. */
  archiveWorkspace: (
    workspaceId: string
  ) => Promise<{ archiveScriptFailure?: ArchiveScriptFailure }>
  /** 마지막 일괄 아카이브. 바로 뒤의 ⌘Z 또는 토스트 Undo 로만 한 번 복원한다. */
  undoableArchive: { workspaceIds: string[]; at: number } | null
  /** 한 리포에서 PR 이 병합된 활성 워크스페이스를 재확인 후 일괄 아카이브한다. */
  archiveMergedWorkspaces: (repoId: string) => Promise<void>
  /** 마지막 일괄 아카이브에서 실제로 성공한 워크스페이스를 모두 복원한다. */
  undoArchiveWorkspaces: () => Promise<void>
  /** 가장 최근 생성/일괄 아카이브 중 하나를 ⌘Z 로 되돌린다. */
  undoLastWorkspaceAction: () => Promise<void>

  /**
   * 열려 있는 PR 리뷰. null 이 아니면 전체 화면 리뷰 모드다(사이드바·대화창을 대체).
   * 리뷰는 workspace 와 무관하게 임의의 PR 을 대상으로 하므로 별도 축으로 둔다.
   */
  activeReviewId: string | null
  /**
   * 열려 있는 fan-out 비교 화면의 그룹 id. 리뷰와 같은 자리(대화창 위)를 쓰므로 둘은 서로를
   * 밀어낸다 — 워크스페이스를 고르면 둘 다 닫힌다.
   */
  activeFanoutGroupId: string | null
  /**
   * reviewId → 화면 상태(사이드카에서 읽어온 diff·지적·활동 + 선택/편집).
   * 리뷰의 **메타데이터는 여기 없다** — `app.reviews` 가 권위이고 상태 방송으로 갱신된다.
   */
  reviewViews: Record<string, ReviewViewState>

  init: () => Promise<void>
  /**
   * 분리한 패널 창(work/scripts)용 축소 초기화.
   *
   * 메인 창의 init 을 그대로 쓰면 알림음·Dock 배지·미확인 계산이 두 창에서 각각 돌아, 소리가
   * 두 번 나고 배지가 서로를 덮어쓴다. 패널이 실제로 읽는 것(앱 상태·git/PR·스크립트)만 채운다.
   */
  initPane: (workspaceId: string | null) => Promise<void>
  /** 분리한 창이 따라갈 워크스페이스를 바꾼다(메인 창의 선택을 그대로 반영). */
  setPaneWorkspace: (workspaceId: string | null) => void
  /** 패널을 별도 창으로 떼어 낸다(듀얼 모니터용). */
  detachPane: (kind: PaneKind) => void
  /** worktree 생성을 시작하고, 완료될 때까지 사이드바에 스피너 행을 즉시 띄운다. */
  createWorkspace: (
    repoId: string,
    args?: {
      name?: string
      baseBranch?: string
      fromPrNumber?: number
      parentWorkspaceId?: string | null
      /** 이 워크스페이스를 구동할 에이전트. 생략하면 전역 기본 백엔드. */
      agentBackend?: AgentBackendId
    },
    displayName?: string
  ) => Promise<string | undefined>
  /** 현재 대화와 코드 상태를 새 워크스페이스로 복제하고 그쪽으로 전환한다. */
  forkWorkspace: (workspaceId: string, opts?: { name?: string }) => Promise<string | undefined>
  /**
   * 같은 프롬프트로 후보 워크스페이스 여럿을 한 번에 만들고, 만들어지면 비교 화면을 연다.
   * 생성 중에는 createWorkspace 와 같은 자리표시 행을 후보 수만큼 띄운다.
   */
  createFanout: (
    repoId: string,
    args: { name?: string; prompt: string; slots: FanoutSlot[] }
  ) => Promise<void>
  /** fan-out 비교 화면을 연다(리뷰 화면과 자리를 다투므로 그쪽은 닫는다). */
  openFanoutCompare: (groupId: string) => void
  /** 비교 화면을 닫고 원래 보던 워크스페이스로 돌아간다. */
  closeFanoutCompare: () => void
  /**
   * 승자를 채택한다(확인 후). 나머지 형제는 아카이브되고 — 되살릴 수 있지만 미커밋 변경은
   * 사라지므로 — 무엇을 잃는지 먼저 센다.
   */
  requestAdoptFanoutWinner: (groupId: string, workspaceId: string) => Promise<void>
  /**
   * 지금 채택 중인 후보 id(없으면 null).
   *
   * 채택은 형제를 **하나씩** 아카이브하고, 형제마다 PR 제목을 `gh` 로 스냅샷한 뒤 worktree 를
   * 지운다 — 후보가 셋이면 몇 초가 걸린다. 그동안 화면이 아무 반응도 하지 않으면 사용자는
   * 버튼이 안 눌린 줄 알고 다시 누르는데, 그러면 이미 사라지는 중인 워크스페이스를 상대로
   * 두 번째 아카이브가 돌아간다. 그래서 진행 중임을 화면에 남기고 그 사이 입력을 막는다.
   */
  adoptingFanoutWorkspaceId: string | null
  /** 그룹 기록만 지운다(워크스페이스는 그대로). */
  forgetFanoutGroup: (groupId: string) => Promise<void>
  /**
   * 워크스페이스를 영구 삭제한다(확인 후). 아카이브와 달리 worktree·브랜치·대화 기록이 모두
   * 사라지며 되돌릴 수 없다 — 무엇을 잃는지(미커밋 변경·미푸시 커밋·쌓인 스택)를 먼저 알린다.
   */
  requestDeleteWorkspace: (workspaceId: string) => Promise<void>
  /**
   * 확인 없이 즉시 영구 삭제한다 — 물어보는 것은 호출부의 몫이다.
   * 지운 워크스페이스를 보고 있었다면 ⌘[ 와 같은 규칙으로 직전에 보던 곳으로 돌아간다.
   */
  deleteWorkspaceNow: (workspaceId: string) => Promise<void>
  /**
   * ⌘Z 로 되돌릴 수 있는 직전 워크스페이스 생성. 한 단계만 기억한다 — 되돌리기를 연달아 눌러
   * 예전 워크스페이스까지 지우는 것은 실행취소가 아니라 사고다([[undoCreate]] 참고).
   */
  undoableCreate: UndoableCreate | null
  /**
   * 방금 만든 워크스페이스를 취소한다(⌘Z). 아직 손대지 않았으면 묻지 않고 지우고, 이미 쓴
   * 흔적(세션·변경·커밋)이 있으면 일반 삭제와 같은 확인을 거친다.
   */
  undoCreateWorkspace: () => Promise<void>
  /** stacked 워크스페이스를 최신 base(부모 브랜치) 위로 rebase·force-push 한다. */
  restackWorkspace: (workspaceId: string) => Promise<void>
  /** 외부 병합으로 대기 중인 스택 캐스케이드를 실행한다(rebase + force-push — 사용자 승인 후). */
  applyStackSync: (workspaceId: string) => Promise<void>
  /** 한 번의 승인으로 스택을 아래부터 병합하고 뒤따르는 브랜치들을 다시 쓴다. */
  runMergeTrain: (
    workspaceId: string,
    method: PrMergeMethod,
    total: number
  ) => Promise<StackTrainResult>
  /** 대기 중인 스택 캐스케이드 계획을 무시한다. */
  dismissStackSync: (workspaceId: string) => Promise<void>
  /** PR 병합으로 뜬 아카이브 제안을 해제한다(같은 병합은 다시 제안하지 않는다). */
  dismissArchiveSuggest: (workspaceId: string) => Promise<void>
  /** 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다. */
  retargetBase: (workspaceId: string) => Promise<void>
  /** 어긋난 base 를 그대로 두기로 한다(그 base 를 채택하고 다시 묻지 않는다). */
  keepBase: (workspaceId: string) => Promise<void>
  /** 캐스케이드 단계별 결과를 토스트로 알린다(문제가 있으면 브랜치별로 나열). */
  reportCascade: (cascade: StackCascadeResult, successMsg: string) => void
  /** 방문 순서 스택(브라우저 뒤로가기용). 현재 선택은 포함하지 않고, 오래된 것이 앞이다. */
  workspaceHistory: string[]
  /**
   * @param opts.fromHistory 뒤로가기로 인한 선택 — 방문 스택에 다시 쌓지 않는다.
   */
  selectWorkspace: (id: string | null, opts?: { fromHistory?: boolean }) => Promise<void>
  /** ⌘[ — 직전에 보던 워크스페이스로 돌아간다(브라우저 뒤로가기). */
  goBackWorkspace: () => Promise<void>
  refreshGit: (workspaceId: string) => Promise<void>
  /** 진입 여부와 무관하게 모든(비아카이브) 워크스페이스의 git 상태를 한 번에 갱신한다. */
  refreshAllGit: () => Promise<void>
  /** 활성 리포를 한 번씩 fetch 한 뒤, 그 리포에 속한 워크스페이스 상태를 즉시 갱신한다. */
  fetchReposAndRefreshGit: () => Promise<void>
  refreshPr: (workspaceId: string) => Promise<void>
  /** PR 상태를 즉시(낙관적) 설정한다. 브랜치 전환 시 캐시된 값으로 헤더를 바로 갱신할 때 쓴다. */
  setPrStatus: (workspaceId: string, status: PrStatus | null) => void
  refreshScriptStatus: (workspaceId: string) => Promise<void>
  /**
   * 아직 받아 둔 출력이 없으면 main 의 꼬리 버퍼로 채운다.
   * 출력은 이벤트로만 흘러오므로, 나중에 뜬 창은 이게 없으면 돌고 있는 dev 서버의 로그를 못 본다.
   */
  seedScriptOutput: (workspaceId: string, scriptId: string) => Promise<void>
  /** 대기 중인 첨부를 컴포저로 넘긴다(꺼내면 목록에서 사라진다 — 두 번 붙지 않게). */
  takeComposerAttachments: (workspaceId: string) => ComposerAttachment[]
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
  clearPromptSuggestion: (workspaceId: string) => void
  /** diff 라인 코멘트를 하나 추가한다. 만들어진 id 를 돌려준다(방금 만든 카드를 지목하는 용도). */
  addDiffComment: (workspaceId: string, anchor: DiffCommentAnchor, body: string) => string
  /** 코멘트 본문을 고친다. 빈 본문은 무시한다(지우려면 removeDiffComment). */
  editDiffComment: (workspaceId: string, id: string, body: string) => void
  removeDiffComment: (workspaceId: string, id: string) => void
  clearDiffComments: (workspaceId: string) => void
  /** 모아 둔 코멘트를 한 통의 메시지로 에이전트에게 보내고 비운다. 보낼 게 없으면 아무것도 안 한다. */
  sendDiffComments: (workspaceId: string) => void
  /** /clear — 해당 workspace 의 대화 기록·컨텍스트 사용량을 화면에서 비운다(맥락 초기화). */
  resetTranscript: (workspaceId: string) => void
  /**
   * 대화 기록은 그대로 두고 컨텍스트 사용량 표시만 비운다(/agent 교체처럼 세션만 새로 시작할 때).
   * 다음 턴이 값을 다시 보내 줄 때까지 상태줄은 "—" 로 돌아간다.
   */
  resetContextUsage: (workspaceId: string) => void
  setScrollPosition: (workspaceId: string, top: number) => void
  setScriptPanelOpen: (workspaceId: string, open: boolean) => void
  /** 해당 workspace 의 에이전트 목록 접힘 상태를 뒤집는다. */
  toggleAgentsCollapsed: (workspaceId: string) => void
  /** 이미 펼쳐져 있어도 유지하며 해당 workspace 의 에이전트 목록을 펼친다. */
  expandAgents: (workspaceId: string) => void
  setRightWidth: (px: number) => void
  setSidebarWidth: (px: number) => void
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  setTerminalRatio: (ratio: number) => void
  /**
   * 큰 파일 뷰어를 연다. 이미 열려 있으면 그 파일로 이동하고 방문 기록에 쌓는다.
   * line 을 주면 그 줄로 스크롤한다.
   */
  /**
   * 대화 검색 결과로 이동한다 — 해당 워크스페이스를 열고 그 항목까지 스크롤한다.
   * 아카이브된 워크스페이스는 대화창이 없으므로 안내만 하고 이동하지 않는다.
   */
  jumpToTranscriptItem: (workspaceId: string, itemId: string) => Promise<void>
  /** 이동이 끝났다(또는 대상을 못 찾았다) — 대기 중인 목적지를 지운다. */
  clearJumpTarget: () => void
  openFileViewer: (workspaceId: string, path: string, line?: number) => void
  closeFileViewer: () => void
  /** 방문 기록에서 delta 만큼 이동(-1 뒤로, +1 앞으로). 범위를 벗어나면 아무것도 하지 않는다. */
  navigateFileViewer: (delta: number) => void
  toggleFileViewerTree: () => void
  setFileViewerTreeWidth: (px: number) => void
  /** 토스트를 띄우고 그 id 를 반환한다. actions 를 주면 인라인 버튼이 붙고 자동으로 닫히지 않는다. */
  pushToast: (kind: ToastKind, message: string, actions?: ToastAction[]) => string
  dismissToast: (id: string) => void
  /** worktree 전달 실패를 사용자에게 알린다. 에이전트 컨텍스트 실패는 error 로 구분해 띄운다. */
  reportCarryFailures: (failures?: CarryFailure[]) => void
  /**
   * 전달 목록에 등록돼 있는데 메인 체크아웃에 원본이 없어 아무것도 전달되지 않은 경로를 알린다.
   * 리포·경로당 한 번만 뜬다(uiFlags 에 기억). 원본이 생겨 전달되기 시작하면 기억을 지운다.
   */
  reportCarryMissing: (repoId: string, missing?: string[]) => void
  /**
   * 아카이브 스크립트 실패를 알린다. 아카이브·삭제는 실패해도 그대로 완료되므로,
   * 이 토스트가 없으면 정리되지 않은 컨테이너·프로세스가 조용히 남는다.
   */
  reportArchiveScriptFailure: (failure?: ArchiveScriptFailure) => void
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
    /** 리뷰할 PR 들, 아래(base 쪽)부터. 원소가 하나면 지금까지의 단일 PR 리뷰다. */
    prNumbers: number[]
    prompt: string
    agentBackend: AgentBackendId
    /** 생략하면 그 에이전트의 전역 기본값으로 돈다(모달의 "Default"). */
    model?: string | null
    effort?: EffortSetting | null
  }) => Promise<void>
  /** 사이드바에서 리뷰를 골라 화면에 띄운다(사이드카를 아직 안 읽었으면 함께 읽는다). */
  openReview: (reviewId: string) => void
  /** 리뷰의 diff·지적·활동을 사이드카에서 읽어 화면 상태에 채운다(한 번만). */
  loadReview: (reviewId: string) => Promise<void>
  /** 게시하지 않은 지적이 있으면 확인을 받고 리뷰를 닫는다(사이드바 ×·화면 × 공용). */
  requestCloseReview: (reviewId: string) => Promise<void>
  /** 리뷰를 완전히 삭제한다(워크트리·ref·기록 모두). */
  closeReview: (reviewId: string) => Promise<void>
  /** 확인을 받고 리뷰를 아카이브한다(사이드바 아카이브 버튼·⇧⌘⌫ 공용). */
  requestArchiveReview: (reviewId: string) => Promise<void>
  /** 워크트리만 지우고 결과는 남긴다. */
  archiveReview: (reviewId: string) => Promise<void>
  /** 아카이브된 리뷰를 되살린다(워크트리 재구성). */
  unarchiveReview: (reviewId: string) => Promise<void>
  /** 실행 중인 리뷰를 중단한다. */
  cancelReview: (reviewId: string) => Promise<void>
  /** 실패·중단된 리뷰를 이어서 다시 돌린다. */
  resumeReview: (reviewId: string) => Promise<void>
  /**
   * 아카이브·되살리기·삭제 IPC 가 끝나기를 기다리는 리뷰. 셋 다 워크트리와 ref 를 만지느라
   * 초 단위로 걸리는데(되살리기는 원격 fetch 까지 한다), 그동안 아무 표시가 없으면 사용자는
   * 눌린 줄도 모르고 다시 누른다. 워크스페이스의 archivingWorkspaces 와 같은 어휘다.
   */
  busyReviews: Record<string, ReviewBusyKind>
  toggleFinding: (reviewId: string, findingId: string) => void
  /** 아직 게시하지 않은 항목 전체를 선택/해제한다. */
  toggleAllFindings: (reviewId: string, on: boolean) => void
  editFinding: (reviewId: string, findingId: string, body: string) => void
  /** 안 달기로 한 지적을 목록에서 버린다. */
  dismissFinding: (reviewId: string, findingId: string) => Promise<void>
  /** 선택된(또는 지정된) 지적을 순서대로 개별 코멘트로 게시한다. */
  postFindings: (reviewId: string, findingIds: string[]) => Promise<{ ok: number; failed: number }>
  /**
   * 판정을 제출한다. 스택이면 레이어마다 한 건씩 나가므로 계획을 통째로 넘긴다.
   * 전부 성공했을 때만 true(일부만 성공하면 화면을 열어 둔 채 나머지를 다시 낼 수 있게 한다).
   */
  submitReview: (
    reviewId: string,
    entries: Array<{ prNumber: number; verdict: ReviewVerdict; body: string }>
  ) => Promise<boolean>
  /** 활성 리뷰들의 답글·새 커밋을 한 번 확인한다. */
  pollReviews: () => Promise<void>
  /** 인라인 스레드에 답장한다. 성공하면 true. */
  replyToThread: (reviewId: string, commentId: number, body: string) => Promise<boolean>
  /** 앞선 맥락 위에서 추가 지시를 보낸다. */
  followUpReview: (reviewId: string, text: string) => Promise<void>
  /** 오른쪽 패널의 탭을 바꾼다(리뷰별로 기억된다). */
  setReviewTab: (reviewId: string, tab: ReviewTab) => void
  /** 파일 1건의 "봤음" 표시를 뒤집는다. 스택에서는 같은 경로가 여러 레이어에 있어 PR 도 받는다. */
  toggleFileViewed: (reviewId: string, path: string, prNumber?: number) => Promise<void>
}

export const stackBusy = (state: UIState, workspaceId: string): boolean =>
  !!state.stackProgress[workspaceId] && !state.stackProgress[workspaceId]!.finished

/**
 * 버튼을 누른 **즉시** 세우는 낙관적 진행 표시. main 의 첫 이벤트가 도착하기까지의 IPC 왕복
 * 동안 컨트롤이 죽은 것처럼 보이지 않게 하는 것이 목적이다 — 체감 속도의 절반이 여기서 온다.
 * 돌려준 객체는 그대로 소유권 표식으로도 쓴다(dropIfUntouched 참고).
 */
function optimisticStackProgress(
  workspaceId: string,
  kind: StackOpProgress['kind'],
  total: number | null
): StackOpProgress {
  return {
    workspaceId,
    kind,
    total,
    done: [],
    current: null,
    finished: false,
    startedAt: Date.now()
  }
}

let initialized = false

// 창 포커스 상태(완료를 미확인으로 잡을지 판단용). DOM 의 document.hasFocus() 는 Dock 클릭·앱
// 전환 시 신뢰할 수 없어, main 의 권위 있는 focus/blur 이벤트로 갱신한다. 시작 시 포커스 가정.
let windowFocused = true

// 모든 워크트리의 git 상태를 주기적으로 갱신하기 위한 타이머. 진입하지 않은 워크스페이스도
// 사이드바 배지(변경 파일 수·ahead/behind·충돌)가 최신으로 보이도록 백그라운드에서 폴링한다.
let statusPollTimer: ReturnType<typeof setInterval> | null = null
const STATUS_POLL_INTERVAL_MS = 15_000

// PR 조회는 git 보다 비싸므로 느린 주기로 따로 돈다. listOpenPrs 는 리포별 10초 캐시와 in-flight
// 합류를 쓰므로 한 틱에 리포당 gh pr list 한 번이고, getPrMeta 는 실제 sync 후보가 있을 때만
// 불린다. detectStackSync 도 이미 계획이 있으면 즉시 끝나므로 활성 워크스페이스 수만큼 중복된
// 네트워크 비용이 그대로 늘어나지는 않는다.
let prPollTimer: ReturnType<typeof setInterval> | null = null
const PR_POLL_INTERVAL_MS = 45_000

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

/**
 * 에이전트가 거둬들인 지적을 화면 상태에서 함께 걷어낸다.
 *
 * 목록에서만 빼면 안 된다 — 선택·편집본·게시 실패 표시가 사라진 지적의 id 로 남아, 다음
 * "선택한 것 모두 게시" 가 유령 id 를 집어 든다(사용자의 Discard 가 하는 정리와 같다).
 */
function dropFindings(
  findings: ReviewFinding[],
  removed: string[] | undefined,
  view: ReviewViewState
): Partial<ReviewViewState> {
  if (!removed?.length) return { findings }
  const gone = new Set(removed)
  const prune = <T>(bag: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(bag).filter(([id]) => !gone.has(id)))
  return {
    findings: findings.filter((f) => !gone.has(f.id)),
    selected: prune(view.selected),
    edits: prune(view.edits),
    posting: prune(view.posting)
  }
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
  workspaceHistory: [],
  transcripts: {},
  loadedTranscripts: {},
  scriptOutput: {},
  scriptStatus: {},
  composerAttachments: {},
  gitStatus: {},
  prStatus: {},
  stackProgress: {},
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
  apiRetries: {},
  activeFallbackModels: {},
  goals: {},
  promptSuggestions: {},
  agentsCollapsed: {},
  drafts: {},
  messageQueue: {},
  diffComments: {},
  scrollPositions: {},
  scriptPanelOpen: {},
  rightWidth: 460,
  sidebarWidth: readRememberedSidebarWidth(),
  rightPanelOpen: {},
  toolVerbose: {},
  toggleToolVerbose: (workspaceId) =>
    set((s) => ({ toolVerbose: { ...s.toolVerbose, [workspaceId]: !s.toolVerbose[workspaceId] } })),
  terminalRatio: 0.5,
  detachedPanes: { work: false, scripts: false },
  fileViewer: null,
  fileViewerTreeWidth: 260,
  jumpTarget: null,
  toasts: [],
  confirmState: null,
  overlayOpen: false,
  setOverlayOpen: (open) => {
    if (get().overlayOpen !== open) set({ overlayOpen: open })
  },
  pending: [],
  archivingWorkspaces: {},
  undoableArchive: null,
  activeReviewId: null,
  activeFanoutGroupId: null,
  adoptingFanoutWorkspaceId: null,
  reviewViews: {},
  busyReviews: {},

  archiveWorkspace: async (workspaceId) => {
    if (get().archivingWorkspaces[workspaceId]) return {}
    set((s) => ({
      archivingWorkspaces: { ...s.archivingWorkspaces, [workspaceId]: true }
    }))
    try {
      const result = await window.api.workspace.archive(workspaceId)
      // archive script 가 도는 동안 사용자가 다른 워크스페이스로 이동할 수 있다. 완료 시점에도
      // 아카이브한 워크스페이스를 보고 있을 때만 Overview 로 나가야 새 선택을 덮어쓰지 않는다.
      if (get().selectedWorkspaceId === workspaceId) void get().selectWorkspace(null)
      return result
    } finally {
      set((s) => {
        const next = { ...s.archivingWorkspaces }
        delete next[workspaceId]
        return { archivingWorkspaces: next }
      })
    }
  },

  archiveMergedWorkspaces: async (repoId) => {
    const candidates = get().app?.workspaces.filter((w) => w.repoId === repoId && !w.archived) ?? []
    if (!candidates.length) return

    // 버튼을 누른 시점의 GitHub 상태를 다시 읽는다. 오래된 폴링 결과만 믿고 열린 PR 을
    // 치우는 것은 이 기능의 위험도에 맞지 않는다.
    await Promise.allSettled(candidates.map((w) => get().refreshPr(w.id)))
    const s = get()
    const merged = candidates.filter((w) => s.prStatus[w.id]?.state === 'merged')
    if (!merged.length) {
      s.pushToast('info', 'No workspaces with merged pull requests to archive.')
      return
    }
    const names = merged.map((w) => workspaceDisplayName(w, s.prStatus[w.id]?.title))
    const running = merged.filter((w) => w.status === 'running').length
    const changed = merged.reduce((n, w) => n + (s.gitStatus[w.id]?.changedFiles ?? 0), 0)
    const ok = await s.confirm({
      title: `Archive ${plural(merged.length, 'workspace')} with merged pull requests?`,
      body: [
        `Archives ${joinList(names)}.`,
        'Their worktrees are removed, but branches, pull requests and conversations are kept.',
        changed ? `You lose ${plural(changed, 'uncommitted file')} across them.` : '',
        running ? `${plural(running, 'workspace')} still working — their turns are stopped.` : '',
        'You can undo this immediately with ⌘Z.'
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: `Archive ${merged.length}`,
      danger: true
    })
    if (!ok) return

    const archived: string[] = []
    let failed = 0
    for (const w of merged) {
      try {
        const res = await get().archiveWorkspace(w.id)
        get().reportArchiveScriptFailure(res.archiveScriptFailure)
        archived.push(w.id)
      } catch {
        failed++
      }
    }
    if (!archived.length) {
      get().pushToast('error', 'Could not archive the merged workspaces.')
      return
    }
    set({ undoableArchive: { workspaceIds: archived, at: Date.now() } })
    get().pushToast(
      failed ? 'error' : 'success',
      `Archived ${plural(archived.length, 'merged workspace')}${
        failed ? `; ${failed} failed` : ''
      }. Press ⌘Z to undo.`,
      [{ label: 'Undo', run: () => void get().undoArchiveWorkspaces() }]
    )
  },

  undoArchiveWorkspaces: async () => {
    const undoable = get().undoableArchive
    if (!undoable || Date.now() - undoable.at > UNDO_CREATE_WINDOW_MS) {
      if (undoable) set({ undoableArchive: null })
      get().pushToast('info', 'Nothing to undo.')
      return
    }
    // 먼저 소비해 중복 ⌘Z/더블클릭이 같은 worktree 를 동시에 만들지 못하게 한다.
    set({ undoableArchive: null })
    let restored = 0
    const errors: string[] = []
    for (const id of undoable.workspaceIds) {
      const res: Awaited<ReturnType<typeof window.api.workspace.unarchive>> =
        await window.api.workspace
          .unarchive(id)
          .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      if (res.error) errors.push(res.error)
      else {
        restored++
        get().reportCarryFailures(res.carryFailures)
        // 언아카이브도 worktree 를 새로 만들므로 전달이 다시 일어난다 — 원본 없음도 같이 본다.
        const repoId = get().app?.workspaces.find((w) => w.id === id)?.repoId
        if (repoId) get().reportCarryMissing(repoId, res.carryMissing)
      }
    }
    if (errors.length) {
      get().pushToast(
        'error',
        `Restored ${restored}; ${errors.length} failed.\n${errors.join('\n')}`
      )
    } else {
      get().pushToast('success', `Restored ${plural(restored, 'workspace')}.`)
    }
  },

  undoLastWorkspaceAction: async () => {
    const s = get()
    const archiveAt =
      s.undoableArchive && Date.now() - s.undoableArchive.at <= UNDO_CREATE_WINDOW_MS
        ? s.undoableArchive.at
        : -1
    if (archiveAt > (s.undoableCreate?.at ?? -1)) {
      await s.undoArchiveWorkspaces()
    } else {
      await s.undoCreateWorkspace()
    }
  },

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
    // 우측 패널: workspace 별 기억값을 복원한다. 예전 단일 값이면 기존 workspace 모두에
    // 한 번 적용해 마이그레이션하고, 기억값이 없는 workspace 는 설정 기본값을 따른다.
    const remembered = readRememberedRightPanels()
    const rightPanelOpen =
      typeof remembered === 'boolean'
        ? Object.fromEntries(app.workspaces.map((workspace) => [workspace.id, remembered]))
        : (remembered ?? {})
    if (typeof remembered === 'boolean') rememberRightPanels(rightPanelOpen)
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

    if (!prPollTimer) {
      prPollTimer = setInterval(() => {
        if (!windowFocused) return
        // 네트워크 git 작업은 더 느린 PR 틱에 얹고, 15초 로컬 상태 폴링과는 분리한다.
        void get().fetchReposAndRefreshGit()
        for (const workspace of get().app?.workspaces ?? []) {
          if (!workspace.archived) void get().refreshPr(workspace.id)
        }
      }, PR_POLL_INTERVAL_MS)
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

    // 패널을 토글할 때마다(키보드 ⌘J·버튼 등 경로 무관) workspace 별 상태를 기억해 둔다.
    useStore.subscribe((state, prev) => {
      if (state.rightPanelOpen !== prev.rightPanelOpen) rememberRightPanels(state.rightPanelOpen)
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
        const staleComments = Object.keys(s.diffComments).filter((id) => !live.has(id))
        if (!stale.length && !staleRunning.length && !staleQueue.length && !staleComments.length) {
          return { app: next }
        }
        const unread = { ...s.unread }
        for (const id of stale) delete unread[id]
        const runningSince = { ...s.runningSince }
        for (const id of staleRunning) delete runningSince[id]
        const messageQueue = { ...s.messageQueue }
        for (const id of staleQueue) delete messageQueue[id]
        const diffComments = { ...s.diffComments }
        for (const id of staleComments) delete diffComments[id]
        return { app: next, unread, runningSince, messageQueue, diffComments }
      })
    })

    window.api.onStackProgress((progress) => {
      set((s) => ({
        stackProgress: { ...s.stackProgress, [progress.workspaceId]: progress }
      }))
      if (!progress.finished) return
      setTimeout(() => {
        set((s) => {
          // 같은 workspace 에서 이미 다음 작업이 시작됐으면 이전 작업의 타이머가 지우지 않는다.
          if (s.stackProgress[progress.workspaceId]?.startedAt !== progress.startedAt) return s
          return {
            stackProgress: { ...s.stackProgress, [progress.workspaceId]: null }
          }
        })
      }, 4000)
    })

    // OS 알림 클릭 등으로 main 이 요청한 workspace 선택.
    window.api.onSelectWorkspace((workspaceId) => {
      void get().selectWorkspace(workspaceId)
    })

    // 별도 창으로 분리한 패널의 열림/닫힘. 메인 창은 이 값으로 인라인 패널을 감추거나 되돌린다
    // — 분리는 복제가 아니라 이동이라, 같은 패널이 두 곳에 동시에 있으면 안 된다([[paneWindows]]).
    // 창이 늦게 떠서 방송을 놓쳤을 수 있으므로 현재 값을 한 번 읽고 시작한다.
    void window.api.pane.getState().then((state) => set({ detachedPanes: state }))
    window.api.pane.onState((state) => set({ detachedPanes: state }))

    // 분리한 창에는 리포 설정 모달이 없다 — 그쪽에서 누른 "Set a dev command" 가 여기로 온다.
    window.api.onOpenRepoSettings((repoId) => openRepoSettings(repoId))

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
      void get().fetchReposAndRefreshGit()
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
    // 미확인은 이 스토어(렌더러 메모리)에만 있어서 원격 투영이 볼 수 없다. 폰에도 같은 점을
    // 그리려면 바뀔 때마다 올려 줘야 한다 — 반대 방향(폰에서 읽음)은 이미 onRemoteRead 로 온다.
    // 원격이 꺼져 있으면 main 쪽이 곧바로 반환하므로 여기서 따로 게이팅하지 않는다.
    const pushUnreadToRemote = (state: UIState): void => {
      void window.api.remote
        .setUnread(Object.keys(state.unread).filter((id) => state.unread[id]))
        .catch(() => {
          // 브리지가 아직 없거나 원격이 꺼져 있다 — 폰이 없으면 알릴 것도 없다.
        })
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
      if (state.unread !== prev.unread) pushUnreadToRemote(state)
    })
    // 시작할 때 한 번 — 렌더러를 새로고침하면 미확인은 비지만 main 은 직전 목록을 그대로
    // 들고 있다. 여기서 비워 주지 않으면 폰에 존재하지 않는 미확인이 영영 남는다.
    pushUnreadToRemote(useStore.getState())

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

        // 스택 자식의 인계 보고는 이 워크스페이스의 턴과 무관하게 **아무 때나** 도착한다.
        // 아래 status 경로(턴이 idle 로 정착할 때)는 그래서 이 경우를 잡지 못한다 — 부모가
        // 쉬고 있으면 보고가 와도 사이드바에 아무 변화가 없어 그대로 묻힌다.
        if (event.item.type === 'handoff') {
          const s = get()
          if (notifyEnabled(s, workspaceId, 'completed', 'sound')) playNotification()
          if (workspaceId !== s.selectedWorkspaceId || !windowFocused) {
            set({ unread: { ...s.unread, [workspaceId]: true } })
          }
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
        if (event.type === 'session' && event.model && event.isFallback !== undefined) {
          set((s) => {
            const activeFallbackModels = { ...s.activeFallbackModels }
            if (event.isFallback) activeFallbackModels[workspaceId] = event.model!
            else delete activeFallbackModels[workspaceId]
            return { activeFallbackModels }
          })
        }
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
          // 지난 턴의 다음 프롬프트 제안도 여기서 버린다. 컴포저 전송은 스스로 지우지만, 부모
          // 워크스페이스의 알림이나 사용량 제한 자동 재개처럼 입력창을 거치지 않고 시작하는
          // 턴도 있다 — 그 턴이 새 제안 없이 끝나면 한 턴 지난 제안이 되살아난다.
          get().clearPromptSuggestion(workspaceId)
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
        // 실행 중이 아닌 workspace 에 살아 있는 **에이전트**가 있을 수는 없다(세션의 syncStatus 는
        // 하나라도 남아 있으면 running 을 유지한다). 그래서 idle/error 를 보면 에이전트 행을
        // 비운다 — 호스트가 죽어 종료 알림이 아예 오지 않는 경로에서 스피너가 영구히 남는 것을
        // 막는 안전망이다.
        //
        // 백그라운드 task 행(taskType 이 실린 행)만은 남긴다. 백그라운드 Bash 는 상태를 붙잡지
        // 않으므로([[claude/session]] syncStatus) idle 과 공존하는 것이 정상이고, 그 행이 바로
        // "대화는 끝났지만 이 워크트리에 아직 도는 셸이 있다" 를 알리는 유일한 자리다. 여기서
        // 같이 지우면 상태 점도 idle, 목록도 비어 — 아무 데서도 알 수 없게 된다.
        if (event.type === 'status' && event.status !== 'running') {
          set((s) => {
            const current = s.runningAgents[workspaceId]
            if (!current) return {}
            const tasks = current.filter((agent) => typeof agent.taskType === 'string')
            if (tasks.length === current.length) return {}
            const runningAgents = { ...s.runningAgents }
            if (tasks.length === 0) delete runningAgents[workspaceId]
            else runningAgents[workspaceId] = tasks
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
      } else if (event.type === 'workingTreeChanged') {
        // 턴이 끝나기를 기다리지 않고 Changes 패널을 따라가게 한다(패널은 gitStatus 의 변경 파일
        // 수가 바뀌면 diff 를 다시 읽는다). 파일을 건드릴 때마다 오므로 턴당 서너 번 수준이다.
        void get().refreshGit(workspaceId)
      } else if (event.type === 'agents') {
        // REPLACE 시맨틱 — 전량이 실려 오므로 병합하지 않는다. 빈 배열이면 키를 지워, 사이드바가
        // 워크스페이스를 세는 자리에서 "빈 배열이 있는 키"를 따로 걸러내지 않아도 되게 한다.
        set((s) => {
          const runningAgents = { ...s.runningAgents }
          if (event.agents.length === 0) delete runningAgents[workspaceId]
          else runningAgents[workspaceId] = event.agents
          return { runningAgents }
        })
      } else if (event.type === 'apiRetry') {
        set((s) => {
          const apiRetries = { ...s.apiRetries }
          if (event.retry) apiRetries[workspaceId] = event.retry
          else delete apiRetries[workspaceId]
          return { apiRetries }
        })
      } else if (event.type === 'goal') {
        set((s) => {
          const goals = { ...s.goals }
          if (event.goal) goals[workspaceId] = event.goal
          else delete goals[workspaceId]
          return { goals }
        })
      } else if (event.type === 'promptSuggestion') {
        set((s) => {
          const promptSuggestions = { ...s.promptSuggestions }
          if (event.suggestion) promptSuggestions[workspaceId] = event.suggestion
          else delete promptSuggestions[workspaceId]
          return { promptSuggestions }
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
            // 다시 돌기 시작했으면 지난 실패 문구를 걷는다 — 그대로 두면 성공한 뒤에도 옛
            // 오류가 화면에 붙어 있다(이 값은 이 실행 동안만 사는 사본이다).
            return event.status === 'preparing' || event.status === 'running' ? { error: null } : {}
          case 'diff':
            return { diffs: event.diffs }
          case 'progress':
            // 진행 로그는 화면 표시용이라 무한정 쌓아둘 이유가 없다.
            return { progress: [...v.progress, event.item].slice(-200) }
          case 'findings':
            // 후속 턴의 지적은 기존 목록에 덧붙는다(앞선 지적은 이미 게시됐을 수 있다).
            // 에이전트가 거둬들인 것은 함께 빠진다 — 같은 이벤트로 와야 화면이 한 번에 맞는다.
            return dropFindings(mergeFindings(v.findings, event.findings), event.removed, v)
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

    // 폰에서 그 워크스페이스를 열어 읽었다 — 데스크톱의 미확인 표시도 함께 풀어야 한다.
    // 미확인은 이 스토어(렌더러 메모리)에만 있어서, 폰이 직접 지울 방법이 없다.
    window.api.onRemoteRead((workspaceId: string) => {
      const s = get()
      if (!s.unread[workspaceId]) return
      const unread = { ...s.unread }
      delete unread[workspaceId]
      set({ unread })
    })

    window.api.onScriptOutput(({ workspaceId, scriptId, chunk }) => {
      const key = scriptKey(workspaceId, scriptId)
      const out = get().scriptOutput
      set({ scriptOutput: { ...out, [key]: (out[key] ?? '') + chunk } })
    })

    // Preview 스크린샷. 방송은 모든 창이 받지만 컴포저는 메인 창에만 있으므로 여기서만 모은다
    // (분리한 창에서 모으면 아무도 집어 가지 않는 이미지가 그 창의 메모리에 쌓인다).
    window.api.onComposerAttach(({ workspaceId, ...attachment }) => {
      set((s) => ({
        composerAttachments: {
          ...s.composerAttachments,
          [workspaceId]: [...(s.composerAttachments[workspaceId] ?? []), attachment]
        }
      }))
    })

    window.api.onScriptExit(({ workspaceId, scriptId, code }) => {
      const key = scriptKey(workspaceId, scriptId)
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
      if (scriptId === 'setup') {
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

  initPane: async (workspaceId) => {
    if (initialized) return
    initialized = true

    set({ selectedWorkspaceId: workspaceId })

    const app = await window.api.getState()
    set({ app, ready: true })
    window.api.onState((next) => set({ app: next }))

    // 이 창이 따라갈 워크스페이스는 메인 창의 선택이 정한다.
    window.api.pane.onWorkspace((next) => get().setPaneWorkspace(next))

    // 스크립트 출력은 이벤트로만 흘러온다 — 메인 창과 같은 방식으로 누적한다(이 창이 뜨기 전의
    // 로그는 ScriptPanel 이 main 의 꼬리 버퍼에서 한 번 채운다 — seedScriptOutput).
    window.api.onScriptOutput(({ workspaceId: id, scriptId, chunk }) => {
      const key = scriptKey(id, scriptId)
      const out = get().scriptOutput
      set({ scriptOutput: { ...out, [key]: (out[key] ?? '') + chunk } })
    })
    window.api.onScriptExit(({ workspaceId: id, scriptId, code }) => {
      const key = scriptKey(id, scriptId)
      const out = get().scriptOutput
      set({
        scriptOutput: {
          ...out,
          [key]: (out[key] ?? '') + `\n[wooi] exited (code ${code ?? '?'})\n`
        }
      })
      void get().refreshScriptStatus(id)
    })

    // 인증 상태는 Check 탭(gh 필요)이 읽는다.
    void get().refreshAuth()

    const refresh = (): void => {
      const id = get().selectedWorkspaceId
      if (!id) return
      void get().refreshGit(id)
      void get().refreshPr(id)
      void get().refreshScriptStatus(id)
    }
    refresh()
    // 이 창만 보고 있는 동안에도 변경 파일 수·PR 상태가 늙지 않도록 주기적으로 따라잡는다.
    // 메인 창의 전체 폴링과 달리 지금 보고 있는 워크스페이스 하나만 본다.
    if (!statusPollTimer) statusPollTimer = setInterval(refresh, STATUS_POLL_INTERVAL_MS)
  },

  setPaneWorkspace: (workspaceId) => {
    if (get().selectedWorkspaceId === workspaceId) return
    set({ selectedWorkspaceId: workspaceId })
    if (!workspaceId) return
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
    void get().refreshScriptStatus(workspaceId)
  },

  detachPane: (kind) => {
    void window.api.pane.open(kind, get().selectedWorkspaceId)
  },

  createWorkspace: async (repoId, args, displayName) => {
    // worktree 체크아웃(git)은 큰 리포에서 수 초가 걸리므로, 먼저 자리표시 행을 띄워
    // 즉각적인 피드백을 주고 git 은 그동안 백그라운드로 진행한다. 완료 시 실제 행으로 교체된다.
    const placeholderId = `pending:${++pendingSeq}`
    set((s) => ({
      pending: [
        ...s.pending,
        {
          id: placeholderId,
          repoId,
          name: displayName ?? '',
          parentWorkspaceId: args?.parentWorkspaceId ?? null
        }
      ]
    }))

    let res: {
      workspaceId?: string
      existingWorkspaceId?: string
      existingWorkspaceArchived?: boolean
      name?: string
      branch?: string
      error?: string
      carryFailures?: CarryFailure[]
      carryMissing?: string[]
      setupSkippedForUntrustedPr?: boolean
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
      return undefined
    }
    if (res.existingWorkspaceId) {
      void get().selectWorkspace(res.existingWorkspaceId)
      get().pushToast(
        'info',
        res.existingWorkspaceArchived
          ? 'A workspace for this pull request already exists and is archived.'
          : 'A workspace for this pull request already exists.'
      )
      return res.existingWorkspaceId
    }
    if (res.workspaceId) {
      void get().selectWorkspace(res.workspaceId)
      // 방금 만든 것 하나만 되돌리기 대상으로 기억한다. 토스트에 ⌘Z 를 적어 두는 이유는,
      // 되돌리고 싶은 그 순간이 이 기능을 발견해야 하는 유일한 순간이기 때문이다.
      set({ undoableCreate: { workspaceId: res.workspaceId, at: Date.now() } })
      if (res.name && res.branch) {
        get().pushToast('success', `Created workspace “${res.name}” on ${res.branch} — ⌘Z to undo`)
      }
      get().reportCarryFailures(res.carryFailures)
      get().reportCarryMissing(repoId, res.carryMissing)
      if (res.setupSkippedForUntrustedPr) {
        get().pushToast('info', "Setup wasn't run automatically for someone else's fork.")
      }
      get().suggestCarry(repoId, res.workspaceId, res.carrySuggestions)
      return res.workspaceId
    }
    return undefined
  },

  forkWorkspace: async (workspaceId, opts) => {
    const source = get().app?.workspaces.find((w) => w.id === workspaceId)
    if (!source) return undefined
    let res: Awaited<ReturnType<typeof window.api.workspace.fork>>
    try {
      res = await window.api.workspace.fork(workspaceId, {
        ...opts,
        showSemanticsNotice: !readUiFlag(FORK_SEMANTICS_NOTICE_SEEN)
      })
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) }
    }
    if (res.error) {
      get().pushToast('error', res.error)
      return undefined
    }
    if (!res.workspaceId) return undefined
    setUiFlag(FORK_SEMANTICS_NOTICE_SEEN, true)
    void get().selectWorkspace(res.workspaceId)
    set({ undoableCreate: { workspaceId: res.workspaceId, at: Date.now() } })
    if (res.name && res.branch) {
      get().pushToast(
        'success',
        `Forked conversation into “${res.name}” on ${res.branch} — ⌘Z to undo`
      )
    }
    get().reportCarryFailures(res.carryFailures)
    get().reportCarryMissing(source.repoId, res.carryMissing)
    get().suggestCarry(source.repoId, res.workspaceId, res.carrySuggestions)
    return res.workspaceId
  },

  createFanout: async (repoId, args) => {
    // 후보 수만큼 자리표시 행을 띄운다. worktree 를 순차로 만들기 때문에 첫 후보가 나타난 뒤에도
    // 한동안 나머지가 비어 있는데, 자리표시가 없으면 그 사이 "일부만 만들어졌다"로 보인다.
    const placeholders = args.slots.map((_, i) => ({
      id: `pending:${++pendingSeq}`,
      repoId,
      // 이름을 비워 두면 뿌리 이름은 main 이 정한다 — 여기서 지어내면 자리표시와 실제 행의
      // 이름이 어긋난다. 그때는 빈 문자열로 두어 행이 "Creating…" 만 보이게 한다.
      name: args.name?.trim() ? fanoutSlotName(args.name.trim(), i) : '',
      parentWorkspaceId: null
    }))
    set((s) => ({ pending: [...s.pending, ...placeholders] }))

    let res: CreateFanoutResult
    try {
      res = await window.api.fanout.create({ repoId, ...args })
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) }
    }

    const ids = new Set(placeholders.map((p) => p.id))
    set((s) => ({ pending: s.pending.filter((p) => !ids.has(p.id)) }))

    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    // 일부만 실패한 경우에도 나머지는 살아 있다. 조용히 넘기면 사용자는 자기가 고른 수보다
    // 적은 후보를 보면서 이유를 알 수 없다.
    if (res.failures?.length) {
      get().pushToast(
        'error',
        `${res.failures.length} of ${args.slots.length} candidates could not be created:\n${res.failures.join('\n')}`
      )
    }
    get().reportCarryFailures(res.carryFailures)
    get().reportCarryMissing(repoId, res.carryMissing)
    if (res.workspaceIds?.length)
      get().suggestCarry(repoId, res.workspaceIds[0], res.carrySuggestions)
    if (res.groupId) get().openFanoutCompare(res.groupId)
  },

  openFanoutCompare: (groupId) => {
    set({ activeFanoutGroupId: groupId, activeReviewId: null })
    // 비교 화면의 후보 카드는 git 요약(N changed · ↑ahead)을 그대로 읽어 쓴다. 진입 시 한 번
    // 새로 고쳐 두지 않으면, 아직 한 번도 연 적 없는 후보의 칸이 비어 있다.
    const group = get().app?.fanoutGroups.find((g) => g.id === groupId)
    for (const id of group?.workspaceIds ?? []) void get().refreshGit(id)
  },

  closeFanoutCompare: () => set({ activeFanoutGroupId: null }),

  requestAdoptFanoutWinner: async (groupId, workspaceId) => {
    const s = get()
    // 이미 채택이 돌고 있으면 무시한다. 화면도 버튼을 잠그지만, 그 사이 도착한 단축키·이벤트가
    // 두 번째 채택을 시작하면 사라지는 중인 워크스페이스를 상대로 아카이브가 겹친다.
    if (s.adoptingFanoutWorkspaceId) return
    const group = s.app?.fanoutGroups.find((g) => g.id === groupId)
    const winner = s.app?.workspaces.find((w) => w.id === workspaceId)
    if (!group || !winner) return

    /** 진행 표시를 켜고 채택을 돌린다. 실패해도 표시는 반드시 꺼야 한다 — 켜진 채로 남으면
     *  다시 시도할 방법이 없다. */
    const adopt = async (): Promise<AdoptFanoutResult> => {
      const archivingIds = group.workspaceIds.filter(
        (id) => id !== workspaceId && !s.app?.workspaces.find((w) => w.id === id)?.archived
      )
      set((state) => ({
        adoptingFanoutWorkspaceId: workspaceId,
        archivingWorkspaces: archivingIds.reduce(
          (next, id) => ({ ...next, [id]: true }),
          state.archivingWorkspaces
        )
      }))
      try {
        return await window.api.fanout.adopt(groupId, workspaceId)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      } finally {
        set((state) => {
          const archivingWorkspaces = { ...state.archivingWorkspaces }
          for (const id of archivingIds) delete archivingWorkspaces[id]
          return { adoptingFanoutWorkspaceId: null, archivingWorkspaces }
        })
      }
    }

    const siblings = group.workspaceIds
      .filter((id) => id !== workspaceId)
      .map((id) => s.app?.workspaces.find((w) => w.id === id))
      .filter((w): w is Workspace => !!w && !w.archived)
    if (siblings.length === 0) {
      // 정리할 형제가 없으면 묻지 않는다 — 그룹에 "이걸 골랐다" 를 기록할 뿐이라 즉시 끝난다.
      const res = await adopt()
      if (res.error) get().pushToast('error', res.error)
      else get().closeFanoutCompare()
      return
    }

    // 무엇을 잃는지 센다. 아카이브는 브랜치·PR·대화를 남기지만 **미커밋 변경은 남기지 않는다** —
    // 그 사실을 말하지 않으면 "되돌릴 수 있다"는 안내가 절반만 참이 된다.
    const uncommitted = siblings.reduce((n, w) => n + (s.gitStatus[w.id]?.changedFiles ?? 0), 0)
    const running = siblings.filter((w) => w.status === 'running').length
    const names = siblings.map((w) => workspaceDisplayName(w, s.prStatus[w.id]?.title))

    const ok = await s.confirm({
      title: `Keep “${workspaceDisplayName(winner, s.prStatus[workspaceId]?.title)}” and archive the rest?`,
      body: [
        `Archives ${joinList(names)}.`,
        'Their worktrees are removed, but the branches, pull requests and conversations are kept — you can unarchive any of them from the sidebar.',
        uncommitted ? `You lose ${plural(uncommitted, 'uncommitted file')} across them.` : '',
        running ? `${plural(running, 'candidate')} still working — their turns are stopped.` : ''
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Adopt and archive'
    })
    if (!ok) return

    const res = await adopt()
    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    for (const failure of res.archiveScriptFailures ?? []) get().reportArchiveScriptFailure(failure)
    get().closeFanoutCompare()
    void get().selectWorkspace(workspaceId)
    get().pushToast(
      'success',
      `Adopted “${workspaceDisplayName(winner)}” — archived ${plural(res.archived?.length ?? 0, 'sibling')}.`
    )
  },

  forgetFanoutGroup: async (groupId) => {
    await window.api.fanout.forget(groupId)
    if (get().activeFanoutGroupId === groupId) get().closeFanoutCompare()
  },

  requestDeleteWorkspace: async (workspaceId) => {
    const s = get()
    const ws = s.app?.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const name = workspaceDisplayName(ws, s.prStatus[workspaceId]?.title)

    // 무엇을 잃는지 먼저 센다 — "되돌릴 수 없다" 는 말만으로는 지금 이 워크트리에 남은
    // 미커밋 변경이나 아직 푸시하지 않은 커밋이 있다는 사실이 전달되지 않는다.
    const git = s.gitStatus[workspaceId]
    const stacked = (s.app?.workspaces ?? []).filter(
      (w) => !w.archived && w.parentWorkspaceId === workspaceId
    ).length
    const losses: string[] = []
    if (git?.changedFiles) losses.push(plural(git.changedFiles, 'uncommitted file'))
    if (git?.ahead) losses.push(`${plural(git.ahead, 'commit')} not in ${ws.baseBranch}`)

    const body = [
      `Deletes its worktree, the local branch ${ws.branch}, and the conversation for good.`,
      losses.length ? `You lose ${joinList(losses)}.` : '',
      ws.status === 'running' ? 'The agent is still working here — its turn is stopped.' : '',
      stacked ? `${plural(stacked, 'workspace')} stacked on this branch will lose their base.` : '',
      'Anything already pushed — the remote branch and its PR — stays on GitHub.',
      'Archive it instead to keep the branch and history.'
    ]
      .filter(Boolean)
      .join(' ')

    const ok = await s.confirm({
      title: `Permanently delete “${name}”?`,
      body,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await get().deleteWorkspaceNow(workspaceId)
    get().pushToast('info', `Deleted “${name}”.`)
  },

  undoableCreate: null,

  undoCreateWorkspace: async () => {
    const s = get()
    const undoable = s.undoableCreate
    const ws = s.app?.workspaces.find((w) => w.id === undoable?.workspaceId)
    const verdict = undoCreateVerdict(undoable, ws, ws ? s.gitStatus[ws.id] : null, Date.now())

    if (!ws || verdict === 'nothing') {
      if (undoable) set({ undoableCreate: null })
      s.pushToast('info', 'Nothing to undo.')
      return
    }
    // 이미 쓴 흔적이 있는 워크스페이스는 조용히 지우지 않는다 — 일반 삭제와 같은 확인을 거친다.
    if (verdict === 'confirm') {
      await get().requestDeleteWorkspace(ws.id)
      return
    }

    const name = workspaceDisplayName(ws)
    await get().deleteWorkspaceNow(ws.id)
    get().pushToast('info', `Undid — deleted workspace “${name}”.`)
  },

  deleteWorkspaceNow: async (workspaceId) => {
    // 리뷰 화면 뒤에 가려진 워크스페이스를 지우는 경우엔 화면을 건드리지 않는다.
    const wasSelected = get().selectedWorkspaceId === workspaceId && !get().activeReviewId
    // 아직 아카이브되지 않은 워크스페이스를 지우면 아카이브 스크립트도 여기서 돈다.
    const { archiveScriptFailure } = await window.api.workspace.remove(workspaceId, true)
    get().reportArchiveScriptFailure(archiveScriptFailure)
    if (get().undoableCreate?.workspaceId === workspaceId) set({ undoableCreate: null })
    if (!wasSelected) return

    // 보고 있던 워크스페이스가 사라졌으니 ⌘[ 와 같은 규칙으로 직전에 보던 곳으로 돌아간다.
    // 방송된 상태를 기다리지 않고 지운 id 를 직접 제외한다 — 되돌아갈 곳이 방금 지운 그
    // 워크스페이스가 되면 안 된다.
    const s = get()
    const alive = new Set(
      (s.app?.workspaces ?? []).filter((w) => !w.archived && w.id !== workspaceId).map((w) => w.id)
    )
    const { target, history } = popWorkspaceHistory(s.workspaceHistory, workspaceId, alive)
    set({ workspaceHistory: history })
    await get().selectWorkspace(target, { fromHistory: true })
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

  // 등록해 둔 항목의 원본이 메인 체크아웃에 없으면 전달은 조용히 건너뛰어진다. 그 침묵 자체가
  // 버그였다 — .env 처럼 gitignore 된 파일을 워크트리 안에서만 만들어 온 사용자는 원본이 리포
  // 루트에 있어야 한다는 걸 알 길이 없어, "등록해 뒀는데 아무것도 안 온다"를 영영 겪는다.
  // 그렇다고 워크스페이스를 만들 때마다 띄우면 잔소리가 되므로 리포·경로당 한 번만 알린다.
  reportCarryMissing: (repoId, missing) => {
    const repo = get().app?.repos.find((r) => r.id === repoId)
    if (!repo) return
    const missingNow = new Set(missing ?? [])
    // 원본이 생겨 정상 전달되기 시작한 경로는 기억을 지운다 — 나중에 다시 사라지면 그건 다시
    // 알려야 할 새 사실이다(한 번 알리고 영원히 침묵하는 것도 같은 종류의 버그다).
    for (const item of repo.carryItems) {
      if (!missingNow.has(item.path)) setUiFlag(carryMissingShownFlag(repoId, item.path), false)
    }
    const fresh = [...missingNow].filter((p) => !readUiFlag(carryMissingShownFlag(repoId, p)))
    if (fresh.length === 0) return
    for (const p of fresh) setUiFlag(carryMissingShownFlag(repoId, p), true)

    get().pushToast(
      'info',
      `Nothing was carried for ${fresh.join(', ')} — no such file in ${repo.path}. ` +
        `New worktrees are filled from the main checkout only, so a copy you made inside a ` +
        `workspace never counts as the source. Create it there and every new workspace gets one.`,
      [{ label: 'Repo settings', run: () => openRepoSettings(repoId) }]
    )
  },

  // 아카이브 스크립트(`docker compose down` 등)는 worktree 를 지우기 전에 딸린 것들을 정리하는
  // 마지막 기회다. 실패해도 아카이브는 계속되므로 화면상으로는 아무 일 없이 끝난 것처럼 보이고,
  // 사용자는 컨테이너가 살아 있는 걸 한참 뒤에나 알게 된다 — 그래서 error 로 확실히 띄운다.
  reportArchiveScriptFailure: (failure) => {
    if (!failure) return
    const how = failure.timedOut ? 'timed out' : `exited with code ${failure.code ?? 'unknown'}`
    const tail = outputTail(failure.output)
    get().pushToast(
      'error',
      `The archive script ${how}, so this workspace's cleanup may not have run — ` +
        `check for leftover containers or processes. Everything else finished.\n` +
        `$ ${failure.command}${tail ? `\n${tail}` : ''}`
    )
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
    const workspace = get().app?.workspaces.find((w) => w.id === workspaceId)
    const optimistic = optimisticStackProgress(
      workspaceId,
      'restack',
      workspace?.stack?.length ?? null
    )
    set((s) => ({ stackProgress: { ...s.stackProgress, [workspaceId]: optimistic } }))
    const res = await window.api.workspace.restack(workspaceId)
    // main 이 진행 이벤트를 한 번도 보내지 않은 경우 — 핸들러가 "워크스페이스 없음"·"에이전트
    // 실행 중" 처럼 스트림을 열기 전에 반환한 것이다. 우리가 세운 표시를 우리가 걷지 않으면
    // 끝났다는 신호가 영영 오지 않아 버튼이 스피너에 갇힌다. 객체 동일성으로 가려낸다 —
    // main 이 보낸 값은 IPC 를 건너온 새 객체라 절대 같지 않다.
    set((s) =>
      s.stackProgress[workspaceId] === optimistic
        ? { stackProgress: { ...s.stackProgress, [workspaceId]: null } }
        : {}
    )
    const base = res.baseBranch || workspace?.baseBranch || 'base'
    // push 가 거부된 경우는 rebase 가 성공했더라도 성공 토스트를 띄우지 않는다. 리모트(=PR)는 옛
    // 커밋 그대로라 여기서 "rebased" 라고만 말하면 사용자는 다 됐다고 믿고, 그 침묵이 다음 restack
    // 에서 "리모트를 남이 다시 썼다" 는 오진으로 되돌아온다.
    if (res.pushError) {
      get().pushToast(
        'error',
        res.status === 'restacked'
          ? `Rebased onto ${base}, but the push was rejected: ${res.pushError}`
          : `The push was rejected: ${res.pushError}`
      )
    } else if (res.status === 'restacked') {
      get().pushToast(
        'success',
        res.pushed ? `Rebased onto ${base} and pushed.` : `Rebased onto ${base}.`
      )
    } else if (res.status === 'up-to-date') {
      get().pushToast('info', `Already up to date with ${base}.`)
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
    const workspace = get().app?.workspaces.find((w) => w.id === workspaceId)
    const optimistic = optimisticStackProgress(
      workspaceId,
      'sync',
      workspace?.stackSync?.affected.length ?? null
    )
    set((s) => ({ stackProgress: { ...s.stackProgress, [workspaceId]: optimistic } }))
    const res = await window.api.stack.syncApply(workspaceId).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
      cascade: undefined
    }))
    // restackWorkspace 와 같은 이유의 정리 — 계획이 이미 사라졌거나 워크스페이스를 못 찾아
    // main 이 스트림을 열기 전에 반환했으면 낙관적 표시가 그대로 남는다.
    set((s) =>
      s.stackProgress[workspaceId] === optimistic
        ? { stackProgress: { ...s.stackProgress, [workspaceId]: null } }
        : {}
    )
    if (res.error) get().pushToast('error', `Stack sync failed: ${res.error}`)
    else if (res.cascade) get().reportCascade(res.cascade, 'Stack synced.')
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
  },

  runMergeTrain: async (workspaceId, method, total) => {
    const optimistic = optimisticStackProgress(workspaceId, 'train', total)
    set((s) => ({ stackProgress: { ...s.stackProgress, [workspaceId]: optimistic } }))
    const result = await window.api.stack.trainRun(workspaceId, method).catch((err) => ({
      mergedPrs: [],
      steps: [],
      stoppedAt: null,
      error: err instanceof Error ? err.message : String(err)
    }))
    // main 이 계획 만료처럼 스트림을 열기 전에 거절할 수 있다. 그때 우리가 넣은 객체만
    // 동일성으로 걷어 내야, 이미 IPC 로 넘어온 실제 진행 상태를 뒤늦게 지우지 않는다.
    set((s) =>
      s.stackProgress[workspaceId] === optimistic
        ? { stackProgress: { ...s.stackProgress, [workspaceId]: null } }
        : {}
    )
    if (result.error) get().pushToast('error', `Merge train failed: ${result.error}`)
    void get().refreshGit(workspaceId)
    void get().refreshPr(workspaceId)
    return result
  },

  dismissStackSync: async (workspaceId) => {
    await window.api.stack.syncDismiss(workspaceId).catch(() => {})
  },

  dismissArchiveSuggest: async (workspaceId) => {
    await window.api.workspace.dismissArchiveSuggest(workspaceId).catch(() => {})
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
      // diverged 는 실패가 아니라 "일부러 하지 않았다" — 실패로 읽히면 사용자가 엉뚱한 곳을 뒤진다.
      if (p.status === 'diverged') {
        return `• ${who}: the remote branch was rewritten (GitHub rebases stacked PRs server-side) — rebase skipped so it is not overwritten; compare against origin`
      }
      return `• ${who}: ${p.kind} failed — ${p.message ?? 'unknown error'}`
    })
    get().pushToast('error', `Stack cascade needs attention:\n${lines.join('\n')}`)
  },

  selectWorkspace: async (id, opts) => {
    // 선택 시 미확인 표시 해제. 사이드바 선택은 하나의 축이므로 리뷰 화면에서도 빠져나온다
    // (리뷰 세션 자체는 남아 있어 사이드바에서 다시 고를 수 있다).
    set((s) => {
      // 다른 워크스페이스로 옮기면 파일 뷰어는 닫는다 — 열린 경로가 그 worktree 전용이라
      // 그대로 두면 새 워크스페이스에서 없는 파일을 가리키게 된다.
      const fileViewer = s.fileViewer?.workspaceId === id ? s.fileViewer : null
      const workspaceHistory = pushWorkspaceHistory(
        s.workspaceHistory,
        s.selectedWorkspaceId,
        id,
        opts?.fromHistory
      )
      // fan-out 비교 화면도 리뷰와 같은 자리를 쓴다 — 워크스페이스를 고르는 것은 "그 화면에서
      // 나온다" 는 뜻이다(그룹 자체는 남아 사이드바에서 다시 열 수 있다).
      const closed = { activeReviewId: null, activeFanoutGroupId: null }
      if (!id || !s.unread[id])
        return { selectedWorkspaceId: id, ...closed, fileViewer, workspaceHistory }
      const unread = { ...s.unread }
      delete unread[id]
      return { selectedWorkspaceId: id, unread, ...closed, fileViewer, workspaceHistory }
    })

    // 별도 창으로 떼어 둔 패널은 메인 창의 선택을 따라간다 — 보조 모니터의 작업 패널이 다른
    // 세션을 계속 비추고 있으면 "옆 화면에 띄워 둔 패널" 로 쓸 수 없다.
    void window.api.pane.setWorkspace(id)
    // 스크립트 패널을 분리해 둔 동안 세션을 옮기면, 그 세션에 대해 패널이 열려 있는 셈이다.
    // 이 표시를 해 둬야 창을 닫았을 때 패널이 인라인으로 제자리에 돌아온다.
    if (id && get().detachedPanes.scripts) get().setScriptPanelOpen(id, true)

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

  goBackWorkspace: async () => {
    const s = get()
    // 리뷰 화면은 워크스페이스 위에 겹쳐 뜬 페이지다 — 뒤로가기의 첫 걸음은 그 아래에서
    // 보고 있던 워크스페이스로 돌아오는 것이다(방문 기록은 아직 건드리지 않는다).
    if (s.activeReviewId) {
      await s.selectWorkspace(s.selectedWorkspaceId, { fromHistory: true })
      return
    }
    const alive = new Set((s.app?.workspaces ?? []).filter((w) => !w.archived).map((w) => w.id))
    const { target, history } = popWorkspaceHistory(
      s.workspaceHistory,
      s.selectedWorkspaceId,
      alive
    )
    set({ workspaceHistory: history })
    if (target) await get().selectWorkspace(target, { fromHistory: true })
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

  fetchReposAndRefreshGit: async () => {
    const workspaces = get().app?.workspaces.filter((w) => !w.archived) ?? []
    const repoIds = [...new Set(workspaces.map((w) => w.repoId))]
    await Promise.all(
      repoIds.map(async (repoId) => {
        // main 에서 같은 리포의 동시 요청도 합류한다. 실패는 IPC 양쪽에서 삼켜 다음 틱을 살린다.
        await window.api.git.fetch(repoId).catch(() => {})
        const affected = workspaces.filter((w) => w.repoId === repoId)
        const entries = await Promise.all(
          affected.map(async (w) => {
            const status = await window.api.git.status(w.id).catch(() => null)
            return [w.id, status] as const
          })
        )
        set((s) => {
          const gitStatus = { ...s.gitStatus }
          for (const [id, status] of entries) gitStatus[id] = status
          return { gitStatus }
        })
      })
    )
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

  seedScriptOutput: async (workspaceId, kind) => {
    const key = scriptKey(workspaceId, kind)
    if (get().scriptOutput[key]) return
    const out = await window.api.script.getOutput(workspaceId, kind).catch(() => '')
    if (!out) return
    // 조회하는 사이 라이브 출력이 도착했다면 그쪽이 이어지는 흐름이다 — 앞부분을 덮어써
    // 중복시키지 않는다.
    set((s) => (s.scriptOutput[key] ? {} : { scriptOutput: { ...s.scriptOutput, [key]: out } }))
  },

  takeComposerAttachments: (workspaceId) => {
    const pending = get().composerAttachments[workspaceId]
    if (!pending?.length) return EMPTY_ATTACHMENTS
    set((s) => {
      const next = { ...s.composerAttachments }
      delete next[workspaceId]
      return { composerAttachments: next }
    })
    return pending
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

  clearPromptSuggestion: (workspaceId) =>
    set((s) => {
      if (!s.promptSuggestions[workspaceId]) return {}
      const promptSuggestions = { ...s.promptSuggestions }
      delete promptSuggestions[workspaceId]
      return { promptSuggestions }
    }),

  addDiffComment: (workspaceId, anchor, body) => {
    const id = `dc:${++diffCommentSeq}`
    set((s) => ({
      diffComments: {
        ...s.diffComments,
        [workspaceId]: [...(s.diffComments[workspaceId] ?? []), { ...anchor, id, body }]
      }
    }))
    return id
  },

  editDiffComment: (workspaceId, id, body) =>
    set((s) => {
      const cur = s.diffComments[workspaceId]
      if (!cur || !body.trim()) return {}
      return {
        diffComments: {
          ...s.diffComments,
          [workspaceId]: cur.map((c) => (c.id === id ? { ...c, body } : c))
        }
      }
    }),

  removeDiffComment: (workspaceId, id) =>
    set((s) => {
      const cur = s.diffComments[workspaceId]
      if (!cur) return {}
      const next = cur.filter((c) => c.id !== id)
      const diffComments = { ...s.diffComments }
      if (next.length) diffComments[workspaceId] = next
      else delete diffComments[workspaceId]
      return { diffComments }
    }),

  clearDiffComments: (workspaceId) =>
    set((s) => {
      if (!s.diffComments[workspaceId]) return {}
      const diffComments = { ...s.diffComments }
      delete diffComments[workspaceId]
      return { diffComments }
    }),

  /**
   * 전송 분기는 Composer 의 그것과 같아야 한다 — steering 을 못 하는 백엔드에 실행 중 메시지를
   * 그냥 밀어 넣으면 현재 턴과 뒤엉키므로, 그럴 때는 대기 큐에 넣어 턴이 끝나면 나가게 한다.
   */
  sendDiffComments: (workspaceId) => {
    const s = get()
    const comments = s.diffComments[workspaceId]
    if (!comments?.length) return
    const ws = s.app?.workspaces.find((w) => w.id === workspaceId)
    const backend = s.backends.find((b) => b.id === (ws?.agentBackend ?? DEFAULT_AGENT_BACKEND))
    const text = composeDiffCommentsMessage(comments)

    // 비우는 것이 먼저다. 전송 실패로 코멘트가 되살아나는 것보다, 보낸 뒤 남은 카드가 다시
    // 보내지는 쪽이 사용자에게 더 나쁘다(같은 지시가 두 번 나간다).
    get().clearDiffComments(workspaceId)
    if (ws?.status === 'running' && !backend?.capabilities.steering) {
      get().enqueueMessage(workspaceId, text)
    } else {
      void window.api.chat.send(workspaceId, text)
    }
  },

  resetTranscript: (workspaceId) =>
    set((s) => {
      const contextUsage = { ...s.contextUsage }
      delete contextUsage[workspaceId]
      const compacting = { ...s.compacting }
      delete compacting[workspaceId]
      const goals = { ...s.goals }
      delete goals[workspaceId]
      return {
        transcripts: { ...s.transcripts, [workspaceId]: [] },
        loadedTranscripts: { ...s.loadedTranscripts, [workspaceId]: true },
        contextUsage,
        compacting,
        goals
      }
    }),

  resetContextUsage: (workspaceId) =>
    set((s) => {
      const contextUsage = { ...s.contextUsage }
      delete contextUsage[workspaceId]
      return { contextUsage }
    }),

  setScrollPosition: (workspaceId, top) =>
    set((s) => ({ scrollPositions: { ...s.scrollPositions, [workspaceId]: top } })),

  setScriptPanelOpen: (workspaceId, open) =>
    set((s) => ({ scriptPanelOpen: { ...s.scriptPanelOpen, [workspaceId]: open } })),

  toggleAgentsCollapsed: (workspaceId) =>
    set((s) => ({
      agentsCollapsed: { ...s.agentsCollapsed, [workspaceId]: !s.agentsCollapsed[workspaceId] }
    })),

  expandAgents: (workspaceId) =>
    set((s) => ({ agentsCollapsed: { ...s.agentsCollapsed, [workspaceId]: false } })),

  // 우측 패널 너비 — 대화/터미널이 너무 좁아지지 않도록 양끝을 클램프한다.
  setRightWidth: (px) => set({ rightWidth: Math.max(320, Math.min(900, Math.round(px))) }),

  setSidebarWidth: (px) => {
    const width = Math.max(180, Math.min(480, Math.round(px)))
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
    } catch {
      /* 기억은 편의 기능이므로 저장 실패 시 현재 세션에서만 적용한다. */
    }
    set({ sidebarWidth: width })
  },

  // 우측 패널 표시 토글 — 숨기면 대화가 전체 폭을 쓰고, 다시 켜면 마지막 너비로 복귀한다.
  // 패널을 별도 창으로 떼어 뒀다면 그 창을 앞으로 가져온다 — 이미 "보이는" 상태라 여기서
  // 껐다 켜 봐야 아무 변화가 없고, 다른 모니터에 있는 창을 찾아 주는 편이 사용자가 원한 결과다.
  toggleRightPanel: () => {
    if (get().detachedPanes.work) {
      void window.api.pane.focus('work')
      return
    }
    const workspaceId = get().selectedWorkspaceId
    if (!workspaceId) return
    set((s) => {
      const current = s.rightPanelOpen[workspaceId] ?? s.app?.settings.defaultRightPanelOpen ?? true
      return { rightPanelOpen: { ...s.rightPanelOpen, [workspaceId]: !current } }
    })
  },

  // 패널 상태를 직접 지정한다. 온보딩에서 고른 기본값을 지금 화면에도 바로 반영하기 위한 것으로,
  // 토글과 같은 경로를 타므로 localStorage 기억값(⌘J 기록)까지 함께 갱신된다 — 그러지 않으면
  // 이미 토글한 적 있는 기존 사용자에게는 기억값이 새로 고른 기본값을 계속 덮어써 버린다.
  setRightPanelOpen: (open) => {
    const workspaceId = get().selectedWorkspaceId
    if (!workspaceId) return
    set((s) => ({ rightPanelOpen: { ...s.rightPanelOpen, [workspaceId]: open } }))
  },

  // 터미널 비율 — 패널/터미널 어느 쪽도 사라지지 않도록 0.15~0.85 로 클램프한다.
  setTerminalRatio: (ratio) => set({ terminalRatio: Math.max(0.15, Math.min(0.85, ratio)) }),

  jumpToTranscriptItem: async (workspaceId, itemId) => {
    const s = get()
    const ws = s.app?.workspaces.find((w) => w.id === workspaceId)
    // 아카이브된 워크스페이스는 대화창이 뜨지 않는다(worktree 가 없다). 검색 결과의 스니펫으로
    // 답이 됐을 수도 있으니 실패로 취급하지 말고, 열려면 무엇이 필요한지 알려 준다.
    if (ws?.archived) {
      s.pushToast(
        'info',
        `"${workspaceDisplayName(ws)}" is archived — unarchive it in the sidebar to open the conversation.`
      )
      return
    }
    // 목적지를 먼저 세워 둔다 — 대화창은 마운트되자마자 이 값을 보고 그 항목으로 스크롤한다.
    set((st) => ({ jumpTarget: { workspaceId, itemId, seq: (st.jumpTarget?.seq ?? 0) + 1 } }))
    await s.selectWorkspace(workspaceId)
  },

  clearJumpTarget: () => set((s) => (s.jumpTarget ? { jumpTarget: null } : {})),

  openFileViewer: (workspaceId, path, line) =>
    set((s) => {
      const cur = s.fileViewer
      // 처음 열거나 다른 워크스페이스로 넘어가면 기록을 새로 시작한다(경로가 그 worktree 전용이다).
      if (!cur || cur.workspaceId !== workspaceId)
        return { fileViewer: { workspaceId, history: [{ path, line }], index: 0, treeOpen: true } }

      // 보고 있던 파일을 다시 열면 기록을 늘리지 않고 줄 위치만 갱신한다.
      if (cur.history[cur.index]?.path === path) {
        const history = cur.history.slice()
        history[cur.index] = { path, line }
        return { fileViewer: { ...cur, history } }
      }

      // 뒤로 간 상태에서 새 파일을 열면 앞쪽 기록은 브라우저처럼 버린다.
      const history = [...cur.history.slice(0, cur.index + 1), { path, line }].slice(
        -FILE_HISTORY_MAX
      )
      return { fileViewer: { ...cur, history, index: history.length - 1 } }
    }),

  closeFileViewer: () => set({ fileViewer: null }),

  navigateFileViewer: (delta) =>
    set((s) => {
      const cur = s.fileViewer
      if (!cur) return {}
      const index = cur.index + delta
      if (index < 0 || index >= cur.history.length) return {}
      return { fileViewer: { ...cur, index } }
    }),

  toggleFileViewerTree: () =>
    set((s) =>
      s.fileViewer ? { fileViewer: { ...s.fileViewer, treeOpen: !s.fileViewer.treeOpen } } : {}
    ),

  // 트리가 사라지거나 코드 영역을 다 먹지 않도록 양끝을 클램프한다.
  setFileViewerTreeWidth: (px) =>
    set({ fileViewerTreeWidth: Math.max(180, Math.min(560, Math.round(px))) }),

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

  startReview: async ({ repoId, prNumbers, prompt, agentBackend, model, effort }) => {
    // PR 조회도 코멘트 게시도 gh 를 쓰므로 다른 PR 기능과 같은 지연 게이트를 태운다.
    await get().requireGithub('Reviewing a pull request needs GitHub.', async () => {
      // model·effort 는 **키를 아예 빼야** main 이 전역 기본값으로 해석한다(null 은 "에이전트가
      // 알아서" 라는 다른 뜻이다).
      const res = await window.api.review.start({
        repoId,
        prNumbers,
        prompt,
        agentBackend,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {})
      })
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
      diffs: bundle.diffs.length > 0 ? bundle.diffs : v.diffs,
      findings: bundle.findings,
      activity: bundle.activity,
      viewed: bundle.viewed ?? {}
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
    // 레코드는 main 이 지운 뒤 방송으로 사라진다 — 그때까지 사이드바 행은 그대로 남으므로,
    // 지우는 중이라는 표시가 없으면 눌러도 아무 일 없는 것처럼 보인다.
    await withReviewBusy(set, reviewId, 'deleting', () => window.api.review.close(reviewId))
  },

  requestArchiveReview: async (reviewId) => {
    const session = get().app?.reviews.find((r) => r.id === reviewId)
    if (!session || session.archived) return
    const ok = await get().confirm({
      title: `Archive review of ${reviewTitle(session).number ? `#${reviewTitle(session).number}` : 'this pull request'}?`,
      body: 'Its worktree is removed, but the findings and conversation are kept. You can unarchive it later.',
      confirmLabel: 'Archive',
      danger: true
    })
    if (!ok) return
    await get().archiveReview(reviewId)
  },

  archiveReview: async (reviewId) => {
    await withReviewBusy(set, reviewId, 'archiving', () => window.api.review.archive(reviewId))
    // 아카이브한 리뷰를 열어 두고 있었다면 화면에서 빠져나온다(워크트리가 사라졌다).
    if (get().activeReviewId === reviewId) set({ activeReviewId: null })
  },

  unarchiveReview: async (reviewId) => {
    // 되살리기는 워크트리를 다시 만든다 — 원격에서 커밋을 받아야 할 수도 있어 가장 오래 걸린다.
    const res = await withReviewBusy(set, reviewId, 'unarchiving', () =>
      window.api.review.unarchive(reviewId)
    )
    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    get().openReview(reviewId)
  },

  cancelReview: async (reviewId) => {
    await window.api.review.cancel(reviewId)
  },

  resumeReview: async (reviewId) => {
    const res = await window.api.review.resume(reviewId)
    if (res.error) {
      get().pushToast('error', res.error)
      return
    }
    // 아카이브된 리뷰를 이어서 돌리면 되살아난다 — 도는 것을 볼 수 있게 화면도 그리로 옮긴다.
    get().openReview(reviewId)
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

  submitReview: async (reviewId, entries) => {
    const res = await window.api.review.submit(reviewId, entries)
    // 레이어마다 따로 나가므로 **일부만 성공할 수 있다**. 성공한 것은 이미 기록됐으니
    // 실패한 쪽만 말해 주고, 화면은 열어 둔 채로 둔다(다시 내면 나머지만 나간다).
    for (const e of res.errors) {
      get().pushToast('error', e.prNumber ? `#${e.prNumber}: ${e.error}` : e.error)
    }
    if (res.submitted > 0) {
      get().pushToast(
        'success',
        res.submitted === 1
          ? 'Submitted the review.'
          : `Submitted ${res.submitted} reviews across the stack.`
      )
    }
    return res.errors.length === 0
  },

  pollReviews: async () => {
    const reviews = get().app?.reviews ?? []
    // 순차로 돈다. 세션마다 gh 를 병렬로 띄우면 로그인 셸이 한꺼번에 여러 개 뜬다.
    for (const r of reviews) {
      // 추적할 게 없으면 건너뛴다. 코멘트를 안 달았어도 리뷰를 제출했다면 **새 커밋** 은
      // 계속 봐야 한다 — 내 지적에 대한 응답이 커밋으로 오기 때문이다.
      if (r.archived) continue
      if (r.postedComments.length === 0 && !r.layers.some((l) => l.lastSubmission)) continue
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
  },

  setReviewTab: (reviewId, tab) => {
    patchReview(set, get, reviewId, () => ({ tab }))
    // 활동을 열어 봤으니 미확인 점을 끈다.
    if (tab === 'activity') void window.api.review.markSeen(reviewId)
  },

  toggleFileViewed: async (reviewId, path, prNumber) => {
    const view = get().reviewViews[reviewId]
    const layer =
      prNumber === undefined ? view?.diffs[0] : view?.diffs.find((d) => d.prNumber === prNumber)
    const file = layer?.diff.files.find((f) => f.path === path)
    if (!view || !file) return
    const on = !isFileViewed(view.viewed, file, layer?.prNumber)
    const key = viewedKey(path, layer?.prNumber)

    // 체크박스는 누른 즉시 뒤집혀야 한다 — 먼저 화면을 바꾸고, 실패하면 되돌린다.
    const wasHash = view.viewed[key] ?? null
    patchReview(set, get, reviewId, (v) => ({
      viewed: withViewed(v.viewed, key, on ? fileDiffHash(file) : null)
    }))

    const res = await window.api.review.setFileViewed(reviewId, path, on, layer?.prNumber)
    if (res.error) {
      get().pushToast('error', res.error)
      patchReview(set, get, reviewId, (v) => ({ viewed: withViewed(v.viewed, key, wasHash) }))
      return
    }
    // main 이 자기 diff 로 계산한 지문이 권위다 — 새 커밋이 방금 들어와 이쪽 diff 가 한 박자
    // 뒤처져 있으면 두 값이 갈린다. 그 사이 사용자가 다시 껐으면 건드리지 않는다.
    const hash = res.hash
    if (hash) {
      patchReview(set, get, reviewId, (v) =>
        v.viewed[key] === undefined ? {} : { viewed: withViewed(v.viewed, key, hash) }
      )
    }
  }
}))

/** viewed 맵 1칸을 불변 갱신한다. hash 가 null 이면 지운다. */
function withViewed(
  viewed: Record<string, string>,
  path: string,
  hash: string | null
): Record<string, string> {
  if (hash === null) {
    const { [path]: _dropped, ...rest } = viewed
    return rest
  }
  return { ...viewed, [path]: hash }
}

/** 리뷰 세션 1개를 불변 갱신한다. 세션이 없으면(이미 닫힘) 아무것도 하지 않는다. */
/**
 * 리뷰 1건을 "지금 정리하는 중" 으로 잠가 두고 IPC 를 돌린다.
 *
 * 세 동작(아카이브·되살리기·삭제)이 같은 모양의 기다림이라 한 곳에 모은다. 실패해도 표시는
 * 반드시 걷어야 하므로 finally 로 지운다.
 */
async function withReviewBusy<T>(
  set: (fn: (s: UIState) => Partial<UIState>) => void,
  reviewId: string,
  kind: ReviewBusyKind,
  run: () => Promise<T>
): Promise<T> {
  set((s) => ({ busyReviews: { ...s.busyReviews, [reviewId]: kind } }))
  try {
    return await run()
  } finally {
    set((s) => {
      const next = { ...s.busyReviews }
      delete next[reviewId]
      return { busyReviews: next }
    })
  }
}

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
