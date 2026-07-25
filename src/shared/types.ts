/**
 * main ↔ renderer 가 공유하는 도메인 타입과 IPC 계약.
 * preload 가 이 타입을 그대로 노출하므로, 채널 이름·페이로드 모양의 단일 출처(SSOT)다.
 */

// ── Claude Code 권한 모드 ───────────────────────────────────────────────
// Claude Code 가 Shift+Tab 으로 순환하는 모드와 동일하게 노출한다
// (default → accept edits → plan → auto).
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

/**
 * Claude Code CLI 의 reasoning effort(추론 노력) 단계. 모델이 응답에 들이는 사고 깊이를 조절한다.
 * SDK query() 의 effort 옵션으로 그대로 전달된다(낮을수록 빠르고, 높을수록 깊게 추론).
 * - low: 최소 사고, 가장 빠름 / medium: 보통 / high: 깊은 추론(모델 기본값)
 * - xhigh: high 보다 더 깊게(Fable 5·Opus 4.7+) / max: 최대(Fable 5·Opus 4.6+·Sonnet 4.6)
 * 모델마다 지원 단계가 다르며, 지원하지 않으면 CLI 가 조용히 낮춘다.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * wooi 가 저장·표시하는 effort 선택값. SDK 의 effort 레벨에 더해, Claude Code CLI 의 effort
 * 선택기에서 'max' 다음에 나오는 'ultracode' 를 포함한다.
 *
 * ultracode 는 effort 레벨이 아니라 별도 모드다 — "xhigh effort + 상시 동적 워크플로우 조율".
 * 그래서 SDK 로는 effort 옵션이 아니라 settings 레이어의 ultracode: true 로 전달하며,
 * 워크플로우 활성화(wooi 는 기본 on)와 xhigh 지원 모델이 필요하다(미지원 시 CLI 가 알아서 처리).
 */
export type EffortSetting = EffortLevel | 'ultracode'

// ── 도메인 엔티티 ────────────────────────────────────────────────────────

/** 연결된 git 리포지토리(메인 체크아웃). 모든 workspace 의 부모. */
export interface Repo {
  id: string
  name: string
  /** 메인 리포의 절대 경로 */
  path: string
  /** 감지된 기본 브랜치 (main/master 등) */
  defaultBranch: string
  /** workspace 생성 후 1회 실행하는 셋업 명령 (예: "npm install"). 비어 있으면 미실행. */
  setupScript: string
  /** 개발 서버 실행 명령 (예: "npm run dev"). 비어 있으면 미실행. */
  devScript: string
  /** workspace 아카이브 시 worktree 에서 실행하는 정리 명령. 비어 있으면 미실행. */
  archiveScript: string
  /**
   * GitHub 소유자(owner) 아바타 이미지를 담은 data: URL. origin 리모트가 GitHub 일 때만 채워진다.
   * 원격 URL 대신 data URL 로 저장하는 이유: 렌더러 CSP(img-src 'self' data:)가 외부 이미지를
   * 막으므로, main 이 한 번 받아 인라인해 두면 CSP 완화 없이 오프라인에서도 표시된다.
   * 없으면(비 GitHub·미인증·네트워크 실패) 렌더러가 기본 리포 아이콘으로 폴백한다.
   */
  avatarDataUrl?: string
  addedAt: number
}

export type WorkspaceStatus = 'idle' | 'running' | 'error'

/**
 * 병렬 dev 서버 포트 배정의 시작점. workspace 마다 이 값부터 비어 있는 포트를 하나씩 올려
 * 배정해, 여러 workspace 의 dev 스크립트가 동시에 떠도 충돌하지 않게 한다.
 */
export const BASE_DEV_PORT = 3100

/** 이미 사용 중인 포트 집합을 피해 BASE_DEV_PORT 부터 비어 있는 첫 포트를 고른다. */
export function allocateDevPort(used: Set<number>): number {
  let port = BASE_DEV_PORT
  while (used.has(port)) port++
  return port
}

/**
 * workspace 의 표시 이름을 결정하는 단일 출처(SSOT).
 * 우선순위: 사용자가 지정한 표시 이름(displayName) → PR 제목 → worktree 이름(name).
 * 즉 기본 규칙(최초엔 worktree 이름, PR 생성 시 PR 제목)은 유지하되,
 * 사용자가 직접 수정하면 그 값이 항상 우선한다.
 */
export function workspaceDisplayName(
  workspace: { name: string; displayName: string | null },
  prTitle?: string | null
): string {
  return workspace.displayName?.trim() || prTitle?.trim() || workspace.name
}

/**
 * 워크스페이스의 브랜치 스택(아래→위)을 돌려준다. 모델 B 스택이 있으면 그 엔트리들을,
 * 없으면 현재 branch/baseBranch/prNumber 로 단일 엔트리를 합성해 돌려준다(모델 A·일반 워크스페이스).
 * 이렇게 두 모델을 같은 모양으로 다뤄, 관리 UI(Stack 팝오버)가 분기 없이 렌더한다.
 */
export function workspaceStack(
  ws: Pick<Workspace, 'branch' | 'baseBranch' | 'prNumber' | 'stack'>
): StackedBranch[] {
  if (ws.stack && ws.stack.length > 0) return ws.stack
  return [{ branch: ws.branch, baseBranch: ws.baseBranch, prNumber: ws.prNumber }]
}

/** 워크스페이스가 worktree 내부 브랜치 스택(모델 B, 엔트리 2개 이상)을 보유하는지. */
export function isBranchStack(ws: Pick<Workspace, 'stack'>): boolean {
  return !!ws.stack && ws.stack.length > 1
}

/**
 * 워크스페이스 목록을 stack 트리 순서로 정렬한다(부모 바로 뒤에 자식이 오도록, DFS pre-order).
 * 각 항목에 stack 들여쓰기 깊이(depth: 뿌리=0)를 함께 매겨 사이드바가 계층을 그릴 수 있게 한다.
 * 입력 순서(생성 순 등)는 형제 사이에서 보존된다. 순환(비정상 데이터)은 방문 집합으로 방지한다.
 */
