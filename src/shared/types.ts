/**
 * main ↔ renderer 가 공유하는 도메인 타입과 IPC 계약.
 * preload 가 이 타입을 그대로 노출하므로, 채널 이름·페이로드 모양의 단일 출처(SSOT)다.
 */

// ── 권한 모드 ───────────────────────────────────────────────────────────
/**
 * 에이전트의 권한 모드. **백엔드마다 지원하는 값이 다르다** — 어떤 모드를 어떤 순서로 노출할지는
 * 각 백엔드가 `AgentBackendMeta.permissionModes` 로 선언하고, UI 는 그 목록만 보고 그린다
 * (라벨·설명·푸터 문구도 거기서 온다). 여기 유니온은 저장·전송되는 식별자의 전체 집합일 뿐이다.
 *
 * - Claude Code: default → acceptEdits → plan → auto (CLI 의 Shift+Tab 순환과 동일)
 * - Codex: readOnly → default(Auto) → fullAccess → plan (CLI 의 승인/샌드박스 조합)
 *
 * `default`·`plan` 은 두 백엔드가 의미를 공유하므로 일부러 같은 식별자를 쓴다 — 백엔드를 바꿔도
 * 전역 기본값이 자연스럽게 이관되고, 지원하지 않는 값이면 백엔드 기본 모드로 폴백한다.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'readOnly' | 'fullAccess'

/**
 * reasoning effort(추론 노력) 단계. 모델이 응답에 들이는 사고 깊이를 조절한다
 * (낮을수록 빠르고, 높을수록 깊게 추론).
 * - minimal: Codex 의 최저 단계 / low: 최소 사고, 가장 빠름 / medium: 보통
 * - high: 깊은 추론(모델 기본값) / xhigh: high 보다 더 깊게 / max: 최대
 *
 * 백엔드·모델마다 지원 단계가 다르다. 선택지는 `AgentBackendMeta.efforts`(정적) 또는
 * `ModelOption.efforts`(모델별)로 내려오며, 미지원 값은 CLI 가 조용히 낮춘다.
 */
export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * wooi 가 저장·표시하는 effort 선택값. SDK 의 effort 레벨에 더해, Claude Code CLI 의 effort
 * 선택기에서 'max' 다음에 나오는 'ultracode' 를 포함한다.
 *
 * ultracode 는 effort 레벨이 아니라 별도 모드다 — "xhigh effort + 상시 동적 워크플로우 조율".
 * 그래서 SDK 로는 effort 옵션이 아니라 settings 레이어의 ultracode: true 로 전달하며,
 * 워크플로우 활성화(wooi 는 기본 on)와 xhigh 지원 모델이 필요하다(미지원 시 CLI 가 알아서 처리).
 */
export type EffortSetting = EffortLevel | 'ultracode'

/**
 * Claude Code 의 fast mode(터미널 CLI 의 `/fast`) — **같은 모델을 더 빠른 출력 속도로** 돌린다
 * (작은 모델로 낮추는 것이 아니다). Agent SDK 로는 query 옵션이 아니라 settings 레이어의
 * `fastMode: true` 로 전달한다(ultracode 와 같은 경로). SDK 세션에서는 이 플래그가 있어야만
 * 켜진다 — 파일 settings.json 값만으로는 SDK 모드에서 활성화되지 않는다.
 *
 * 전제 조건(못 갖추면 CLI 가 조용히 표준 속도로 돌린다):
 * - Anthropic API 를 직접 쓰는 로그인이어야 한다(Bedrock/Vertex 등 서드파티 경유는 불가).
 * - fast mode 를 지원하는 모델이어야 한다(모델 레지스트리의 fast_mode capability — Opus 5·4.8 계열).
 * - 유료 플랜/크레딧이 필요하고, fast 전용 rate limit 을 넘기면 쿨다운 동안 표준 속도로 돌아간다.
 *
 * 그래서 "설정값"과 "실제 상태"는 다를 수 있다 — 실제 상태는 세션이 알려 주는 FastModeState 로 본다.
 */
export type FastModeState = 'off' | 'cooldown' | 'on'

/**
 * fast mode 가 지금 켜질 수 없는 이유(CLI 가 알려 준다). 원인이 세션 단위로 특정되지 않는 경우
 * (예: 현재 모델이 지원하지 않음)에는 값이 오지 않으므로, 없을 때를 위한 일반 안내도 함께 둔다.
 */
export type FastModeDisabledReason =
  | 'free'
  | 'preference'
  | 'extra_usage_disabled'
  | 'network_error'
  | 'unknown'
  | 'not_first_party'
  | 'disabled_by_env'
  | 'model_not_allowed'
  | 'sdk_opt_in_required'
  | 'pending'

/**
 * fast mode 가 꺼진 이유를 사람이 읽을 문장으로. 이유가 없으면(모델이 지원하지 않는 경우 등)
 * 일반 안내를 돌려준다 — main(트랜스크립트 안내)과 renderer(상태줄 툴팁)가 같은 문구를 쓴다.
 */
export function fastModeReasonText(reason: FastModeDisabledReason | null | undefined): string {
  switch (reason) {
    case 'free':
      return 'Fast mode requires a paid Claude plan.'
    case 'extra_usage_disabled':
      return 'Fast mode needs usage credits — enable them in your Anthropic account.'
    case 'not_first_party':
      return 'Fast mode only works when Claude Code talks to the Anthropic API directly (not Bedrock/Vertex).'
    case 'disabled_by_env':
      return 'Fast mode is disabled by the CLAUDE_CODE_DISABLE_FAST_MODE environment variable.'
    case 'model_not_allowed':
      return 'The current model is not allowed to use fast mode in your organization.'
    case 'preference':
      return 'Fast mode is turned off for your account or organization.'
    case 'network_error':
      return 'Fast mode availability could not be checked (network issue).'
    case 'pending':
      return 'Still checking whether fast mode is available…'
    case 'sdk_opt_in_required':
      return 'Fast mode was not enabled for this session.'
    default:
      // 모델별 미지원은 이유 없이 state='off' 로만 온다 — 가장 흔한 경우라 여기서 안내한다.
      return 'This session runs at standard speed — fast mode needs a fast-capable model (Opus 5 or Opus 4.8) on a paid plan.'
  }
}

// ── 백엔드가 선언하는 선택지 (main → renderer) ───────────────────────────
// 모델·effort·권한 모드는 백엔드마다 다르므로 렌더러에 상수로 박지 않고, 백엔드 메타에서 받아
// 그대로 그린다. 덕분에 Codex 처럼 카탈로그가 동적인(model/list) 백엔드도 같은 UI 를 쓴다.

/** 권한 모드 1개의 표시 정보. 배열 순서가 곧 shift+tab 순환 순서다. */
export interface PermissionModeInfo {
  id: PermissionMode
  /** 드롭다운·설정 표시 명칭 (예: "Accept edits"). */
  label: string
  /** 한 줄 설명 (예: "Auto-accept file edits, ask for the rest"). */
  description: string
  /** 입력창 아래 푸터 배너. null 이면 배너 없이 단축키 힌트만 보여 준다. */
  footer: { symbol: string; text: string } | null
}

/** reasoning effort 선택지 1개의 표시 정보. */
export interface EffortOptionInfo {
  id: EffortSetting
  label: string
  /** 드롭다운 옵션의 보조 설명. */
  hint: string
}

/** 모델 선택지 1개. Claude 는 정적 목록, Codex 는 app-server 의 model/list 에서 온다. */
export interface ModelOption {
  id: string
  label: string
  /**
   * 이 모델이 지원하는 effort 단계. 지정하면 effort 피커가 이 목록으로 좁혀진다
   * (Codex 의 model/list 는 모델별 supportedReasoningEfforts 를 준다). 없으면 백엔드 기본 목록.
   */
  efforts?: EffortSetting[]
  /**
   * 이 모델에서 fast mode(`/fast`)가 실제로 켜지는지(Claude Code 모델 레지스트리의
   * `fast_mode` capability). 미지원 모델에서 켜 두면 CLI 가 조용히 표준 속도로 돌린다.
   */
  fastMode?: true
}

// ── 도메인 엔티티 ────────────────────────────────────────────────────────

/**
 * 전달 항목을 워크트리에 놓는 방식.
 *  - copy: 워크트리마다 독립된 사본. 워크스페이스별로 값이 달라야 하는 `.env`(포트 등)에 맞다.
 *  - link: 메인 체크아웃의 원본을 심링크로 공유. 원본을 고치면 모든 워크스페이스에 반영된다.
 *
 * 기본은 copy 다 — link 는 여러 워크스페이스가 같은 파일을 보게 되므로, 병렬 에이전트가
 * 동시에 쓰는 파일(MEMORY.md 같은 누적 학습 노트)에서는 서로의 내용을 덮어쓸 수 있다.
 */