export function orderByStack<T extends { id: string; parentWorkspaceId: string | null }>(
  workspaces: T[]
): Array<{ workspace: T; depth: number }> {
  const byParent = new Map<string | null, T[]>()
  const ids = new Set(workspaces.map((w) => w.id))
  for (const w of workspaces) {
    // 부모가 이 목록에 없으면(아카이브·다른 레포 등) 뿌리로 취급한다.
    const key = w.parentWorkspaceId && ids.has(w.parentWorkspaceId) ? w.parentWorkspaceId : null
    const list = byParent.get(key) ?? []
    list.push(w)
    byParent.set(key, list)
  }
  const out: Array<{ workspace: T; depth: number }> = []
  const seen = new Set<string>()
  const walk = (parentId: string | null, depth: number): void => {
    for (const w of byParent.get(parentId) ?? []) {
      if (seen.has(w.id)) continue
      seen.add(w.id)
      out.push({ workspace: w, depth })
      walk(w.id, depth + 1)
    }
  }
  walk(null, 0)
  // 순환 등으로 누락된 항목이 있으면 뒤에 평탄하게 덧붙여 유실을 막는다.
  for (const w of workspaces) if (!seen.has(w.id)) out.push({ workspace: w, depth: 0 })
  return out
}

/**
 * 이 워크스페이스를 구동하는 AI 코딩 에이전트 백엔드 식별자.
 * 현재는 'claude'(Claude Code, Claude Agent SDK) 하나뿐이지만, 백엔드 추상화 계층을 통해
 * 추후 다른 에이전트(예: Codex)를 식별자만 추가해 붙일 수 있도록 도메인에 남겨 둔다.
 * 백엔드별 기능 지원 여부(capabilities)·기본 모델 등 메타데이터는 main 의 agent 레지스트리가 보유한다.
 */
export type AgentBackendId = 'claude'

/** 백엔드를 지정하지 않은(레거시·신규) 워크스페이스의 기본 백엔드. */
export const DEFAULT_AGENT_BACKEND: AgentBackendId = 'claude'

/**
 * 한 워크스페이스(worktree) 안에 쌓인 stacked PR 브랜치 1개.
 * 모델 B(단일 worktree · N 브랜치 · N PR)에서, 워크스페이스는 이런 엔트리들의 스택을 가지며
 * worktree 는 그중 하나(=Workspace.branch)를 체크아웃한 상태다.
 */
export interface StackedBranch {
  branch: string
  /** 스택에서 바로 아래 브랜치. 맨 아래 엔트리는 리포 기본 브랜치. */
  baseBranch: string
  /** 이 브랜치에 연결된 PR 번호(발견되면 영속). 없으면 null. */
  prNumber: number | null
}

/** 하나의 작업 단위. git worktree + 전용 브랜치 + 에이전트 세션 1개. */
export interface Workspace {
  id: string
  repoId: string
  /** 이 워크스페이스를 구동하는 에이전트 백엔드. 레거시 워크스페이스는 'claude' 로 마이그레이션된다. */
  agentBackend: AgentBackendId
  /** worktree 이름. 생성 시 정해지는 기본 이름으로, 표시 이름의 최종 폴백이다. */
  name: string
  /**
   * 사용자가 직접 지정한 표시 이름(override). null 이면 기본 규칙을 따른다
   * (최초엔 worktree 이름, PR 생성 시 PR 제목). 사용자가 수정하면 이 값이 항상 우선한다.
   * 아카이브 시 현재 표시 이름을 여기에 보존해, worktree·PR 정보가 없어도 같은 이름을 보여 준다.
   */
  displayName: string | null
  /** 이 workspace 전용 git 브랜치 */
  branch: string
  /**
   * 브랜치를 분기한 베이스 브랜치. stacked 워크스페이스면 부모 워크스페이스의 branch,
   * 아니면 리포 기본 브랜치(origin/<defaultBranch>)다. git status/diff/restack 이 이 값을 기준으로 동작한다.
   */
  baseBranch: string
  /**
   * stacked PR 부모. 이 워크스페이스가 다른 워크스페이스의 브랜치 위에 쌓였으면 그 부모의 id,
   * 기본 브랜치에서 바로 분기한 스택 뿌리면 null. 자식은 parentWorkspaceId 로 역산해 트리를 만든다.
   */
  parentWorkspaceId: string | null
  /**
   * (현재 체크아웃된 브랜치의) 연결된 GitHub PR 번호(있으면). getPrStatus 로 발견되면 영속되어,
   * 부모 브랜치가 병합·삭제된 뒤에도 stack 관계·retarget 대상을 안정적으로 식별한다. 없으면 null.
   */
  prNumber: number | null
  /**
   * 모델 B(단일 worktree 안 브랜치 스택). 아래→위 순서의 엔트리 목록으로, 이 worktree 에서
   * 'Split here' 로 끊어 만든 stacked PR 브랜치들을 담는다. 현재 체크아웃된 브랜치는 항상
   * Workspace.branch 이며, branch/baseBranch/prNumber 는 그 엔트리의 미러다.
   * 없거나 길이 1 이하면 단일 브랜치 워크스페이스(=기존 동작)로 취급한다.
   */
  stack?: StackedBranch[]
  /** worktree 절대 경로 */
  worktreePath: string
  /**
   * 이 workspace 전용 dev 서버 포트. 병렬로 여러 workspace 의 dev 스크립트를 띄울 때
   * 같은 기본 포트(3000/5173 등)를 다투지 않도록, 생성 시 고유 포트를 배정한다.
   * setup/dev 스크립트에 `$PORT`·`$WOOI_DEV_PORT` 환경변수로 주입된다.
   * 레거시 workspace(배정 전)는 null 일 수 있으며, dev 실행 시 lazy 하게 배정·영속된다.
   */
  devPort: number | null
  /**
   * setup 스크립트의 마지막 실행 결과(영속). setup 은 생성 직후 자동 실행되는 일회성 초기화라,
   * 이미 성공한 걸 다시 돌리면 재설치·재시드처럼 무의미하거나 파괴적일 수 있다. 그래서 결과를
   * 디스크에 남겨, 앱을 재시작해도 성공한 setup 은 재실행 버튼을 노출하지 않는다(실패했을 때만 Retry).
   * 'idle' = 아직 완료된 실행 없음, 'success' = 마지막 실행이 exit 0, 'failed' = 그 외로 종료.
   */
  setupState: SetupState
  /** resume 용 Claude 세션 ID. 아직 세션을 시작하지 않았으면 null. */
  sessionId: string | null
  permissionMode: PermissionMode
  status: WorkspaceStatus
  /** 이 workspace 전용 모델 오버라이드. null 이면 전역 설정(AppSettings.model) 을 따른다. */
  model: string | null
  /** 이 workspace 전용 reasoning effort 오버라이드. null 이면 전역 설정(AppSettings.effort) 을 따른다. */
  effort: EffortSetting | null
  /** init 메시지에서 확인된 실제 모델명(예: "claude-opus-4-8[1m]"). 표시용. */
  lastModel: string | null
  /** 아카이브되면 사이드바 기본 목록에서 숨기고 worktree 를 제거한다(브랜치·기록은 유지). */
  archived: boolean
  /** 이 워크스페이스의 모든 알림(OS 알림·소리·Dock 배지)을 음소거한다. 레거시는 undefined=false. */
  muted?: boolean
  createdAt: number
  lastActiveAt: number
}

/**
 * 약관·개인정보처리방침의 현재 버전. 문서를 사용자 권리에 영향을 주도록 개정하면 1 올린다.
 * settings.acceptedTermsVersion 이 이 값과 다르면 온보딩에서 재동의를 요구한다.
 */
export const CURRENT_TERMS_VERSION = 1

/** UI 색상 테마. 'system' 은 OS 의 다크/라이트 설정을 따른다. */
export type ThemePreference = 'system' | 'light' | 'dark'

// ── 알림 설정 ────────────────────────────────────────────────────────────
// 알림을 이벤트(무엇이 일어났는지) × 채널(어떻게 알릴지)로 세분화한다.
// 워크스페이스별 음소거(Workspace.muted)와 함께, 병렬 세션이 많을 때 소음을 통제한다.

/** 알림을 유발하는 이벤트. */
export type NotificationEvent = 'completed' | 'error' | 'needsInput'
/** 알림을 전달하는 채널. */
export type NotificationChannel = 'osNotification' | 'sound' | 'badge'
/** 이벤트별로 각 채널의 on/off 를 담는 매트릭스. */
export type NotificationSettings = Record<NotificationEvent, Record<NotificationChannel, boolean>>

/** 표시용 이벤트 라벨(설정 UI 의 행 제목). */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  completed: 'Response complete',
  error: 'Session error',
  needsInput: 'Needs input (permission)'
}
/** 표시용 채널 라벨(설정 UI 의 열 제목). */
export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  osNotification: 'OS notification',
  sound: 'Sound',
  badge: 'Dock badge'
}

/** 기본 알림 설정. 완료는 소리까지, 에러/입력대기는 알림+배지만 기본으로 켠다. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  completed: { osNotification: true, sound: true, badge: true },
  error: { osNotification: true, sound: false, badge: true },
  needsInput: { osNotification: true, sound: false, badge: true }
}

export interface AppSettings {
  defaultPermissionMode: PermissionMode
  /** 사용할 모델 ID (예: "claude-opus-4-8[1m]"). */
  model: string | null
  /**
   * 새 turn 에 적용할 기본 reasoning effort. null 이면 effort 를 지정하지 않아 모델의 기본 동작
   * (대략 'high' + adaptive thinking)을 따른다. workspace 가 자체 effort 를 지정하면 그 값이 우선한다.
   */
  effort: EffortSetting | null
  /** UI 색상 테마(다크 기본). */
  theme: ThemePreference
  /**
   * @deprecated notifications.completed.sound 로 대체됨. 하위호환을 위해 남겨 두며,
   * 마이그레이션 시 이 값을 notifications 로 옮긴다. 새 코드는 notifications 를 본다.
   */
  soundOnComplete: boolean
  /** 이벤트×채널 세분화 알림 설정. */
  notifications: NotificationSettings
  /**
   * 우측 작업 패널(파일/변경/체크 + 터미널)의 펼침 기본값.
   * true(기본)면 펼침, false 면 접힘. 사용자가 아직 패널을 토글한 적이 없을 때의 시작값으로 쓰인다
   * (한 번 토글하면 그 상태가 localStorage 에 기억되어 다음 실행에서 이 기본값보다 우선한다).
   */
  defaultRightPanelOpen: boolean
  /**
   * Claude Code CLI 처럼, 한 턴이 끝났을 때 컨텍스트 사용량이 임계치를 넘으면 대화를
   * 자동으로 압축(/compact)한다. 끄면 사용량만 표시하고 압축은 수동(/compact)으로만.
   * 임계치 자체는 사용자에게 노출하지 않는 내부 상수다(session.ts 의 AUTO_COMPACT_THRESHOLD).
   */
  autoCompact: boolean
  /**
   * true 면 새 workspace 생성 시 이름·베이스 브랜치를 직접 입력하는 모달을 띄운다.
   * false(기본) 면 이름을 자동 생성하고 베이스는 리포 기본 브랜치(main/origin)로 즉시 만든다.
   */
  manualWorkspaceSetup: boolean
  /** 최초 실행 온보딩(Claude/GitHub 연동 안내)을 완료했는지. */
  onboarded: boolean
  /**
   * 온보딩 마지막의 "기본값 고르기"(권한 모드·작업 패널·테마) 단계를 거쳤는지.
   * 설정을 뒤져서 원하는 상태로 만들게 하는 대신, 기능 투어 직후 — 각 개념을 막 설명한 시점에 —
   * 한 번만 물어본다. false 면 이 단계를 노출한다(온보딩 완료 여부와 독립적으로 판단하므로,
   * 이 필드가 없던 버전의 기존 사용자도 기본값 병합으로 false 가 되어 한 번 질문을 받는다).
   */
  pickedDefaults: boolean
  /**
   * 사용자가 동의한 약관·개인정보처리방침 버전. 미동의면 null.
   * CURRENT_TERMS_VERSION 과 다르면 온보딩 첫 단계에서 (재)동의를 요구한다.
   */
  acceptedTermsVersion: number | null
}

export interface AppState {
  repos: Repo[]
  workspaces: Workspace[]
  settings: AppSettings
}

// ── 채팅 트랜스크립트 ────────────────────────────────────────────────────
// main 이 권위 있는 트랜스크립트를 보유·영속화하고, renderer 는 이벤트로 동기화한다.