export type CarryMode = 'copy' | 'link'

/** 워크트리 생성 시 메인 체크아웃에서 함께 가져올 항목 하나. */
export interface CarryItem {
  /** 리포 루트 기준 상대 경로. 절대 경로·`..`·`.git` 은 저장 시점에 거부된다. */
  path: string
  mode: CarryMode
}

/**
 * 전달에 실패한 항목. 전달 실패가 워크스페이스 생성 자체를 막지는 않지만,
 * 에이전트 컨텍스트 파일(agentContext=true)이 빠지면 에이전트가 **조용히 다르게 동작**하므로
 * 이 기능이 막으려던 상황 그 자체가 된다 — 렌더러가 토스트로 눈에 띄게 알린다.
 */
export interface CarryFailure {
  path: string
  reason: string
  agentContext: boolean
}

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
   * worktree 생성 시 메인 체크아웃에서 함께 가져올 항목들.
   *
   * `git worktree add` 는 git 이 추적하는 파일만 채우므로, gitignore 된 파일
   * (`CLAUDE.local.md`, `.env`, `.claude/settings.local.json` …)은 아무것도 딸려오지 않는다.
   * 그 결과가 에러가 아니라 **조용한 오작동**이라 — 에이전트가 프로젝트 지침을 못 읽고
   * 메인 체크아웃과 다르게 행동한다 — 리포별로 전달 목록을 지정할 수 있게 한다.
   */
  carryItems: CarryItem[]
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
 * 이 워크스페이스의 PR 을 병합했을 때 캐스케이드가 rebase 후 force-push 하게 될 브랜치들.
 *
 * 병합 확인 창에서 이 목록을 먼저 보여 주기 위한 것이다 — 캐스케이드는 자식 브랜치의 리모트
 * 히스토리를 되쓰므로, "Merge" 한 번에 조용히 나가면 안 된다.
 * 모델 A(자식 워크스페이스: 직속 자식만 rebase)와 모델 B(worktree 안 스택: 위쪽 전부 rebase)를
 * 함께 센다.
 */