/** 채팅 지원 이미지의 media type(Claude API 가 받는 base64 이미지 형식). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** renderer → main 으로 보내는 붙여넣기 이미지(base64 본문 포함, IPC 전송용). */
export interface ImageAttachment {
  /** 표시용 이름(예: image.png). */
  name: string
  mediaType: ImageMediaType
  /** data: 접두사 없는 순수 base64 본문. */
  dataBase64: string
}

/**
 * 트랜스크립트에 남는 첨부 메타데이터. base64 본문은 무겁고 모델에만 필요하므로 저장하지 않고,
 * 이름/형식만 남겨 사용자 메시지에 "[image.png]" 같은 칩으로 보여 준다.
 */
export type ChatAttachment = Pick<ImageAttachment, 'name' | 'mediaType'>

export type ChatItem =
  | { id: string; type: 'user'; text: string; ts: number; attachments?: ChatAttachment[] }
  | { id: string; type: 'assistant'; text: string; ts: number; streaming?: boolean }
  | { id: string; type: 'thinking'; text: string; ts: number; streaming?: boolean }
  | { id: string; type: 'tool_use'; toolId: string; name: string; input: unknown; ts: number }
  | { id: string; type: 'tool_result'; toolId: string; text: string; isError: boolean; ts: number }
  | {
      id: string
      type: 'result'
      subtype: string
      isError: boolean
      durationMs: number
      numTurns: number
      costUsd: number
      ts: number
    }
  | { id: string; type: 'error'; text: string; ts: number }
  | { id: string; type: 'system'; text: string; ts: number }
  /**
   * 입력창의 `!명령` (Claude Code CLI bash 모드) 1회 실행.
   * 우측 터미널 패널이 아니라 대화 흐름 안에 인라인으로 명령과 출력을 보여 준다 — id 기준
   * upsert 로 실행 중에는 출력이 자라고, 끝나면 running:false + 종료 코드로 확정된다.
   */
  | {
      id: string
      type: 'bash'
      /** 사용자가 입력한 명령(앞의 "!" 는 떼어 낸 본문). */
      command: string
      /** stdout+stderr 누적(앞에서 절사된 tail 일 수 있음). */
      output: string
      /** 프로세스 종료 코드. 실행 중이거나 spawn 실패면 null. */
      exitCode: number | null
      /** 아직 실행 중인지. true 면 스피너를 보여 준다. */
      running: boolean
      ts: number
    }
  /**
   * 동적 워크플로우(대규모 서브에이전트 조율) 1회 실행의 진행 카드.
   * 모델이 Workflow 도구로 시작한 백그라운드 실행을 SDK 의 task_* 시스템 메시지로 추적해
   * 하나의 항목(taskId 기준 upsert)으로 라이브 갱신한다 — 시작 → 진행(토큰·도구) → 종료(요약).
   */
  | {
      id: string
      type: 'task'
      /** SDK task_id. 같은 실행의 갱신을 하나로 합치는 키(항목 id 는 `task:${taskId}`). */
      taskId: string
      /** 워크플로우 스크립트의 meta.name (없으면 'workflow'). */
      name: string
      /** 사람이 읽는 현재 단계/작업 설명. */
      description: string
      status: 'running' | 'completed' | 'failed' | 'stopped' | 'paused'
      /** 마지막 진행 요약 또는 종료 시 최종 요약. */
      summary?: string
      /** 누적 토큰 사용량(있을 때). */
      totalTokens?: number
      /** 누적 도구 호출 수(있을 때). */
      toolUses?: number
      /** 종료까지 걸린 시간(ms, 종료 알림에서). */
      durationMs?: number
      ts: number
    }

/** main → renderer 스트리밍 이벤트. renderer 는 이를 트랜스크립트에 반영한다. */
export type ChatEvent =
  /** id 기준 append-or-replace. 권위 있는 완성 항목. */
  | { type: 'item'; item: ChatItem }
  /** assistant/thinking 버블(id)에 텍스트 조각을 이어붙임. */
  | { type: 'delta'; id: string; itemType: 'assistant' | 'thinking'; text: string }
  /** workspace 실행 상태 변화. */
  | { type: 'status'; status: WorkspaceStatus }
  /** 세션 ID·모델 확정/갱신 (init 메시지 기준). */
  | { type: 'session'; sessionId: string; model?: string }
  /**
   * 한 턴이 끝난 뒤의 컨텍스트 윈도 사용량(마지막 요청의 입력 토큰 합 / 모델 컨텍스트 윈도).
   * 입력창의 사용량 미터와 자동 압축 판단의 단일 출처.
   */
  | { type: 'context'; usedTokens: number; maxTokens: number; percentage: number }
  /** 대화 압축(/compact) 진행 상태. auto = 임계치 초과로 앱이 트리거한 자동 압축. */
  | { type: 'compacting'; active: boolean; trigger?: 'auto' | 'manual' }

// ── 권한 프롬프트 (canUseTool → UI) ──────────────────────────────────────

export interface PermissionRequest {
  requestId: string
  workspaceId: string
  toolName: string
  /** bridge 가 렌더한 사람이 읽을 프롬프트 문장 (예: "Claude wants to read foo.txt") */
  title?: string
  /** 버튼 라벨용 짧은 명사구 (예: "Read file") */
  displayName?: string
  input: Record<string, unknown>
  decisionReason?: string
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      rememberForSession?: boolean
      /**
       * 도구 입력에 합쳐 SDK 로 되돌려줄 값. AskUserQuestion 처럼 사용자의 응답을
       * 입력에 주입해야 하는 도구에서 사용한다(예: { answers: { 질문: 선택 } }).
       * 없으면 원래 입력을 그대로 사용한다.
       */
      updatedInput?: Record<string, unknown>
    }
  | { behavior: 'deny' }

// ── 스크립트 실행 (setup / dev) ──────────────────────────────────────────

export type ScriptKind = 'setup' | 'dev'

/** setup 스크립트의 마지막 실행 결과(Workspace.setupState 에 영속). */
export type SetupState = 'idle' | 'success' | 'failed'

export interface ScriptOutputEvent {
  workspaceId: string
  kind: ScriptKind
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface ScriptExitEvent {
  workspaceId: string
  kind: ScriptKind
  code: number | null
}

export type ScriptRunState = 'idle' | 'running' | 'exited'

export interface ScriptStatus {
  kind: ScriptKind
  state: ScriptRunState
  exitCode: number | null
}

// ── git 상태 (사이드바 배지용 경량 정보) ─────────────────────────────────

export interface GitStatus {
  branch: string
  /** base 대비 앞선/뒤처진 커밋 수 */
  ahead: number
  behind: number
  /** 변경된(staged + unstaged + untracked) 파일 수 */
  changedFiles: number
  /** 미해결 머지 충돌이 있는지(예: updateFromBase 후 충돌). UI 가 해결 안내를 띄울 때 쓴다. */
  conflicted: boolean
}

// ── base 브랜치에서 업데이트(머지) ────────────────────────────────────────

/**
 * updateFromBase 결과.
 * - updated: base 의 새 커밋을 브랜치로 머지함
 * - up-to-date: 이미 최신이라 머지할 것이 없음
 * - conflict: 머지 충돌 — 워킹트리가 충돌 상태로 남음(해결 또는 abortMerge 필요)
 * - dirty: 미커밋 변경이 있어 머지를 시작하지 않음(먼저 커밋/스태시 필요)
 * - error: 그 밖의 실패(머지는 자동으로 abort 됨)
 */
export interface UpdateFromBaseResult {
  status: 'updated' | 'up-to-date' | 'conflict' | 'dirty' | 'error'
  baseBranch: string
  /** status==='conflict' 일 때 충돌난 파일 경로들. */
  conflictedFiles?: string[]
  /** dirty/error 등 사용자에게 보여 줄 사유. */
  message?: string
}

// ── restack (stacked PR: 부모 위로 rebase) ───────────────────────────────

/**
 * restackOnto 결과.
 * - restacked: base(부모 브랜치) 위로 rebase 함(리모트 브랜치가 있으면 force-push 까지).
 * - up-to-date: 이미 base 위에 올라가 있어 rebase 할 것이 없음.
 * - conflict: rebase 충돌 — 워킹트리가 rebase 진행/충돌 상태로 남음(해결 후 계속 또는 abortRebase).
 * - dirty: 미커밋 변경이 있어 rebase 를 시작하지 않음(먼저 커밋/스태시 필요).
 * - error: 그 밖의 실패(rebase 는 자동으로 abort 됨).
 */
export interface RestackResult {
  status: 'restacked' | 'up-to-date' | 'conflict' | 'dirty' | 'error'
  baseBranch: string
  /** status==='conflict' 일 때 충돌난 파일 경로들. */
  conflictedFiles?: string[]
  /** rebase 후 리모트에 force-push 했는지(리모트 브랜치가 없으면 push 를 건너뛴다). */
  pushed?: boolean
  /** dirty/error 등 사용자에게 보여 줄 사유. */
  message?: string
}

// ── git diff (변경 검토용) ───────────────────────────────────────────────

export type FileDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** 파일 1개의 변경 요약 + 통합 diff 본문. */
export interface FileDiff {
  path: string
  status: FileDiffStatus
  additions: number
  deletions: number
  /** 이 파일의 통합 diff 본문(헤더 포함). 바이너리는 빈 문자열. */
  patch: string
  binary: boolean
}

/** base 브랜치 대비 workspace 의 전체 변경(커밋 + 미커밋). */
export interface WorkspaceDiff {
  baseBranch: string
  files: FileDiff[]
}

// ── IPC 채널 이름 ────────────────────────────────────────────────────────

export const IPC = {
  // 양방향 호출 (renderer.invoke → main.handle)
  appGetState: 'app:getState',
  repoAdd: 'repo:add',
  repoRemove: 'repo:remove',
  repoUpdate: 'repo:update',
  repoListBranches: 'repo:listBranches',
  workspaceCreate: 'workspace:create',
  workspaceArchive: 'workspace:archive',
  workspaceUnarchive: 'workspace:unarchive',
  workspaceRemove: 'workspace:remove',
  /** 한 레포의 아카이브된 워크스페이스를 한 번에 영구 삭제한다(브랜치·기록 포함). */
  workspaceRemoveArchived: 'workspace:removeArchived',
  workspaceSetPermissionMode: 'workspace:setPermissionMode',
  workspaceSetModel: 'workspace:setModel',
  workspaceSetEffort: 'workspace:setEffort',
  /** 워크스페이스별 알림 음소거 토글. */
  workspaceSetMuted: 'workspace:setMuted',
  workspaceRename: 'workspace:rename',
  workspaceOpenInEditor: 'workspace:openInEditor',
  workspaceRevealInFinder: 'workspace:revealInFinder',
  /** /memory — worktree 의 CLAUDE.md 를 에디터로 연다(없으면 worktree 를 연다). */
  workspaceOpenMemory: 'workspace:openMemory',
  chatSend: 'chat:send',
  chatInterrupt: 'chat:interrupt',
  chatGetHistory: 'chat:getHistory',
  /** /btw 사이드 질문 — 메인 대화를 건드리지 않는 임시 질의를 띄운다. */
  chatSideQuestion: 'chat:sideQuestion',
  /** /clear — 트랜스크립트를 비우고 세션을 새로 시작한다(워크스페이스는 유지). */
  chatClear: 'chat:clear',
  permissionRespond: 'permission:respond',
  scriptRun: 'script:run',
  scriptStop: 'script:stop',
  scriptGetStatus: 'script:getStatus',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  /** base 브랜치를 현재 워크스페이스 브랜치로 머지해 드리프트를 해소한다. */
  gitUpdateFromBase: 'git:updateFromBase',
  /** stacked 워크스페이스 브랜치를 최신 base(부모 브랜치) 위로 rebase 하고 리모트에 force-push 한다. */
  workspaceRestack: 'workspace:restack',
  /** 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요). */
  workspaceSwitchBranch: 'workspace:switchBranch',
  /** 진행 중인 머지를 취소한다(충돌 포기). */
  gitAbortMerge: 'git:abortMerge',
  prStatus: 'pr:status',
  /** 지정한 브랜치(worktree 의 현재 브랜치가 아니어도)의 PR 상태를 조회한다. 모델 B 스택 조망용. */
  prStatusForBranch: 'pr:statusForBranch',
  prCreate: 'pr:create',
  prChecks: 'pr:checks',
  /** 현재 브랜치의 PR 을 병합한다(squash/merge/rebase). */
  prMerge: 'pr:merge',
  /** 현재 브랜치의 PR 을 닫는다(병합 없이). */
  prClose: 'pr:close',
  /** 닫힌 PR 을 다시 연다. */
  prReopen: 'pr:reopen',
  /** Draft PR 을 리뷰 가능 상태로 전환한다. */
  prReady: 'pr:ready',
  openExternal: 'shell:openExternal',
  settingsUpdate: 'settings:update',
  authGetStatus: 'auth:getStatus',
  /** 앱 내부 PTY 에서 `claude auth login` 을 시작한다(별도 Terminal 창 없이). */
  authClaudeLoginStart: 'auth:claudeLoginStart',
  /** 사용자가 붙여넣은 OAuth 코드를 진행 중인 로그인 PTY 로 제출한다. */
  authClaudeLoginSubmitCode: 'auth:claudeLoginSubmitCode',
  /** 진행 중인 로그인 PTY 를 취소·종료한다(모달 닫기). */
  authClaudeLoginCancel: 'auth:claudeLoginCancel',
  authClaudeLogout: 'auth:claudeLogout',
  /** 앱 내부 PTY 에서 `gh auth login --web` 을 시작한다(별도 Terminal 창 없이). */
  authGithubLoginStart: 'auth:githubLoginStart',
  /** 진행 중인 GitHub 로그인 PTY 를 취소·종료한다(모달 닫기). */
  authGithubLoginCancel: 'auth:githubLoginCancel',
  authGithubLogout: 'auth:githubLogout',
  // 슬래시 명령 목록 (입력창 자동완성)
  commandsList: 'commands:list',
  /** 인터랙티브 명령(/mcp·/context·/reload-plugins 등) 실행 — 결과 카드를 위한 데이터 조회. */
  commandRun: 'command:run',
  /** /mcp 패널의 서버별 동작(재연결·활성/비활성) 실행 후 갱신된 서버 목록을 돌려준다. */
  mcpAction: 'command:mcpAction',
  /** /rewind 패널에서 고른 체크포인트로 코드를 되돌린다(SDK rewindFiles). */
  commandRewindAction: 'command:rewindAction',
  // 파일 브라우저 (All files 탭)
  fsList: 'fs:list',
  fsRead: 'fs:read',
  // 인터랙티브 터미널 (worktree PTY)
  terminalStart: 'terminal:start',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  /** 입력창의 `!명령` (Claude Code CLI bash 모드)을 PTY 에서 실행한다. */
  terminalRunCommand: 'terminal:runCommand',
  /** 입력창의 `!명령` 을 1회 실행하고 출력을 대화 흐름(트랜스크립트)에 인라인으로 흘려보낸다. */
  terminalExec: 'terminal:exec',
  /** 진행 중인 인라인 `!명령`(execInline)을 중단한다. 인자로 workspaceId 와 대상 아이템 id 를 받는다. */
  terminalKillInline: 'terminal:killInline',
  // Dock 미확인 배지
  appSetBadge: 'app:setBadge',
  // 앱 버전 / 자동 업데이트
  appGetVersion: 'app:getVersion',
  /** 수동으로 업데이트를 확인한다(설정의 "업데이트 확인" 버튼). */
  updateCheck: 'update:check',
  /** 다운로드된 업데이트를 설치하기 위해 앱을 재시작한다. */
  updateQuitAndInstall: 'update:quitAndInstall',

  // 단방향 이벤트 (main.send → renderer.on)
  evtChat: 'evt:chat',
  /** /btw 사이드 질문의 진행 상태(시작/타이핑/완료/오류). 트랜스크립트와 분리된 임시 스트림. */
  evtSideQuestion: 'evt:sideQuestion',
  evtPermission: 'evt:permission',
  /** 응답받지 못한 채 무효가 된 권한 요청(세션 dispose 등) — renderer 가 해당 프롬프트를 제거. */
  evtPermissionCancel: 'evt:permissionCancel',
  evtScriptOutput: 'evt:scriptOutput',
  evtScriptExit: 'evt:scriptExit',
  evtState: 'evt:state',
  /** OS 알림 클릭 등으로 특정 workspace 를 선택하도록 renderer 에 요청. */
  evtSelectWorkspace: 'evt:selectWorkspace',
  /** main 창이 포커스를 얻었을 때의 알림 — 보고 있는 workspace 의 미확인 표시 해제 트리거. */
  evtWindowFocus: 'evt:windowFocus',
  /** main 창이 포커스를 잃었을 때의 알림 — 이후 완료를 미확인(Dock 배지)으로 잡는 신뢰 신호. */
  evtWindowBlur: 'evt:windowBlur',
  /** 터미널 PTY 출력 스트림. */
  evtTerminalData: 'evt:terminalData',
  /** 터미널 PTY 종료. */
  evtTerminalExit: 'evt:terminalExit',
  /** 앱 내부 Claude 로그인 진행 이벤트(인증 URL 노출 / 코드 입력 요청 / 완료). */
  evtClaudeLogin: 'evt:claudeLogin',
  /** 앱 내부 GitHub 로그인 진행 이벤트(one-time 코드·디바이스 URL 노출 / 완료). */
  evtGithubLogin: 'evt:githubLogin',
  /** 자동 업데이트 상태 변화(확인 중/최신/발견/다운로드 진행/준비됨/오류). */
  evtUpdate: 'evt:update'
} as const

// ── IPC 페이로드 타입 ────────────────────────────────────────────────────

/** 자동 업데이트 상태(main → renderer, evtUpdate 페이로드). */
export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'not-available'
    | 'error'
    /** 읽기 전용 위치(DMG/App Translocation)에서 실행 중 — 자동 업데이트 불가. */
    | 'blocked'
  /** available/ready 일 때 새 버전. */
  version?: string
  /** downloading 일 때 0~100. */
  percent?: number
  /** error/blocked 일 때 메시지. */
  error?: string
}