export function cascadeAffectedBranches(ws: Workspace, all: Workspace[]): string[] {
  const out: string[] = []
  for (const w of all) {
    if (w.parentWorkspaceId === ws.id && !w.archived) out.push(w.branch)
  }
  const stack = ws.stack
  if (stack && stack.length > 1) {
    const idx = stack.findIndex((e) => e.branch === ws.branch)
    if (idx >= 0) for (const e of stack.slice(idx + 1)) out.push(e.branch)
  }
  return out
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
 * 드래그한 항목을 드롭 대상의 앞에 놓을지 뒤에 놓을지.
 * 행의 세로 중앙을 기준으로 정해진다(위쪽 절반=before, 아래쪽 절반=after).
 */
export type DropPosition = 'before' | 'after'

/**
 * draggedId 항목을 빼서 targetId 항목의 앞/뒤에 다시 끼워 넣은 새 배열을 돌려준다.
 * 리포·워크스페이스 목록은 저장된 배열 순서가 곧 표시 순서라(별도 order 필드 없음),
 * 사이드바 드래그 앤 드롭 재정렬이 이 함수 하나로 표현된다.
 *
 * 대상이 없거나 자기 자신에 놓으면 원본을 그대로 돌려준다(호출부가 no-op 으로 다룰 수 있게).
 */
export function reorderById<T extends { id: string }>(
  items: T[],
  draggedId: string,
  targetId: string,
  position: DropPosition
): T[] {
  if (draggedId === targetId) return items
  const from = items.findIndex((i) => i.id === draggedId)
  const target = items.find((i) => i.id === targetId)
  if (from < 0 || !target) return items

  const next = items.slice()
  const [moved] = next.splice(from, 1)
  // 대상 인덱스는 제거 후 배열에서 다시 찾는다 — 드래그 항목이 대상보다 앞에 있었다면
  // 제거로 인해 한 칸 당겨지므로, 원본 인덱스를 그대로 쓰면 한 칸씩 어긋난다.
  const to = next.indexOf(target)
  next.splice(position === 'before' ? to : to + 1, 0, moved)
  return next
}

/**
 * 사이드바에 실제로 보이는 순서(위 → 아래) 그대로 활성 워크스페이스를 평탄하게 나열한다.
 * 규칙: repos 배열 순서로 레포를 훑고, 레포 안에서는 orderByStack(부모 바로 뒤에 자식) 순서.
 * 두 배열 순서가 곧 표시 순서이므로(reorderById 참조), 드래그 앤 드롭 재정렬도 그대로 반영된다.
 *
 * ⌘1–9 번호 배지·⌘1–9 선택·⌘[ / ⌘] 순환이 모두 이 함수 하나를 공유해야 한다.
 * (예전에는 app.workspaces 원본 배열 순서를 그대로 썼는데, 그 배열은 레포별로 묶여 있지 않아
 *  레포가 여러 개면 A→B→A 처럼 섞여 화면 순서와 어긋났다. 그래서 번호가 꼬였다.)
 */
export function orderVisibleWorkspaces<
  R extends { id: string },
  W extends { id: string; repoId: string; archived: boolean; parentWorkspaceId: string | null }
>(repos: R[], workspaces: W[]): W[] {
  const byRepo = new Map<string, W[]>()
  for (const w of workspaces) {
    if (w.archived) continue
    const list = byRepo.get(w.repoId) ?? []
    list.push(w)
    byRepo.set(w.repoId, list)
  }
  const out: W[] = []
  const push = (list: W[]): void => {
    for (const { workspace } of orderByStack(list)) out.push(workspace)
  }
  for (const repo of repos) {
    const list = byRepo.get(repo.id)
    if (!list) continue
    byRepo.delete(repo.id)
    push(list)
  }
  // repos 에 없는 레포(삭제 직후 등)의 워크스페이스도 유실 없이 뒤에 붙인다.
  for (const list of byRepo.values()) push(list)
  return out
}

/**
 * 이 워크스페이스를 구동하는 AI 코딩 에이전트 백엔드 식별자.
 * - claude: Claude Code (Claude Agent SDK)
 * - codex: OpenAI Codex (`codex app-server` JSON-RPC)
 *
 * 워크스페이스는 생성 시 하나를 골라 **그 세션 동안 고정**한다. 백엔드별 기능 지원 여부
 * (capabilities)·권한 모드·기본 모델 등 메타데이터는 main 의 agent 레지스트리가 보유한다.
 */
export type AgentBackendId = 'claude' | 'codex'

/** 전체 백엔드 식별자 목록(등록 순서 = UI 표시 순서). */
export const AGENT_BACKEND_IDS: AgentBackendId[] = ['claude', 'codex']

/** 백엔드를 지정하지 않은(레거시·신규) 워크스페이스의 기본 백엔드. */
export const DEFAULT_AGENT_BACKEND: AgentBackendId = 'claude'

/**
 * 백엔드의 사람이 읽는 이름. 브랜드 마크(SVG)는 렌더러가 갖지만 이름은 도메인 메타데이터라
 * 여기 둔다(main 의 로그·알림에서도 같은 표기를 쓸 수 있다).
 *
 * Record<AgentBackendId, string> 이므로 유니온에 백엔드를 추가하면 컴파일 에러로 잡힌다.
 */
export const AGENT_BACKEND_LABELS: Record<AgentBackendId, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

/**
 * 백엔드가 지원하는 선택 기능 집합. 오케스트레이터는 이 값으로 호출을 가드하고,
 * 렌더러는 명령·버튼 노출 여부를 판단한다.
 */
export interface AgentCapabilities {
  /** /btw 사이드 질문 */
  sideQuestion: boolean
  /** /rewind 파일 체크포인트 되돌리기 */
  rewind: boolean
  /** /mcp 서버 패널 + 재연결/활성화 동작 */
  mcp: boolean
  /** reasoning effort 단계 선택 */
  effort: boolean
  /** fast mode(`/fast`) — 지원 모델의 빠른 service tier 를 사용한다. */
  fastMode: boolean
  /**
   * 이 백엔드가 실제로 답할 수 있는 인터랙티브 명령 패널의 종류(/context·/usage·/mcp 등).
   *
   * 불리언이 아니라 목록인 이유: 백엔드마다 지원 범위가 다르다(Codex 는 /context·/usage 는
   * 되지만 /rewind·/agents 는 없다). 불리언이면 입력창이 지원하지 않는 명령까지 자동완성에
   * 띄우고, 사용자가 실행하면 에러 토스트가 뜬다.
   */
  interactiveCommands: CommandPanelKind[]
  /** 슬래시 명령 자동완성 */
  slashCommands: boolean
  /** 턴이 도는 중에도 입력을 밀어 넣을 수 있는지(Codex 의 turn/steer). false 면 큐잉 후 다음 턴. */
  steering: boolean
  /** 앱 안에서 로그인/로그아웃을 끝낼 수 있는지. false 면 외부 터미널 안내. */
  inAppLogin: boolean
  /** 플랜 사용량·rate limit 조회 지원 여부. */
  rateLimits: boolean
  /** /add-dir — worktree 밖 디렉토리를 작업 루트로 더 열어 줄 수 있는지. */
  addDirectory: boolean
}

/**
 * 백엔드 1개의 식별·표시·선택지·capabilities. main 이 소유하고 IPC 로 렌더러에 내려 준다
 * (`IPC.agentListBackends`) — 렌더러는 이 값만 보고 모델·effort·권한 모드 UI 를 그린다.
 */
export interface AgentBackendMeta {
  id: AgentBackendId
  /** 사용자에게 보여 줄 이름(예: "Claude Code"). */
  label: string
  /** 이 백엔드의 기본 모델 ID. null 이면 백엔드/CLI 기본값을 따른다. */
  defaultModel: string | null
  /** 권한 모드 선택지. 배열 순서가 shift+tab 순환 순서다. */
  permissionModes: PermissionModeInfo[]
  /** 워크스페이스·전역 설정이 값을 지정하지 않았을 때의 권한 모드. */
  defaultPermissionMode: PermissionMode
  /** reasoning effort 선택지(모델별로 좁혀질 수 있다 — ModelOption.efforts 참고). */
  efforts: EffortOptionInfo[]
  capabilities: AgentCapabilities
  /**
   * 지금 이 백엔드를 실제로 쓸 수 있는지(CLI 설치 + 최소 버전 충족). 런타임에 계산된다.
   * false 면 새 워크스페이스 피커에서 감추고, 이미 만들어진 워크스페이스에는 안내 배너를 띄운다.
   */
  available: boolean
  /** available=false 인 이유(설치 안내·업그레이드 안내 등 사용자 표시용). */
  unavailableReason?: string
}

/**
 * 저장된 권한 모드를 이 백엔드가 실제로 지원하는 값으로 보정한다.
 *
 * 전역 기본값·마이그레이션·백엔드 전환 때문에 백엔드가 모르는 모드가 흘러들 수 있다
 * (예: Codex 워크스페이스에 Claude 의 'acceptEdits'). 그대로 넘기면 CLI 가 거부하거나 조용히
 * 엉뚱하게 동작하므로, 지원 목록에 없으면 그 백엔드의 기본 모드로 떨어뜨린다.
 */
export function normalizePermissionMode(
  meta: Pick<AgentBackendMeta, 'permissionModes' | 'defaultPermissionMode'>,
  mode: PermissionMode | null | undefined
): PermissionMode {
  if (mode && meta.permissionModes.some((m) => m.id === mode)) return mode
  return meta.defaultPermissionMode
}

/** 목록 안에서 다음 권한 모드로 순환한다(shift+tab). 목록에 없으면 첫 항목부터. */
export function nextPermissionMode(
  modes: PermissionModeInfo[],
  mode: PermissionMode
): PermissionMode {
  if (modes.length === 0) return mode
  const i = modes.findIndex((m) => m.id === mode)
  return modes[(i + 1) % modes.length].id
}

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
  /**
   * 부모 PR 이 병합된 것을 감지했을 때의 대기 중 캐스케이드 계획.
   * 실행하지 않은 상태로만 보관한다(force-push 는 사용자 승인 후에만). 승인·해소되면 지워진다.
   * 병합을 어디서 했든(wooi·gh CLI·GitHub 웹) 같은 경로로 감지된다.
   */
  stackSync?: StackSyncPlan | null
  /**
   * 사용자가 "무시"한 계획의 병합 브랜치. 같은 병합을 재감지해 배너가 다시 뜨는 것을 막는다.
   * 브랜치명을 기억하는 이유는, 그 위에서 또 다른 병합이 일어나면 다시 알려야 하기 때문이다.
   */
  stackSyncDismissed?: string | null
  /**
   * PR 의 base 가 스택 관계와 어긋난 상태(감지만 — 리타겟은 사용자 승인 후). 없으면 null.
   * 해소되면(리타겟했거나 사용자가 그대로 두기로 했으면) 지워진다.
   */
  baseMismatch?: BaseMismatch | null
  /**
   * 사용자가 "그대로 둔다"고 한 base 브랜치. 그 base 를 다시 어긋남으로 보지 않기 위해 기억한다
   * (스택 위에서 일부러 다른 브랜치를 향하게 두는 경우가 있다).
   */
  baseMismatchDismissed?: string | null
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
  /**
   * resume 용 세션 ID. 백엔드마다 의미가 다르지만 역할은 같다 —
   * Claude Code 의 session id, Codex 의 thread id. 아직 세션을 시작하지 않았으면 null.
   */
  sessionId: string | null
  permissionMode: PermissionMode
  status: WorkspaceStatus
  /** 이 workspace 전용 모델 오버라이드. null 이면 전역 설정(AppSettings.model) 을 따른다. */
  model: string | null
  /** 이 workspace 전용 reasoning effort 오버라이드. null 이면 전역 설정(AppSettings.effort) 을 따른다. */
  effort: EffortSetting | null
  /** 이 workspace 전용 fast mode 오버라이드. null 이면 전역 설정(AppSettings.fastMode) 을 따른다. */
  fastMode: boolean | null
  /**
   * `/add-dir` 로 더해진 작업 디렉토리(절대 경로). worktree 밖의 코드를 함께 읽고 고쳐야 할 때
   * 쓴다 — 에이전트는 기본적으로 cwd 밖을 건드리지 못한다. 세션 시작 시점에 고정되는 값이라
   * 추가하면 세션을 새로 연다(대화 맥락은 resume 으로 이어진다).
   */
  additionalDirs?: string[]
  /** init 메시지에서 확인된 실제 모델명(예: "claude-opus-4-8[1m]"). 표시용. */
  lastModel: string | null
  /**
   * 세션이 보고한 fast mode 실제 상태(표시용). 아직 턴을 돌리지 않아 모르면 null.
   * 설정을 켜 뒀어도 모델·플랜·쿨다운 때문에 'off'/'cooldown' 일 수 있다.
   */
  fastModeState: FastModeState | null
  /** fast mode 가 꺼져 있는 이유(CLI 보고). 이유를 특정할 수 없거나 켜져 있으면 null. */
  fastModeReason: FastModeDisabledReason | null
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

/**
 * 백엔드 1개의 전역 기본값. 모델 ID·권한 모드가 백엔드마다 다르므로 하나의 전역 값으로는
 * 백엔드를 오갈 때 항상 어긋난다 — 그래서 백엔드별로 따로 기억한다.
 * 각 값이 null 이면 백엔드 메타의 기본값(defaultModel·defaultPermissionMode)을 따른다.
 */
export interface AgentSettings {
  /** 사용할 모델 ID (예: "claude-opus-4-8[1m]", "gpt-5.5"). */
  model: string | null
  /**
   * 새 turn 에 적용할 기본 reasoning effort. null 이면 effort 를 지정하지 않아 모델의 기본 동작을
   * 따른다. workspace 가 자체 effort 를 지정하면 그 값이 우선한다.
   */
  effort: EffortSetting | null
  /**
   * 새 세션에 적용할 기본 fast mode(Claude Code 의 `/fast`). true 면 같은 모델을 더 빠른 출력
   * 속도로 돌린다(지원 모델·유료 플랜 필요). workspace 가 자체 값을 지정하면 그 값이 우선한다.
   */
  fastMode: boolean
  /** 새 워크스페이스의 기본 권한 모드. null 이면 백엔드의 defaultPermissionMode. */
  permissionMode: PermissionMode | null
}

/** 백엔드별 기본값의 초기 상태(모두 "백엔드 기본을 따름"). */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  model: null,
  effort: null,
  permissionMode: null,
  fastMode: false
}

/**
 * 백엔드 하나의 전역 기본값을 꺼낸다. 저장된 설정에 해당 백엔드 항목이 없어도(구버전에서
 * 마이그레이션됐거나 백엔드가 나중에 추가됨) 안전한 기본값을 돌려준다.
 */
export function agentSettingsFor(settings: AppSettings, id: AgentBackendId): AgentSettings {
  return settings.agents?.[id] ?? DEFAULT_AGENT_SETTINGS
}