export interface CreateWorkspaceArgs {
  repoId: string
  /** 비어 있으면 main 이 고유 이름을 자동 생성한다. */
  name?: string
  /** @deprecated 무시됨 — 항상 origin 기본 브랜치(origin/<defaultBranch>)에서 분기한다. */
  baseBranch?: string
  /**
   * stacked PR 부모 워크스페이스 id. 지정하면 그 워크스페이스의 브랜치 위에 새 워크스페이스를 쌓는다
   * (base = 부모의 branch). 없거나 null 이면 기본 브랜치에서 분기한 스택 뿌리로 만든다.
   */
  parentWorkspaceId?: string | null
}

// ── 외부 연동 인증 상태 (Claude / GitHub) ────────────────────────────────

export interface ClaudeAuthStatus {
  /** `claude` CLI 가 PATH 에 설치돼 있는지. 미설치면 loggedIn 도 항상 false. */
  installed: boolean
  loggedIn: boolean
  email?: string
  orgName?: string
  subscriptionType?: string
  authMethod?: string
  /**
   * 에이전트 프로세스 환경에 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN 이 설정돼 있는지.
   * 있으면 아래 계정 로그인과 무관하게 에이전트가 그 키로 인증·과금하므로(구독이 아니라),
   * 패널이 이 불일치를 알려 "로그아웃했는데 왜 계속 되지 / 왜 구독이 아니라 API 과금이지" 혼선을 막는다.
   */
  apiKeyInEnv?: boolean
}

export interface GithubAuthStatus {
  /** `gh` CLI 가 PATH 에 설치돼 있는지. 미설치면 loggedIn 도 항상 false. */
  installed: boolean
  loggedIn: boolean
  account?: string
  protocol?: string
}

export interface AuthStatus {
  claude: ClaudeAuthStatus
  github: GithubAuthStatus
}

// ── GitHub PR 상태 (workspace 브랜치 기준) ───────────────────────────────

/**
 * PR 의 진행 상태. open 을 review_required/changes_requested/approved/conflict 로 세분화해
 * 렌더러가 상태별 색·아이콘을 매핑할 수 있게 한다(label 문자열 파싱 대신 이 값으로 분기).
 */
export type PrState =
  | 'draft'
  | 'review_required'
  | 'changes_requested'
  | 'approved'
  | 'conflict'
  | 'open'
  | 'merged'
  | 'closed'

/** PR 병합 방식(gh pr merge 플래그에 대응). */
export type PrMergeMethod = 'squash' | 'merge' | 'rebase'

export interface PrStatus {
  number: number
  url: string
  /** PR 제목. workspace 표시 이름의 기본값으로 쓴다(없으면 workspace.name). */
  title: string
  /** 구조화된 상태값. 색·아이콘 매핑의 단일 출처. */
  state: PrState
  /** 표시용 라벨: Draft / Review required / Changes requested / Ready to merge / Conflict / Open / Merged / Closed */
  label: string
}

// ── PR/CI 체크 상태 (Check 탭) ───────────────────────────────────────────

export type PrCheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PrCheck {
  name: string
  state: PrCheckState
  /** 워크플로/체크 상세 페이지 URL (있으면). */
  url?: string
}

export interface PrChecks {
  prNumber: number
  prUrl: string
  checks: PrCheck[]
}

// ── 슬래시 명령 (입력창 자동완성) ─────────────────────────────────────────

/** Claude Code 가 지원하는 슬래시 명령/스킬 1개 (/btw, /insights, 사용자 스킬 등). */
export interface SlashCommandInfo {
  /** 앞의 '/' 를 뺀 이름 */
  name: string
  description: string
  /** 인자 힌트 (예: "<file>"). */
  argumentHint?: string
  /** 같은 명령으로 해석되는 다른 이름들 (예: /usage 의 /cost·/stats). 자동완성 매칭에 함께 쓴다. */
  aliases?: string[]
}

// ── 인터랙티브(TUI 전용) 슬래시 명령 ─────────────────────────────────────────
// /mcp·/context 같은 명령은 Claude Code TUI 에서 React 패널을 띄우는 local-jsx 타입이라
// 일반 프롬프트로 보내면 동작하지 않는다(=/btw 와 같은 부류). 대신 Agent SDK 의 제어 메서드
// (mcpServerStatus·getContextUsage·reloadPlugins 등)로 데이터를 받아 입력창 위 카드로 보여 준다.

/** 인터랙티브 명령의 종류. 카드 렌더링과 main 측 분기를 가르는 단일 키. */
export type CommandPanelKind =
  | 'mcp'
  | 'context'
  | 'usage'
  | 'agents'
  | 'reloadPlugins'
  | 'reloadSkills'
  | 'rewind'
  | 'permissions'

/**
 * 입력창 인터셉트(Composer)와 자동완성 보강(commands.ts)이 같은 목록을 보도록 하는 SSOT.
 * name 은 앞의 '/' 를 뺀 명령 이름, kind 는 main 분기 키.
 */
export const INTERACTIVE_COMMANDS: {
  name: string
  kind: CommandPanelKind
  description: string
  /** Claude Code 에서 이 명령으로 해석되는 별칭(예: /usage 의 /cost·/stats). */
  aliases?: string[]
}[] = [
  { name: 'mcp', kind: 'mcp', description: 'Show MCP server connection status and tools' },
  { name: 'context', kind: 'context', description: 'Visualize current context window usage' },
  {
    name: 'usage',
    kind: 'usage',
    description: 'Show session cost and plan usage limits',
    aliases: ['cost', 'stats']
  },
  { name: 'agents', kind: 'agents', description: 'List subagents available to this session' },
  {
    name: 'rewind',
    kind: 'rewind',
    description: 'Restore code to a checkpoint from an earlier message'
  },
  {
    name: 'permissions',
    kind: 'permissions',
    description: 'View permission mode and tool allow/ask/deny rules'
  },
  { name: 'reload-plugins', kind: 'reloadPlugins', description: 'Reload plugins from disk' },
  { name: 'reload-skills', kind: 'reloadSkills', description: 'Reload skills from disk' }
]

/** MCP 서버 1개의 연결 상태(표시용으로 추린 것). */
export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  /** 설정 스코프(project/user/local/claudeai/managed 등). */
  scope?: string
  /** 연결된 경우 제공 도구 수. */
  toolCount?: number
  /** failed 인 경우 오류 메시지. */
  error?: string
  /** 연결된 서버 버전(있으면). */
  version?: string
  /** 전송 방식(stdio/http/sse/claudeai-proxy). 상세 보기에서 표시. */
  transport?: string
  /** http/sse/claudeai 서버의 엔드포인트 URL, 또는 stdio 서버의 실행 명령. */
  endpoint?: string
  /** 연결된 경우 제공 도구 목록(상세 보기용). */
  tools?: { name: string; description?: string }[]
}