export interface AppSettings {
  /**
   * 새 워크스페이스가 기본으로 쓸 에이전트 백엔드. 사용자가 두 에이전트를 모두 보유했을 때만
   * 의미가 있으며, 하나뿐이면 그 하나로 자동 해석된다.
   */
  defaultAgentBackend: AgentBackendId
  /** 백엔드별 전역 기본값(모델·effort·권한 모드). */
  agents: Record<AgentBackendId, AgentSettings>
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
   * 사이드바에서 워크스페이스 행 아래에 "지금 돌고 있는 서브에이전트" 목록을 보여 준다(기본 켜짐).
   *
   * 표시 전용 설정이다 — 끄더라도 main 의 추적은 계속된다. 그래서 토글이 세션 재시작 없이 즉시
   * 반영되고, 다시 켜면 지금 돌고 있는 것이 바로 나타난다(추적을 껐다면 다음 턴까지 빈 목록이 된다).
   */
  showRunningAgents: boolean
  /**
   * Claude Code CLI 처럼, 한 턴이 끝났을 때 컨텍스트 사용량이 임계치를 넘으면 대화를
   * 자동으로 압축(/compact)한다. 끄면 사용량만 표시하고 압축은 수동(/compact)으로만.
   * 임계치는 Claude Code 가 모델별로 알려주는 값을 그대로 쓴다(session.ts 의 overAutoCompactThreshold).
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
  /**
   * PR 리뷰 세션(메타데이터만). 워크스페이스와 나란히 사이드바가 그리므로 같은 상태 방송에
   * 실어 보낸다 — 덕분에 아카이브 UI 가 워크스페이스 것과 같은 모양으로 나온다.
   */
  reviews: ReviewSession[]
  settings: AppSettings
  /**
   * 레거시 Claude 계정 레이트리밋 스냅샷. 새 코드는 rateLimitsByAgent를 우선 사용한다.
   * 기존 저장 파일과의 호환을 위해 유지한다.
   */
  rateLimits?: RateLimitSnapshot
  /** backend별 계정 사용량. rateLimits는 이전 버전의 Claude 스냅샷 호환 필드로 유지한다. */
  rateLimitsByAgent?: Partial<Record<AgentBackendId, RateLimitSnapshot>>
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
  | {
      id: string
      type: 'tool_use'
      toolId: string
      name: string
      input: unknown
      /**
       * 파일을 바꾸는 도구(Edit·Write·MultiEdit·NotebookEdit)의 통합 diff.
       * 도구 실행 **전**에만 뜰 수 있어(그 뒤엔 파일이 이미 바뀌었다) 아이템에 함께 저장한다 —
       * 대화를 다시 열었을 때도 그때 무엇이 바뀌었는지 그대로 볼 수 있다.
       */
      diff?: string
      ts: number
    }
  | { id: string; type: 'tool_result'; toolId: string; text: string; isError: boolean; ts: number }
  | {
      id: string
      type: 'result'
      subtype: string
      isError: boolean
      durationMs: number
      numTurns: number
      /** 턴 원가(USD). 백엔드가 원가를 알려 주지 않으면(Codex) 생략되고 UI 도 감춘다. */
      costUsd?: number
      ts: number
    }
  | { id: string; type: 'error'; text: string; ts: number }
  | { id: string; type: 'system'; text: string; ts: number }
  /**
   * 명령 1회 실행 카드. 두 가지 출처를 같은 모양으로 그린다:
   * - 사용자의 `!명령` (Claude Code CLI bash 모드) — `agent` 없음
   * - 에이전트가 샌드박스에서 실행한 셸 명령 (Codex 의 commandExecution) — `agent: true`
   *
   * 우측 터미널 패널이 아니라 대화 흐름 안에 인라인으로 명령과 출력을 보여 준다 — id 기준
   * upsert 로 실행 중에는 출력이 자라고, 끝나면 running:false + 종료 코드로 확정된다.
   */
  | {
      id: string
      type: 'bash'
      /** 에이전트가 실행한 명령이면 true(도구 카드 스타일로 렌더). 사용자의 `!명령` 이면 생략. */
      agent?: true
      /** 실행 디렉터리. 워크스페이스 루트와 다를 때만 표시한다. */
      cwd?: string
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

/**
 * 지금 살아 있는 서브에이전트 1건의 표시용 스냅샷(사이드바 "Running agents" 패널).
 *
 * 트랜스크립트 ChatItem 이 아니라 **휘발성 상태**다 — 영속하지 않고, 세션이 끝나면 사라진다.
 * 서브에이전트는 이미 부모 턴의 tool_use/tool_result 카드로 트랜스크립트에 남으므로, 여기서
 * 다시 기록하면 이중 표시가 된다. 패널은 "지금 무엇이 돌고 있나"만 답한다.
 */
export interface RunningAgent {
  /** SDK task_id. 이 워크스페이스 안에서 유일하며, 갱신·종료를 이 값으로 병합한다. */
  taskId: string
  /** 서브에이전트 타입(SDK subagent_type). 예: 'Explore', 'code-reviewer'. */
  agentType: string
  /** 현재 수행 중인 일의 설명. task_progress 로 갱신된다. */
  description: string
  /** 시작 시각(epoch ms). 경과 시간 표시용. */
  startedAt: number
  /** 누적 토큰 사용량(진행 메시지가 오면). */
  totalTokens?: number
  /** 누적 도구 호출 수(진행 메시지가 오면). */
  toolUses?: number
  /** 마지막으로 호출한 도구 이름(진행 메시지가 오면). */
  lastToolName?: string
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
  /**
   * 세션이 보고한 fast mode 실제 상태(턴 result 기준). 설정을 켜 뒀어도 미지원 모델·플랜 제한·
   * 쿨다운이면 'off'/'cooldown' 으로 온다 — 상태줄이 "설정" 이 아니라 "실제" 를 보여 주게 한다.
   */
  | { type: 'fastMode'; state: FastModeState; reason?: FastModeDisabledReason }
  /**
   * 이 워크스페이스에서 지금 살아 있는 서브에이전트 **전체 목록**.
   *
   * REPLACE 시맨틱이다 — 렌더러는 목록을 병합하지 말고 통째로 갈아끼운다. 시작/종료 엣지를
   * 짝지어 맞추는 방식이면 알림 하나만 유실돼도 스피너가 영구히 남는데, 매번 전량을 보내면
   * 다음 갱신에서 저절로 복구된다. 빈 배열 = 실행 중인 서브에이전트 없음.
   */
  | { type: 'agents'; agents: RunningAgent[] }

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
  /**
   * 요청의 성격. 프롬프트 렌더링을 가른다(명령은 명령 줄, 파일 변경은 diff, 질문은 선택지 UI).
   * 없으면 'tool' 로 간주한다 — 기존 Claude 경로와 저장된 트랜스크립트 호환.
   */
  kind?: 'tool' | 'command' | 'fileChange' | 'question' | 'plan'
  /** kind==='fileChange' 일 때 제안된 통합 diff. DiffView 로 그대로 보여 준다. */
  diff?: string
  /**
   * "다시 묻지 않기" 를 고르면 저장될 규칙(예: `Bash(npm run:*)`).
   * 도구 이름 하나를 통째로 여는 게 아니라 무엇을 허용하는지 사용자가 보고 고르게 한다.
   */
  rule?: string
  /**
   * 백엔드가 이 요청에 대해 제공하는 결정 선택지. 없으면 UI 는 기본 Allow/Deny 를 그린다.
   * Codex 는 여기에 accept / acceptForSession / decline 등을 그대로 실어 보낸다.
   */
  options?: PermissionOption[]
}

/** 승인 프롬프트가 그리는 버튼 1개. `id` 는 백엔드가 해석하는 불투명 값이다. */
export interface PermissionOption {
  id: string
  label: string
  behavior: 'allow' | 'deny'
  /** 이 선택이 세션 동안 같은 종류를 자동 승인하는지(버튼 강조·설명에 사용). */
  rememberForSession?: boolean
  /**
   * 자동 승인을 어디까지 기억할지. 'session' 은 이 세션 동안만,
   * 'project' 는 리포의 `.claude/settings.local.json` 에 적어 다음 세션에도 남긴다.
   */
  rememberScope?: 'session' | 'project'
  /** 선택지 아래 한 줄 설명(계획 승인처럼 결과가 서로 다른 선택지에서 사용). */
  description?: string
}

/**
 * 계획(plan) 승인 프롬프트의 선택지. ExitPlanMode 승인은 단순 allow/deny 가 아니라
 * "승인 후 어떤 권한 모드로 코딩을 시작할지" 를 함께 고르는 것이라, id 를 세션(main)과
 * 프롬프트(렌더러)가 공유해야 한다 — 터미널 Claude Code 의 세 선택지와 같은 의미다.
 */
export const PLAN_OPTIONS: PermissionOption[] = [
  {
    id: 'plan-auto-accept',
    label: 'Yes, and auto-accept edits',
    behavior: 'allow',
    description: 'Switches to Accept edits — file edits apply without asking'
  },
  {
    id: 'plan-manual',
    label: 'Yes, and manually approve edits',
    behavior: 'allow',
    description: 'Switches to Default — every edit still asks first'
  },
  {
    id: 'plan-keep',
    label: 'No, keep planning',
    behavior: 'deny',
    description: 'Stays in Plan mode so you can keep refining the plan'
  }
]

/** 계획 승인 시 전환할 권한 모드. 알 수 없는 선택지는 안전한 쪽(매번 확인)으로 떨어진다. */
export function planApprovalMode(optionId: string | undefined): PermissionMode {
  return optionId === 'plan-auto-accept' ? 'acceptEdits' : 'default'
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      rememberForSession?: boolean
      /** rememberForSession 일 때 기억 범위. 없으면 'session'. */
      rememberScope?: 'session' | 'project'
      /**
       * 도구 입력에 합쳐 SDK 로 되돌려줄 값. AskUserQuestion 처럼 사용자의 응답을
       * 입력에 주입해야 하는 도구에서 사용한다(예: { answers: { 질문: 선택 } }).
       * 없으면 원래 입력을 그대로 사용한다.
       */
      updatedInput?: Record<string, unknown>
      /** 사용자가 고른 `PermissionRequest.options` 의 id. 백엔드 고유 결정지를 그대로 되돌린다. */
      optionId?: string
    }
  | { behavior: 'deny'; optionId?: string }

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

// ── stacked PR 캐스케이드 (부모 병합 후 자식 리타겟·리베이스) ──────────────

/**
 * 캐스케이드 한 단계의 종류.
 * - retarget: 자식 PR 의 base 를 조부모로 옮김(gh pr edit --base).
 * - recover: base 브랜치가 삭제돼 GitHub 가 닫아 버린 자식 PR 을 되살림
 *   (base 브랜치 복원 → reopen → retarget → 발판 브랜치 정리).
 * - restack: 새 base 위로 rebase 하고 force-push.
 */
export type StackCascadeStepKind = 'retarget' | 'recover' | 'restack'

/** 캐스케이드 한 단계의 결과. 실패해도 다음 브랜치는 계속 시도하고, 결과를 모아 UI 로 올린다. */
export interface StackCascadeStep {
  branch: string
  prNumber: number | null
  kind: StackCascadeStepKind
  /** skipped = 이미 원하는 상태였음(GitHub 가 자동 retarget 한 경우 등). */
  status: 'ok' | 'skipped' | 'conflict' | 'failed'
  /** status==='conflict' 일 때 충돌 파일들(RestackResult 와 같은 의미). */
  conflictedFiles?: string[]
  /** 실패·건너뜀 사유(사용자에게 그대로 보여 준다). */
  message?: string
}

/** 캐스케이드 전체 결과. 단계별 성공/실패를 모두 담아 조용히 삼키지 않는다. */
export interface StackCascadeResult {
  steps: StackCascadeStep[]
}

/** 캐스케이드에서 사용자가 알아야 할(성공이 아닌) 단계만 추린다. */
export function cascadeProblems(result: StackCascadeResult): StackCascadeStep[] {
  return result.steps.filter((s) => s.status === 'conflict' || s.status === 'failed')
}

/**
 * 외부(gh CLI·GitHub 웹)에서 부모 PR 이 병합돼 스택이 stale 해진 상태.
 * 감지만 해 두고 실행하지 않는다 — 캐스케이드는 자식 브랜치를 rebase 후 force-push 하므로
 * 사용자 모르게 자동으로 나가면 안 된다. UI 가 이 계획을 보여 주고 승인받은 뒤 실행한다.
 */
export interface StackSyncPlan {
  /** 이미 병합된 부모 브랜치. */
  mergedBranch: string
  /** 병합된 부모의 base — 자식들이 옮겨갈 새 base. */
  newBase: string
  /** 옮겨야 할 자식들(아래→위). */
  affected: Array<{
    branch: string
    prNumber: number | null
    /** base 브랜치가 삭제돼 GitHub 가 PR 을 닫아 버렸는지(복구 단계 필요). */
    prClosed: boolean
  }>
  detectedAt: number
}

/**
 * 스택 워크스페이스의 PR 이 부모가 아닌 브랜치(대개 리포 기본 브랜치)를 향하고 있는 상태.
 *
 * `--base` 없이 `gh pr create` 를 실행하면 gh 가 리포 기본 브랜치를 고르기 때문에, 에이전트가
 * 직접 PR 을 열면 흔히 이렇게 된다. 예전에는 이 값을 그대로 진실로 채택했는데, 그러면 스택
 * 관계가 경고 한 줄 없이 사라지고 ahead/behind·restack·머지 캐스케이드가 전부 엉뚱한 기준으로
 * 계산된다. 그래서 채택하지 않고 사용자에게 물어본다(리타겟할지, 이대로 둘지).
 */
export interface BaseMismatch {
  /** 어긋난 PR 번호. */
  prNumber: number
  /** PR 이 실제로 향하고 있는 base 브랜치. */
  prBase: string
  /** 스택 관계상 향해야 할 base(부모 워크스페이스의 브랜치). */
  expectedBase: string
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

// ── PR 리뷰 모드 ─────────────────────────────────────────────────────────
//
// 워크스페이스의 Changes 탭이 쓰는 FileDiff 와 달리, 리뷰 모드는 **줄 하나하나가 주소를 가져야**
// 한다 — GitHub 인라인 코멘트가 "diff 안에 실제로 존재하는 줄"만 받기 때문이다(아니면 422).
// 그래서 patch 를 통짜 문자열로 두지 않고 hunk → row 로 쪼개 old/new 줄 번호를 계산해 둔다.

/** GitHub 코멘트의 기준 면. RIGHT = 새 파일(추가/문맥), LEFT = 옛 파일(삭제/문맥). */
export type DiffSide = 'LEFT' | 'RIGHT'

export type DiffRowKind = 'context' | 'add' | 'del'

/** diff 한 줄. 코멘트를 달 수 있는 최소 단위. */
export interface DiffRow {
  kind: DiffRowKind
  /** 앞의 +/-/공백 표식을 뗀 코드 본문. */
  text: string
  /** 옛 파일에서의 줄 번호. add 행은 null. */
  oldLine: number | null
  /** 새 파일에서의 줄 번호. del 행은 null. */
  newLine: number | null
}

export interface ReviewHunk {
  /** "@@ -1,7 +1,9 @@ fn foo()" 원문 헤더(뒤쪽 섹션 힌트 포함). */
  header: string
  rows: DiffRow[]
}

export interface ReviewFileDiff {
  /** 새 경로. 삭제된 파일이면 옛 경로. GitHub API 의 `path` 로 그대로 쓴다. */
  path: string
  /** rename 일 때의 옛 경로. 아니면 null. */
  oldPath: string | null
  status: FileDiffStatus
  additions: number
  deletions: number
  binary: boolean
  hunks: ReviewHunk[]
}

export interface ReviewDiff {
  files: ReviewFileDiff[]
}

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit' | 'question' | 'praise'

/** 에이전트가 submit_review 도구로 제출한 지적 1건(앵커 검증 전 원본). */
export interface ReviewFindingInput {
  severity: ReviewSeverity
  title: string
  /** GitHub 마크다운. ```suggestion 블록 허용. */
  body: string
  /** 인라인 지적일 때만. diff 에 나온 경로 그대로. */
  file?: string
  line?: number
  /** 여러 줄에 걸친 지적의 시작 줄. */
  startLine?: number
  side?: DiffSide
}

export interface ReviewArtifact {
  summary: string
  /** 후속 턴의 대화형 답변. 최초 리뷰에서는 비어 있다. */
  reply: string
  general: ReviewFindingInput[]
  inline: ReviewFindingInput[]
}

/** diff 의 실제 행에 확정 고정된 위치. 이 값이 있어야 인라인 코멘트를 걸 수 있다. */
export interface ReviewAnchor {
  file: string
  side: DiffSide
  line: number
  startLine: number | null
  /** 에이전트가 준 줄이 diff 에 없어 가까운 줄로 옮겼다면 원래 줄. 아니면 null. */
  snappedFrom: number | null
}

/** 앵커 검증까지 끝난 지적. anchor 가 null 이면 전반(general) 지적. */
export interface ReviewFinding {
  id: string
  severity: ReviewSeverity
  title: string
  body: string
  anchor: ReviewAnchor | null
}

export type ReviewStatus = 'preparing' | 'running' | 'done' | 'error' | 'cancelled'

export type ReviewCommentKind = 'inline' | 'issue'

/** PR 전체에 대한 판정. 개별 코멘트와 달리 GitHub 의 리뷰 제출 엔드포인트로 간다. */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment'

/**
 * 자기 PR 에는 승인·변경 요청을 낼 수 없다는 안내. GitHub 서버의 규칙이라 우리가 우회할 수
 * 없으므로, 화면에서 선택지를 감출 때와 main 이 제출을 막을 때 **같은 문장**을 쓴다.
 */
export const SELF_REVIEW_BLOCKED =
  "GitHub doesn't let you approve or request changes on your own pull request."

/**
 * 같은 리뷰를 PR 변화 없이 다시 내려 할 때의 안내. 위와 같은 이유로 화면과 main 이 같은
 * 문장을 공유한다.
 */
export const DUPLICATE_REVIEW_BLOCKED =
  "You already submitted this review, and the pull request hasn't changed since."

/**
 * Wooi 로 게시한 코멘트 1건.
 *
 * `commentId` 는 답글을 찾는 **유일한 조인 키**다 — GitHub 인라인 답글은 `in_reply_to_id` 로
 * 스레드 루트를 가리키는데, 그 값이 바로 우리가 게시할 때 받은 이 id 다.
 */
export interface PostedComment {
  findingId: string
  commentId: number
  htmlUrl: string
  kind: ReviewCommentKind
  /** ISO 8601. 이 이후에 달린 남의 코멘트만 새 활동으로 본다. */
  createdAt: string
}

/**
 * 사이드바가 그리고 app.json 에 저장되는 리뷰 세션 레코드.
 *
 * 여기에는 **가벼운 메타데이터만** 둔다. diff·지적 본문·활동 로그는 용량이 커서 별도
 * 사이드카 파일로 뺀다(워크스페이스와 트랜스크립트의 관계와 동일) — app.json 은 변경마다
 * 파일 전체를 다시 쓰고 상태 방송마다 통째로 직렬화되기 때문이다.
 */
export interface ReviewSession {
  id: string
  repoId: string
  /**
   * 이 리뷰를 돌리는 에이전트. 워크스페이스와 같은 규칙으로 **시작할 때 정해져 고정**된다 —
   * 후속 턴은 앞선 대화를 resume 하는데, 그 세션 id 는 그 백엔드에서만 유효하기 때문이다.
   */
  agentBackend: AgentBackendId
  prNumber: number
  prUrl: string
  prTitle: string
  /** PR 작성자의 GitHub 로그인. 자기 PR 인지 판단하는 근거다. */
  prAuthor: string
  /**
   * 내가 쓴 PR 인가. GitHub 은 자기 PR 을 승인하거나 변경 요청할 수 없게 막으므로, 이 값이
   * true 면 판정 선택지에서 그 둘을 아예 뺀다(눌러 보고 GraphQL 에러를 받는 대신).
   *
   * 시작 시점에 한 번 계산해 둔다. 작성자도 내 계정도 리뷰 도중에 바뀌지 않는다.
   */
  viewerIsAuthor: boolean
  /** 인라인 코멘트의 commit_id 로 쓰인다. */
  headSha: string
  baseRefName: string
  /** 리뷰를 시작할 때 사용자가 쓴 최초 프롬프트. */
  prompt: string
  status: ReviewStatus
  summary: string
  archived: boolean
  createdAt: number
  updatedAt: number
  /** 후속 턴을 같은 맥락으로 이어 붙이기 위한 SDK 세션 id. */
  agentSessionId: string | null
  postedComments: PostedComment[]
  /** 답글 폴링 워터마크(ISO). 이보다 뒤에 생긴 남의 코멘트만 새 활동으로 본다. */
  lastSeenAt: string | null
  /** 마지막으로 확인한 PR head sha. 달라지면 새 커밋이 올라온 것이다. */
  lastSeenHeadSha: string
  /** 아직 확인하지 않은 새 활동(답글·커밋)이 있는지 — 사이드바 점. */
  unread: boolean
  /** 마지막으로 제출한 리뷰. 화면의 판정 칩과 중복 제출 차단이 모두 이 값을 본다. */
  lastSubmission: ReviewSubmission | null
}

/**
 * 제출한 리뷰 1건의 기록.
 *
 * GitHub 은 같은 리뷰를 몇 번이든 다시 받아 주지만, PR 이 그대로인데 같은 말을 또 올리면
 * 상대의 타임라인만 어지럽힌다. 그래서 **본문과 그때의 head sha 까지** 남긴다 — 이 둘이
 * 있어야 "같은 내용을, 변한 것 없는 PR 에" 내는 경우를 정확히 집어낼 수 있다.
 */
export interface ReviewSubmission {
  verdict: ReviewVerdict
  /** 제출한 본문(앞뒤 공백을 정리한 형태). 같은 내용인지 비교하는 기준. */
  body: string
  /** 제출 시점에 우리가 알던 PR head sha. */
  headSha: string
  at: number
}

/** 실행 중 에이전트 활동을 사용자에게 보여주기 위한 축약 항목. */
export interface ReviewProgressItem {
  id: string
  kind: 'text' | 'tool' | 'error'
  text: string
  ts: number
}

/**
 * 활동 타임라인의 한 항목. 에이전트와의 대화, 가져온 답글, 새 커밋을 한 줄기로 합친다 —
 * 사용자가 보고 싶은 건 "이 리뷰에서 무슨 일이 있었나" 라는 하나의 흐름이기 때문이다.
 */
export type ReviewActivityItem =
  | { id: string; kind: 'turn'; role: 'user' | 'agent'; text: string; ts: number }
  | { id: string; kind: 'tool'; text: string; ts: number }
  | {
      id: string
      kind: 'reply'
      /** 답글이 달린 스레드 루트 코멘트 id(= 우리가 게시한 코멘트). issue 코멘트면 null. */
      threadRootId: number | null
      /** 이 답글 자체의 코멘트 id. 여기에 다시 답장할 때 쓴다. */
      commentId: number
      author: string
      body: string
      htmlUrl: string
      /** 인라인 답글일 때의 위치. line 은 diff 에서 밀려나면 null 일 수 있다. */
      path?: string
      line?: number | null
      ts: number
    }
  | { id: string; kind: 'commits'; headSha: string; ts: number }
  | { id: string; kind: 'error'; text: string; ts: number }

/** 리뷰 화면을 열 때 사이드카에서 한 번에 읽어오는 덩치 큰 부분. */
export interface ReviewBundle {
  diff: ReviewDiff | null
  findings: ReviewFinding[]
  activity: ReviewActivityItem[]
}

export type ReviewEvent =
  | { type: 'status'; status: ReviewStatus }
  | { type: 'diff'; diff: ReviewDiff }
  | { type: 'progress'; item: ReviewProgressItem }
  | { type: 'findings'; findings: ReviewFinding[] }
  | { type: 'activity'; item: ReviewActivityItem }
  | { type: 'error'; message: string }

/** evtReview 페이로드. */
export interface ReviewEnvelope {
  reviewId: string
  event: ReviewEvent
}

/** 리뷰 시작 모달의 열린 PR 목록 항목. */
export interface ReviewPrCandidate {
  number: number
  title: string
  head: string
  base: string
  author: string
}

/**
 * `#` 기억을 어디에 남길지. project = worktree 의 CLAUDE.md(팀과 공유),
 * user = ~/.claude/CLAUDE.md(모든 프로젝트에 적용되는 개인 규칙).
 */
export type MemoryScope = 'project' | 'user'

// ── IPC 채널 이름 ────────────────────────────────────────────────────────

export const IPC = {
  // 양방향 호출 (renderer.invoke → main.handle)
  appGetState: 'app:getState',
  repoAdd: 'repo:add',
  repoRemove: 'repo:remove',
  repoUpdate: 'repo:update',
  /** 전달 목록이 빈 리포에 탐지된 후보(.env·CLAUDE.local.md …)를 한 번에 등록한다. */
  repoAdoptCarry: 'repo:adoptCarry',
  /** 사이드바 드래그 앤 드롭으로 리포 표시 순서를 바꾼다. */
  repoReorder: 'repo:reorder',
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
  /** fast mode(`/fast`) 오버라이드 — null 이면 전역 설정을 따른다. */
  workspaceSetFastMode: 'workspace:setFastMode',
  /**
   * 등록된 에이전트 백엔드의 메타(라벨·권한 모드·effort 선택지·capabilities·가용성) 목록.
   * 렌더러는 모델/effort/권한 모드 UI 를 이 값으로 그린다.
   */
  agentListBackends: 'agent:listBackends',
  /** 백엔드의 모델 선택지. Codex 는 app-server 의 model/list 를 조회하므로 비동기·동적이다. */
  agentListModels: 'agent:listModels',
  /** 워크스페이스별 알림 음소거 토글. */
  workspaceSetMuted: 'workspace:setMuted',
  workspaceRename: 'workspace:rename',
  /** 사이드바 드래그 앤 드롭으로 워크스페이스 표시 순서를 바꾼다(같은 레포·같은 stack 부모끼리만). */
  workspaceReorder: 'workspace:reorder',
  workspaceOpenInEditor: 'workspace:openInEditor',
  workspaceRevealInFinder: 'workspace:revealInFinder',
  /** /memory — worktree 의 CLAUDE.md 를 에디터로 연다(없으면 worktree 를 연다). */
  workspaceOpenMemory: 'workspace:openMemory',
  /** `#` 단축키 — 한 줄짜리 기억을 프로젝트/사용자 CLAUDE.md 에 덧붙인다. */
  workspaceAddMemory: 'workspace:addMemory',
  /** /add-dir — worktree 밖 디렉토리를 작업 루트로 더한다(세션 재시작). */
  workspaceAddDir: 'workspace:addDir',
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
  /** 외부에서 부모 PR 이 병합돼 생긴 대기 중 캐스케이드(stackSync)를 사용자 승인 후 실행한다. */
  stackSyncApply: 'stack:syncApply',
  /** 대기 중 캐스케이드 계획을 무시하고 지운다. */
  stackSyncDismiss: 'stack:syncDismiss',
  /** 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다(gh pr edit --base). */
  stackBaseRetarget: 'stack:baseRetarget',
  /** 어긋난 base 를 의도한 것으로 받아들인다(그 base 를 채택하고 다시 묻지 않는다). */
  stackBaseKeep: 'stack:baseKeep',
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

  /** 리뷰 시작 모달의 열린 PR 목록(제목·작성자 포함). */
  reviewListOpenPrs: 'review:listOpenPrs',
  /** PR 리뷰를 시작한다. 즉시 reviewId 를 돌려주고 나머지는 evtReview 로 흘린다. */
  reviewStart: 'review:start',
  /** 실행 중인 리뷰를 중단한다. */
  reviewCancel: 'review:cancel',
  /** 지적 1건을 실제 PR 에 코멘트로 게시한다(편집된 본문을 그대로 받는다). */
  reviewPost: 'review:post',
  /** 안 달기로 한 지적을 목록에서 버린다. */
  reviewDismiss: 'review:dismiss',
  /** 리뷰를 닫고 리뷰용 워크트리를 정리한다. */
  reviewClose: 'review:close',
  /** 리뷰 화면 진입 시 사이드카(diff·지적·활동)를 읽어온다. */
  reviewLoad: 'review:load',
  /** 워크트리는 지우고 결과·ref 는 남긴다(되살리기 가능). */
  reviewArchive: 'review:archive',
  /** 아카이브된 리뷰의 워크트리를 다시 만든다. */
  reviewUnarchive: 'review:unarchive',
  /** PR 리뷰를 제출한다(승인/변경 요청/코멘트). */
  reviewSubmit: 'review:submit',
  /** 답글·새 커밋을 한 번 확인한다(렌더러 주도 폴링). */
  reviewPoll: 'review:poll',
  /** 미확인 표시를 끈다. */
  reviewMarkSeen: 'review:markSeen',
  /** 인라인 스레드에 답장한다. */
  reviewReply: 'review:reply',
  /** 앞선 맥락 위에서 추가 지시를 보낸다. */
  reviewFollowUp: 'review:followUp',
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
  /** Codex 로그인 시작. 'chatgpt' 는 브라우저 OAuth, 'apiKey' 는 직접 입력. */
  authCodexLoginStart: 'auth:codexLoginStart',
  /** 진행 중인 Codex 브라우저 로그인을 취소한다(모달 닫기). */
  authCodexLoginCancel: 'auth:codexLoginCancel',
  authCodexLogout: 'auth:codexLogout',
  /** Codex 플랜 사용량(rate limit) 조회. */
  authCodexRateLimits: 'auth:codexRateLimits',

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
  /**
   * 계정 레이트리밋 스냅샷을 즉시 다시 조회한다(상태줄 팝오버의 수동 갱신).
   * 평소 갱신은 턴 종료·주기 폴링이 알아서 하므로, 이건 stale 을 본 사용자가 누르는 탈출구다.
   */
  rateLimitsRefresh: 'ratelimits:refresh',
  // 파일 브라우저 (All files 탭)
  fsList: 'fs:list',
  fsRead: 'fs:read',
  /** 입력창 `@` 자동완성용 파일 검색(git ls-files 기반 퍼지 매칭). */
  fsSearch: 'fs:search',
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
  /** 확인을 새로 트리거하지 않고 마지막으로 방송된 업데이트 상태만 읽는다(렌더러 초기화용). */
  updateGetStatus: 'update:getStatus',
  /** 다운로드된 업데이트를 설치하기 위해 앱을 재시작한다. */
  updateQuitAndInstall: 'update:quitAndInstall',
  // 원격 공지(앱 재배포 없이 상단 배너로 알리는 메시지)
  /** 마지막으로 가져온 공지 목록을 읽는다(렌더러 초기화용 — 새로 받아오지 않는다). */
  noticeGetActive: 'notice:getActive',
  /** 지금 즉시 원격 공지를 다시 가져온다(설정 화면 등에서 수동 확인). */
  noticeRefresh: 'notice:refresh',

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
  /** PR 리뷰 진행 상황·결과 스트림. 트랜스크립트와 분리된 임시 스트림(영속하지 않음). */
  evtReview: 'evt:review',
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
  /** 앱 내부 Codex 로그인 진행 이벤트(브라우저 인증 URL 노출 / 완료). */
  evtCodexLogin: 'evt:codexLogin',
  /**
   * 에이전트 계정 상태가 앱 밖에서 바뀌었다는 신호(예: Codex 의 account/updated).
   * 렌더러가 인증 상태를 다시 읽도록 트리거한다.
   */
  evtAuthChanged: 'evt:authChanged',
  /** 앱 내부 GitHub 로그인 진행 이벤트(one-time 코드·디바이스 URL 노출 / 완료). */
  evtGithubLogin: 'evt:githubLogin',
  /** 자동 업데이트 상태 변화(확인 중/최신/발견/다운로드 진행/준비됨/오류). */
  evtUpdate: 'evt:update',
  /** 원격 공지 목록이 갱신됨(main 이 주기적으로 가져온 결과). */
  evtNotice: 'evt:notice'
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
    /** 읽기 전용 위치(DMG/App Translocation)에서 실행 중 — 자동 설치 불가(확인은 계속한다). */
    | 'blocked'
  /**
   * available/ready 일 때 새 버전.
   * blocked 일 때도 채워질 수 있다 — 설치는 못 해도 새 릴리스 존재 여부는 확인하기 때문.
   * 이 경우 version 이 있으면 "수동으로 내려받을 새 버전이 있다"는 뜻이다.
   */
  version?: string
  /** downloading 일 때 0~100. */
  percent?: number
  /** error/blocked 일 때 메시지. */
  error?: string
}

/** 공지의 심각도. 배너 색과 아이콘을 고른다. */
export type NoticeLevel = 'info' | 'warn' | 'critical'

/**
 * 원격 공지 한 건(main → renderer, evtNotice 페이로드의 원소).
 *
 * 앱 버전과 무관하게 띄우기 위해 원격 JSON 에서 가져오므로, 필드는 **모두 방어적으로 파싱**된다
 * (`parseNotices` 참고). 여기 도달한 값은 이미 검증·정규화가 끝난 것만 담긴다.
 */
export interface AppNotice {
  /** 공지 식별자. 사용자가 닫은 기록은 이 id 로 기억되므로 **한 번 쓴 id 는 재사용하지 않는다**. */
  id: string
  level: NoticeLevel
  /** 배너에 그대로 보이는 한 줄 메시지(플레인 텍스트). */
  message: string
  /** 오른쪽에 붙는 링크 버튼. 외부 브라우저로 열린다(http/https 만 허용). */
  link?: { label: string; url: string }
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
  /**
   * 이 워크스페이스를 구동할 에이전트. 생성 시 한 번 정해져 세션 내내 고정된다.
   * 생략하면 전역 기본 백엔드(AppSettings.defaultAgentBackend)를 쓴다.
   */
  agentBackend?: AgentBackendId
}

// ── 외부 연동 인증 상태 (에이전트들 / GitHub) ────────────────────────────

/**
 * 에이전트 백엔드 1개의 CLI 설치·로그인 상태. Claude Code 와 Codex 가 같은 모양을 쓴다 —
 * 통합 패널·온보딩이 백엔드를 몰라도 같은 행을 그릴 수 있게 하기 위함이다.
 */
export interface AgentAuthStatus {
  /** CLI(`claude` / `codex`)가 PATH 에 설치돼 있는지. 미설치면 loggedIn 도 항상 false. */
  installed: boolean
  loggedIn: boolean
  /** 감지된 CLI 버전(예: "0.146.0"). 최소 버전 미달 안내에 쓴다. */
  version?: string
  email?: string
  /** 조직/워크스페이스 이름(Claude 의 orgName). */
  orgName?: string
  /** 구독/플랜 종류(Claude 의 subscriptionType, Codex 의 planType). */
  planType?: string
  /** 인증 방식(Claude 의 authMethod, Codex 의 chatgpt / apiKey 등). */
  authMethod?: string
  /**
   * 에이전트 프로세스 환경에 API 키가 설정돼 있는지
   * (Claude: ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN). 있으면 계정 로그인과 무관하게 그 키로
   * 인증·과금하므로, 패널이 이 불일치를 알려 "로그아웃했는데 왜 계속 되지 / 왜 구독이 아니라
   * API 과금이지" 혼선을 막는다.
   */
  apiKeyInEnv?: boolean
  /** 상태 조회가 실패한 이유(설치는 됐지만 CLI 가 오류를 낸 경우 등). */
  error?: string
}

/** @deprecated `AgentAuthStatus` 로 통합됨. 기존 참조 호환을 위한 별칭. */
export type ClaudeAuthStatus = AgentAuthStatus

export interface GithubAuthStatus {
  /** `gh` CLI 가 PATH 에 설치돼 있는지. 미설치면 loggedIn 도 항상 false. */
  installed: boolean
  loggedIn: boolean
  account?: string
  protocol?: string
}

export interface AuthStatus {
  /**
   * 백엔드별 에이전트 인증 상태. 등록된 백엔드 전부에 대해 채워진다.
   * 온보딩은 "이 중 하나라도 loggedIn" 이면 통과시킨다 — Claude 만, 또는 Codex 만 가진
   * 사용자도 앱을 쓸 수 있어야 하기 때문이다.
   */
  agents: Record<AgentBackendId, AgentAuthStatus>
  github: GithubAuthStatus
}

/** 에이전트 하나라도 로그인돼 있는지(온보딩·빈 상태 게이트의 단일 판단 함수). */
export function hasAnyAgent(status: AuthStatus | null): boolean {
  if (!status) return false
  return Object.values(status.agents).some((a) => a.installed && a.loggedIn)
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

/**
 * "session limit"(5시간 창)의 label. main 의 mapUsage 가 붙이고 renderer 가 이 창을 골라내는 데 쓴다.
 * 양쪽이 어긋나면 세션 리셋 카운트다운이 조용히 사라지므로 SSOT 로 둔다.
 */
export const SESSION_RATE_LIMIT_LABEL = '5-hour'

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
  /**
   * 요금제 한도를 넘겼을 때 쓰는 추가 크레딧 풀. rateLimits 와 달리 "창"이 아니라 월 단위 지갑이라
   * 최대 사용률 롤업(Plan usage 타일)에 섞이면 안 되므로 별도 필드로 둔다. 없으면 null.
   */
  extraUsage: {
    /** 0–100 사용률. */
    utilization: number | null
    /** 사용한 크레딧(최소 단위, 예: 센트). */
    usedCredits: number | null
    /** 월 한도(최소 단위). */
    monthlyLimit: number | null
    currency: string | null
    /** 꺼져 있으면(크레딧 소진·사용자 비활성화) 한도를 넘겨도 실제로 쓰이지 않는다. */
    isEnabled: boolean
  } | null
}

/**
 * 레이트리밋 사용률이 이 값을 넘으면 상태줄을 경고색으로 바꾼다(%).
 * 병렬 세션이 한도를 태우는 속도를 생각하면, 다 쓴 뒤가 아니라 여유가 남았을 때 알려야 의미가 있다.
 */
export const RATE_LIMIT_WARN_THRESHOLD = 80

/**
 * 스냅샷이 이 시간보다 오래되면 stale 로 본다(흐리게 + "N분 전" tooltip).
 * 폴링 간격(5분)보다 넉넉히 잡아, 조회가 한두 번 실패했다고 곧바로 stale 로 보이지 않게 한다.
 */
export const RATE_LIMIT_STALE_AFTER_MS = 12 * 60_000

/**
 * backend 계정 하나의 레이트리밋 스냅샷. **워크스페이스 단위가 아니다** — backend별 계정에
 * 하나뿐인 값이며 AppState.rateLimitsByAgent에서 Claude/Codex를 분리해 보관한다.
 *
 * AppState 에 두는 덕에 (1) 재시작 후에도 마지막 값이 남아 상태줄이 즉시 무언가를 보여줄 수 있고
 * (2) 이미 있는 evtState 방송을 그대로 타므로 전용 이벤트 채널이 필요 없다.
 */
export interface RateLimitSnapshot {
  /** 조회에 성공한 시각(epoch ms). stale 판정과 "N분 전" 표시에 쓴다. */
  fetchedAt: number
  /**
   * 요금제 한도가 적용되지 않는 세션(API 키 등)이면 false — 이때 UI 는 0%/N/A 가 아니라 **완전히 숨긴다**.
   * "아직 한 번도 못 받음"(snapshot 자체가 null)과 구분하려고 값으로 들고 있는다.
   */
  available: boolean
  /** 'pro'/'max'/'team'/'enterprise' 또는 API 키 세션이면 null. */
  subscriptionType: string | null
  /** 5시간·7일·Opus·Sonnet 창(UsageInfo.rateLimits 와 같은 모양). */
  windows: { label: string; utilization: number | null; resetsAt: string | null }[]
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

/** 입력창 `@` 자동완성 후보(worktree 상대 경로). */
export interface FileHit {
  path: string
  isDir: boolean
  /** 파일 크기(바이트). 디렉토리이거나 stat 실패 시 없음. */
  size?: number
}

/**
 * `@파일` 첨부 크기 안내 기준.
 *
 * Claude Code CLI 는 @멘션을 "Read 툴을 이미 호출한 것처럼" 위조해 대화에 끼워 넣는데,
 * 파일이 크면 앞부분 2000줄로 자르고(모델에게는 "잘렸다고 사용자에게 말하지 말라"고 지시한다),
 * 더 크면 아무 말 없이 통째로 버린다. 둘 다 사용자에게는 보이지 않으므로 GUI 가 대신 알린다.
 *
 * 실측(v2.1.197)으로는 32KB·48KB 는 들어오고(48KB 는 잘림) 60KB 이상은 버려지는 경우가 있었지만
 * 경계가 내용에 따라 흔들렸다. CLI 버전마다 달라지는 값이라 정확한 임계값으로 믿지 말고,
 * "이쯤부터 온전히 안 들어갈 수 있다"는 힌트로만 쓴다.
 */
export const MENTION_TRUNCATE_HINT_BYTES = 40 * 1024
export const MENTION_DROP_HINT_BYTES = 256 * 1024

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

/** Codex 로그인 방식. ChatGPT 구독은 브라우저 OAuth, 그 외는 OpenAI API 키 직접 입력. */
export type CodexLoginMethod = 'chatgpt' | 'apiKey'

/**
 * 앱 내부 Codex 로그인 진행 이벤트.
 *
 * Claude·GitHub 과 달리 코드를 받아 되돌려 줄 필요가 없다 — codex app-server 가 OAuth 콜백
 * 서버까지 직접 호스팅하므로, 우리는 URL 을 열어 주고 완료를 기다리기만 하면 된다.
 * - awaiting-browser: 브라우저에서 인증 중. url 은 브라우저가 안 열렸을 때의 폴백 링크.
 * - done: 종료됨. success 면 성공, 아니면 error 에 사유.
 */
export type CodexLoginEvent =
  { phase: 'awaiting-browser'; url: string } | { phase: 'done'; success: boolean; error?: string }

/** ChatGPT 플랜 사용량 창 하나(5시간·주간 등). */
export interface RateLimitWindow {
  /** 이 창에서 쓴 비율(0~100). */
  usedPercent?: number
  /** 창 길이(분). */
  windowDurationMins?: number
  /** 다음 초기화 시각(Unix 초). */
  resetsAt?: number
}

/**
 * 에이전트 플랜의 사용량 스냅샷. 현재는 Codex(ChatGPT 플랜)만 채우지만 모양은 일반적이다 —
 * API 키로 인증했거나 조회 불가면 null 이 온다.
 */
export interface AgentRateLimits {
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  rateLimitReachedType?: string | null
}

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