/**
 * /mcp 상세 보기에서 서버 1개에 대해 수행할 수 있는 동작.
 * Claude Code CLI 의 /mcp 패널과 동일하게 재연결·활성/비활성 토글을 지원한다.
 */
export type McpAction = 'reconnect' | 'enable' | 'disable'

/** /context — 컨텍스트 창 사용량 요약(상위 카테고리만). */
export interface ContextUsageInfo {
  totalTokens: number
  maxTokens: number
  /** 0–100 사용률. */
  percentage: number
  model: string
  /** 토큰이 큰 순으로 정렬된 카테고리(시스템 프롬프트·도구·메시지 등). */
  categories: { name: string; tokens: number }[]
}

/** /usage — 세션 비용 + (가능하면) 요금제 사용률 창. */
export interface UsageInfo {
  totalCostUsd: number
  linesAdded: number
  linesRemoved: number
  /** 'pro'/'max'/'team'/'enterprise' 또는 API 키 세션이면 null. */
  subscriptionType: string | null
  /** 요금제 한도가 적용되지 않으면(API 키 등) false. */
  rateLimitsAvailable: boolean
  /** 5시간·7일 등 사용률 창(있을 때만). */
  rateLimits: { label: string; utilization: number | null; resetsAt: string | null }[]
}

/** /agents — 이 세션에서 쓸 수 있는 서브에이전트 1개. */
export interface AgentInfoLite {
  name: string
  description: string
  /** 모델 별칭(생략 시 부모 모델 상속). */
  model?: string
}

/** /reload-plugins · /reload-skills 결과 요약. */
export interface ReloadResult {
  pluginCount?: number
  commandCount?: number
  agentCount?: number
  mcpServerCount?: number
  skillCount?: number
  errorCount?: number
}

/** /rewind — 되돌릴 수 있는 체크포인트 1개(사용자 메시지 기준). */
export interface RewindPoint {
  /** SDK 가 부여한 사용자 메시지 UUID. rewindFiles 에 그대로 넘긴다. */
  userMessageId: string
  /** 그 메시지의 첫 줄(표시용). */
  text: string
  ts: number
}

/** /rewind 실행 결과(SDK rewindFiles 응답을 표시용으로 추린 것). */
export interface RewindActionResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/** /permissions — 현재 권한 모드 + 설정 파일에서 모은 도구 규칙(읽기 전용). */
export interface PermissionsInfo {
  /** 현재 워크스페이스의 권한 모드(default/acceptEdits/plan/auto). */
  mode: PermissionMode
  /** settings.json 들에서 합친 allow/ask/deny 규칙. */
  allow: string[]
  ask: string[]
  deny: string[]
  /** 규칙을 읽어 온 설정 파일 경로(있는 것만). 출처를 알려 준다. */
  sources: string[]
}

/** 인터랙티브 명령 실행 결과. kind 로 카드 렌더링을 분기한다. */
export type CommandResult =
  | { kind: 'mcp'; servers: McpServerInfo[] }
  | { kind: 'context'; context: ContextUsageInfo }
  | { kind: 'usage'; usage: UsageInfo }
  | { kind: 'agents'; agents: AgentInfoLite[] }
  | { kind: 'reloadPlugins'; reload: ReloadResult }
  | { kind: 'reloadSkills'; reload: ReloadResult }
  | { kind: 'rewind'; checkpoints: RewindPoint[] }
  | { kind: 'permissions'; permissions: PermissionsInfo }

// ── 파일 브라우저 (All files 탭) ──────────────────────────────────────────

/** worktree 내 디렉토리 1개의 항목. path 는 worktree 루트 기준 상대 경로. */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface FileContent {
  path: string
  text: string
  /** maxBytes 초과로 잘렸으면 true. */
  truncated: boolean
  /** 바이너리(또는 표시 불가)면 본문 없이 true. */
  binary: boolean
}

// ── 인터랙티브 터미널 (worktree PTY) ──────────────────────────────────────

export interface TerminalDataEvent {
  workspaceId: string
  data: string
  /** true 면 재부착 시 누적 버퍼 재생 — 수신 측은 화면을 비우고 data 로 다시 채운다. */
  reset?: boolean
}

export interface TerminalExitEvent {
  workspaceId: string
  code: number | null
}

/**
 * 앱 내부 Claude 로그인 진행 이벤트.
 * - awaiting-code: `claude auth login` 이 인증 URL 을 띄우고 코드 입력을 기다린다.
 *   url 은 브라우저가 안 열렸을 때를 위한 폴백 링크. reprompt 면 직전 코드가 거절돼 다시 요청된 것.
 * - done: 로그인 프로세스가 종료됨. success 면 로그인 성공.
 */
export type ClaudeLoginEvent =
  { phase: 'awaiting-code'; url?: string; reprompt?: boolean } | { phase: 'done'; success: boolean }

/**
 * 앱 내부 GitHub 로그인(디바이스 플로우) 진행 이벤트.
 * - awaiting-auth: `gh auth login --web` 이 one-time 코드를 띄우고 브라우저 인증을 기다린다.
 *   code 는 사용자가 브라우저의 디바이스 페이지에 입력할 코드, url 은 그 페이지 링크(폴백).
 * - done: 로그인 프로세스가 종료됨. success 면 로그인 성공.
 */
export type GithubLoginEvent =
  { phase: 'awaiting-auth'; code: string; url?: string } | { phase: 'done'; success: boolean }

export interface ChatEnvelope {
  workspaceId: string
  event: ChatEvent
}

// ── /btw 사이드 질문 ──────────────────────────────────────────────────────
// Claude Code 의 /btw 와 같은 동작을 SDK 로 재현한다: 현재 세션 맥락을 이어받아 1턴·무도구로
// 답하되, 질문/답변은 영속 트랜스크립트에 남기지 않고 입력창 위 임시 카드로만 보여 준다.
// 그래서 ChatEvent(트랜스크립트 반영)와 섞지 않고 별도 이벤트로 둔다. id 로 스트림을 구분해
// 새 질문이 시작되면 이전 답변 카드를 대체한다.
export type SideQuestionEvent =
  | { workspaceId: string; id: string; phase: 'start'; question: string }
  | { workspaceId: string; id: string; phase: 'delta'; text: string }
  | { workspaceId: string; id: string; phase: 'done' }
  | { workspaceId: string; id: string; phase: 'error'; message: string }
