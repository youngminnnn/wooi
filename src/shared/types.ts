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
 * - Codex: askForApproval → default(Approve for me) → fullAccess
 *
 * `default`는 두 백엔드가 공유하는 저장 식별자지만 표시 이름과 의미는 다르다. `readOnly`는
 * 이전 Codex 저장값 호환용으로 유니온에만 남아 있고, 현재 Codex에서는 기본 모드로 보정된다.
 */
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'readOnly' | 'askForApproval' | 'fullAccess'

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

/**
 * 아카이브 스크립트가 실패했을 때의 결과. 실패해도 아카이브·삭제는 그대로 진행되므로
 * (worktree 는 이미 사라진다) 사용자가 알 방법은 이것뿐이다 — main 이 IPC 반환값에 실어
 * 보내고 렌더러가 토스트로 띄운다. 전문은 main 로그에도 남는다.
 */
export interface ArchiveScriptFailure {
  /** 실패한 명령(리포 설정의 archive script). */
  command: string
  /** 종료 코드. 시작 실패·타임아웃이면 null. */
  code: number | null
  /** 타임아웃으로 강제 종료했는지. */
  timedOut: boolean
  /** stdout·stderr 를 합친 출력의 꼬리. */
  output: string
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
  /** 사용자가 등록한 장수명 명령(dev 서버·watcher·storybook 등). */
  runScripts: RunScript[]
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
 * 모델 A(부모-자식 워크스페이스) 스택에서 이 워크스페이스가 속한 연결 요소를 뿌리부터 모은다.
 * 뿌리까지 올라간 뒤 DFS 로 내려오므로 형제 가지도 함께 들어온다(스택 팝오버가 보는 것과 같은 집합).
 *
 * 스택 팝오버와 스택 리뷰가 **같은 함수**를 봐야 한다 — 화면이 보여 준 스택과 리뷰가 읽는 스택이
 * 다르면, 사용자가 고른 것과 리뷰가 도는 것이 어긋난다.
 */
export function workspaceStackMembers<T extends { id: string; parentWorkspaceId: string | null }>(
  all: T[],
  id: string
): T[] {
  const byId = new Map(all.map((w) => [w.id, w]))
  let root = byId.get(id)
  if (!root) return []
  const guard = new Set<string>()
  while (root.parentWorkspaceId && byId.has(root.parentWorkspaceId) && !guard.has(root.id)) {
    guard.add(root.id)
    root = byId.get(root.parentWorkspaceId)!
  }
  const out: T[] = []
  // 내려올 때도 방문 표시가 필요하다. 위로 올라가는 루프만 순환을 막으면, A→B→A 같은 고리에서
  // 자식을 따라 내려오다 무한 재귀로 죽는다(orderByStack 이 같은 이유로 seen 을 든다).
  const seen = new Set<string>()
  const collect = (wid: string): void => {
    const w = byId.get(wid)
    if (!w || seen.has(wid)) return
    seen.add(wid)
    out.push(w)
    for (const c of all) if (c.parentWorkspaceId === wid) collect(c.id)
  }
  collect(root.id)
  return out
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
 * ⌘1–9 번호 배지·⌘1–9 선택·⌘↑ / ⌘↓ 순환이 모두 이 함수 하나를 공유해야 한다.
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

/** `unknown` 항목의 id. 같은 종류를 대화당 한 장으로 합치는 키다(백엔드의 dedupe 기준과 동일). */
export function unknownItemId(backend: AgentBackendId, what: string): string {
  return `unknown:${backend}:${what}`
}

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
  /**
   * 이 백엔드가 **메인일 때** 다른 종류의 에이전트에게 작업을 위임할 수 있는지.
   *
   * 위임 도구는 MCP 로 주입하는데, 그 배관이 백엔드마다 다르다 — Claude 는 SDK 의 in-process
   * 서버를 그대로 꽂을 수 있지만, Codex 는 app-server 스레드에 MCP 설정을 주입하는 별도 경로가
   * 필요하다. 그래서 이 값이 false 인 백엔드에서는 위임을 **UI 에서 아예 제안하지 않는다** —
   * 켤 수는 있는데 아무 일도 안 일어나는 스위치가 제일 나쁘다.
   *
   * 위임 **대상**이 되는 것과는 무관하다. Codex 는 대상이 될 수 있고(`codex exec` 로 돌린다),
   * 이 값은 "조율하는 쪽이 될 수 있는가"만 말한다.
   */
  delegate: boolean
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
  /**
   * "알아서 진행해라" 에 해당하는 모드. 없으면 null.
   *
   * **식별자가 백엔드마다 다르기 때문에** 필요하다 — Claude 는 `auto`(분류기가 승인/거절을
   * 대신한다)이지만 Codex 의 같은 자리는 `default`(라벨은 "Auto")다. 그리고 Claude 의
   * `default` 는 정반대로 "매번 묻는" 모드다. 그래서 `permissionMode === 'auto'` 같은 문자열
   * 비교로 판단하면 Codex 에서는 늘 빗나가고, `'default'` 로 판단하면 Claude 에서 가장
   * 보수적인 모드를 자동 모드로 오해한다.
   *
   * `fullAccess` 와는 다르다 — 그쪽은 승인이 아예 없는 반면, 이 모드는 샌드박스나 분류기가
   * 남아 있다. 승인 카드를 생략할지 결정하는 쪽에서 둘을 따로 물어야 하는 이유다.
   */
  autonomousPermissionMode: PermissionMode | null
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
  /**
   * 멀티 에이전트 워크스페이스인가. 없거나 false 면 **기존 단일 에이전트 워크스페이스**다.
   *
   * 켜져 있으면 메인 에이전트(`agentBackend`)가 대화 중에 **자연어로** 다른 종류의 에이전트를
   * 서브에이전트로 띄울 수 있다. 어떤 종류를 쓸지 미리 고르지 않는 것이 요점이다 — 모드가
   * 켜져 있으면 등록된 모든 에이전트가 대상이고, 선택은 대화에서 일어난다.
   *
   * 옵셔널로 두는 것도 요점이다 — 저장된 워크스페이스는 이 필드가 없으므로 마이그레이션 없이
   * 전부 단일 모드로 읽히고, `agentBackend` 의 의미("이 워크스페이스의 메인 백엔드")도 그대로다.
   */
  multiAgent?: boolean
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
   * 이 워크스페이스를 만든 **에이전트의 워크스페이스** id. 사람이 UI 에서 만들었으면 null.
   *
   * parentWorkspaceId 와 헷갈리기 쉽지만 묻는 것이 다르다 — 저쪽은 "어느 브랜치 위에 쌓였는가"
   * (git 관계)이고, 이쪽은 "누가 만들었는가"(권한 관계)다. 스택이면 보통 둘이 같지만, 에이전트가
   * 독립 워크스페이스를 만들면 부모는 null 인 채 생성자만 남고, 사람이 스택을 만들면 그 반대다.
   *
   * 대상을 인자로 받는 도구가 "남의 것에 손대지 못한다" 를 판정하는 근거가 이 필드다
   * ([[agent/tools/target]]). 부모 관계로 대신 판정하면 사람이 만든 워크스페이스까지 에이전트가
   * 지울 수 있게 된다.
   */
  createdByWorkspaceId: string | null
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
   * PR 이 병합돼 이 워크스페이스가 사실상 끝났을 때의 정리 제안(감지만 — 아카이브는 사용자 승인 후).
   * 없으면 null. 해소되면(아카이브했거나 사용자가 해제했으면) 지워진다.
   */
  archiveSuggest?: ArchiveSuggestion | null
  /**
   * 사용자가 해제한 제안의 병합 브랜치. 같은 병합으로 배너가 다시 뜨는 것을 막는다.
   * 브랜치명을 기억하는 이유는 stackSyncDismissed 와 같다 — 그 뒤에 다른 브랜치가 병합되면
   * 그건 새로운 사실이므로 다시 알려야 한다.
   */
  archiveSuggestDismissed?: string | null
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
  /**
   * 이 워크스페이스의 PR 이 속한 **GitHub 스택** 번호(GitHub 이 서버에 들고 있는 stacked PR
   * 객체). 세 필드 모두 옵셔널이고 폴백 경로에서는 아예 없다 — Wooi 의 체인은 여전히
   * parentWorkspaceId / ws.stack 이 소유하고, 이 값들은 그 위에 얹히는 메타데이터일 뿐이다.
   * GitHub 이 스택을 모르면(= base 로만 연결된 오늘의 Wooi PR 들) 전부 null 로 남는다.
   */
  ghStackNumber?: number | null
  /** 그 스택 안에서의 1-기반 위치(1 이 base 에 가장 가깝다). GitHub 이 보고한 값 그대로. */
  ghStackPosition?: number | null
  /** 위 두 값을 GitHub 과 마지막으로 맞춘 시각. 값이 낡았는지 판단할 유일한 근거다. */
  ghStackSyncedAt?: number | null
  /**
   * 이 워크스페이스가 부모에게 올린 마지막 인계 보고(`report_to_parent`). 없으면 아직 보고 전.
   * 스택 뿌리(parentWorkspaceId 가 null)에는 채워지지 않는다.
   */
  handoff?: StackedHandoff | null
  /**
   * 다른 워크스페이스에서 온 메시지를 받는 방식([[PeerInboundPolicy]]). 없으면 `accept`.
   *
   * 옵셔널로 두는 것이 요점이다 — 저장된 워크스페이스는 이 필드가 없으므로 마이그레이션 없이
   * 전부 앱 안의 협업에 맞춘 기본값(`accept`)으로 읽힌다. 앱 바깥 Claude Code 세션에는 이
   * 폴백을 적용하지 않는다([[nativePeerInbound]]).
   */
  peerInbound?: PeerInboundPolicy
  /**
   * 승인을 기다리는 peer 메시지(`hold` 로 받아 둔 것). 없거나 비어 있으면 대기 중인 것이 없다.
   *
   * 발신자가 아니라 **수신자에게** 쌓는 이유는 handoff 를 자식 레코드에 두는 것과 같다 —
   * 사용자가 이 워크스페이스를 열었을 때 답해야 하는 질문이 "나에게 온 것이 있나" 이고,
   * 워크스페이스가 사라지면 그 앞으로 온 메시지도 함께 사라지는 것이 맞다.
   */
  peerInbox?: PendingPeerMessage[]
  /** worktree 절대 경로 */
  worktreePath: string
  /**
   * 이 workspace 전용 dev 서버 포트. 병렬로 여러 workspace 의 dev 스크립트를 띄울 때
   * 같은 기본 포트(3000/5173 등)를 다투지 않도록, 생성 시 고유 포트를 배정한다.
   * setup/dev 스크립트에 `$PORT`·`$WOOI_DEV_PORT` 환경변수로 주입된다.
   * 레거시 workspace(배정 전)는 null 일 수 있으며, dev 실행 시 lazy 하게 배정·영속된다.
   */
  /** run script id 별로 예약한 포트. */
  ports: Record<string, number>
  /**
   * Preview 탭이 마지막으로 보고 있던 주소(영속). 없거나 null 이면 아직 아무것도 열지 않았다.
   *
   * 워크스페이스에 매다는 이유는 수명이 같아서다 — dev 서버 주소는 이 worktree 의 성질이고,
   * 워크스페이스를 지우면 함께 사라져야 한다(설정에 모아 두면 죽은 항목이 쌓인다).
   * 옵셔널이라 저장된 워크스페이스는 마이그레이션 없이 그대로 읽힌다.
   */
  previewUrl?: string | null
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
  /** 계정 사용량 제한이 풀린 뒤 같은 대화를 자동으로 이어가기 위한 영속 예약. */
  pendingRateLimitResume?: PendingRateLimitResume | null
  /** 마지막 턴이 사용량 제한으로 멈췄다는 표시(자동 이어가기 설정과 무관하게 기록·표시한다). */
  rateLimited?: RateLimitPause | null
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
  /**
   * 에이전트를 바꾸면서 아직 넘기지 못한 인수인계 예약 — 값은 **넘겨주는 쪽** 에이전트의 표시
   * 이름이다([[shared/handoff]]). 다음 사용자 메시지 앞에 지난 대화가 붙어 나가고 그때 지워진다
   * ([[agent/orchestrator]] 의 takeHandoffPrefix).
   *
   * 프롬프트 자체를 담지 않는 것이 요점이다. 그 텍스트는 수만 자라 설정 파일이 그만큼 커지는데,
   * 넘길 내용은 어차피 트랜스크립트에 그대로 있어 보낼 때 다시 만들면 된다.
   */
  pendingHandoffFrom?: string | null
  /** 아카이브되면 사이드바 기본 목록에서 숨기고 worktree 를 제거한다(브랜치·기록은 유지). */
  archived: boolean
  /** 이 워크스페이스의 모든 알림(OS 알림·소리·Dock 배지)을 음소거한다. 레거시는 undefined=false. */
  muted?: boolean
  /**
   * 우하단 터미널의 탭 목록(각 탭 = 독립 PTY). 없거나 비어 있으면 첫 조회 때 탭 하나를 만들어
   * 채운다 — 레거시 워크스페이스는 마이그레이션 없이 "탭 1개" 로 읽힌다.
   *
   * 셸 세션 자체는 영속하지 않는다(PTY 는 프로세스 수명). 앱을 다시 켜면 이 목록(개수·이름)만
   * 복원되고 셸은 새로 뜬다.
   */
  terminalTabs?: TerminalTab[]
  /** 마지막으로 보고 있던 터미널 탭. terminalTabs 에 없는 값이면 첫 탭으로 되돌린다. */
  activeTerminalTabId?: string
  createdAt: number
  lastActiveAt: number
}

/**
 * 이 워크스페이스의 메인 에이전트를 지금 바꿀 수 있는가.
 *
 * 대화 도중이라도 바꿀 수 있다 — 에이전트가 잘못 걸린 걸 알아채는 시점은 대개 몇 턴 돌려 본
 * 뒤이고, 그때 "새 워크스페이스를 만들어 처음부터"만 남겨 두면 브랜치·워크트리·작업 중인 변경까지
 * 다 옮겨야 한다. 맥락은 지난 대화를 새 세션에 다시 말해 주는 것으로 잇는다
 * ([[shared/handoff]]) — 다만 그 한 번이 통째로 입력 토큰이라, [[agentSwitchNeedsHandoff]] 가
 * 그 구간을 가려 사용량 경고를 띄운다.
 *
 * 막는 경우는 둘뿐이다. 턴이 도는 중에 바꾸면 지금 답하고 있는 세션을 발밑에서 치우게 되고,
 * 아카이브된 워크스페이스는 애초에 대화 대상이 아니다.
 *
 * 규칙을 여기(shared)에 두는 이유는 렌더러와 main 이 같은 답을 내야 하기 때문이다. 렌더러는 이
 * 값으로 선택 UI 를 잠글지 정하고, main 은 같은 값으로 요청을 거절한다.
 */
export function canSwitchAgentBackend(workspace: Pick<Workspace, 'archived' | 'status'>): boolean {
  return !workspace.archived && workspace.status !== 'running'
}

/**
 * 지금 에이전트를 바꾸면 맥락을 넘겨야 하는가(= 사용량이 드는 구간인가).
 *
 * 백엔드끼리 세션을 물려줄 방법은 없으므로(Claude 의 sessionId 로 Codex 를 resume 할 수 없다)
 * 맥락은 지난 대화를 새 세션에 통째로 다시 말해 주는 것으로만 넘어간다([[shared/handoff]]).
 * 그 한 번이 그대로 입력 토큰이라 대화가 길수록 비싸다 — 그래서 이 구간에서는 사용자에게 먼저
 * 물어보고([[Composer]] 의 확인 대화상자), main 도 확인받지 않은 요청은 거절한다([[ipc]]).
 *
 * `messageCount` 는 이 워크스페이스의 트랜스크립트 항목 수다(main 은 기록 파일, 렌더러는 불러온
 * 기록에서 읽는다). sessionId 만으로는 부족하다 — 유휴 세션이 정리된 워크스페이스에도 sessionId
 * 는 resume 용으로 남아 있고([[agent/orchestrator]]), 반대로 /clear 로 비운 워크스페이스는
 * sessionId 가 없어도 대화가 있었던 곳이라 트랜스크립트로 함께 판정해야 한다.
 */
export function agentSwitchNeedsHandoff(
  workspace: Pick<Workspace, 'sessionId'>,
  messageCount: number
): boolean {
  return workspace.sessionId !== null || messageCount > 0
}

/**
 * 약관·개인정보처리방침의 현재 버전. 문서를 사용자 권리에 영향을 주도록 개정하면 1 올린다.
 * settings.acceptedTermsVersion 이 이 값과 다르면 온보딩에서 재동의를 요구한다.
 */
/** 원격 접근 동의 버전. 데이터 흐름이 실질적으로 바뀌면 올려서 다시 묻는다. */
export const CURRENT_REMOTE_CONSENT_VERSION = 1

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
  /** Claude 가 과부하·일시 불가일 때 순서대로 시도할 모델 ID. 다른 백엔드는 사용하지 않는다. */
  fallbackModels: string[]
  /** 새 워크스페이스의 기본 권한 모드. null 이면 백엔드의 defaultPermissionMode. */
  permissionMode: PermissionMode | null
}

/** 백엔드별 기본값의 초기 상태(모두 "백엔드 기본을 따름"). */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  model: null,
  effort: null,
  permissionMode: null,
  fastMode: false,
  fallbackModels: []
}

/**
 * 백엔드 하나의 전역 기본값을 꺼낸다. 저장된 설정에 해당 백엔드 항목이 없어도(구버전에서
 * 마이그레이션됐거나 백엔드가 나중에 추가됨) 안전한 기본값을 돌려준다.
 */
export function agentSettingsFor(settings: AppSettings, id: AgentBackendId): AgentSettings {
  return { ...DEFAULT_AGENT_SETTINGS, ...settings.agents?.[id] }
}

// ── MCP 서버 (Wooi 스코프) ────────────────────────────────────────────────
//
// 사용자가 `claude` CLI 로 등록한 서버는 ~/.claude.json 에 있고, Wooi 는 그 파일을 **읽기만**
// 한다 — 다른 도구(CLI·다른 GUI)와 소유권이 겹치는 파일을 앱이 고쳐 쓰면, 한쪽의 편집이 다른
// 쪽의 포맷·주석·병합 규칙을 조용히 뭉갠다. 대신 Wooi 는 자기 설정 파일(wooi.json)에 자체
// 목록을 두고, 세션을 열 때 승계 목록과 합쳐 주입한다([[main/claude/mcp]]).

/** Wooi 스코프 MCP 서버 1개의 전송 방식별 접속 정보. */
export type WooiMcpTransport =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http' | 'sse'; url: string; headers: Record<string, string> }

/** 설정 화면에서 사용자가 직접 만드는 Wooi 스코프 MCP 서버. */
export type WooiMcpServer = {
  /** 목록 안에서만 쓰는 안정 키(이름을 바꿔도 행이 갈리지 않게). */
  id: string
  /** 에이전트에게 노출되는 서버 이름. 도구 이름 접두사가 되므로 공백 없이 짧게. */
  name: string
  /** false 면 세션에 주입하지 않는다(설정은 그대로 남는다). */
  enabled: boolean
} & WooiMcpTransport

/** MCP 관련 앱 설정 묶음. */
export interface McpSettings {
  /** Wooi 가 소유·편집하는 서버 목록. */
  servers: WooiMcpServer[]
  /**
   * 주입에서 빼 둘 ~/.claude.json 승계 서버의 **이름**. 그 파일은 우리가 고치지 않으므로,
   * "끄기" 는 파일이 아니라 우리 쪽 제외 목록으로 표현한다.
   */
  disabledInherited: string[]
}

/**
 * MCP 서버 이름 규칙. 이름은 에이전트에게 노출되는 도구 이름의 접두사이자 Codex 설정의 TOML
 * 점 표기 키로 그대로 들어가므로, 공백·점·따옴표를 허용하면 조용한 오작동이나 파싱 오류가 된다.
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_PATTERN.test(name.trim())
}

/**
 * MCP 설정을 꺼낸다. 항목이 통째로 없거나(이 기능 이전 버전에서 올라옴) 일부만 저장된
 * 파일에서도 안전한 빈 목록을 돌려준다 — 설정 하나가 비었다고 세션 생성이 막히면 안 된다.
 */
export function mcpSettingsOf(settings: AppSettings | null | undefined): McpSettings {
  return {
    servers: settings?.mcp?.servers ?? [],
    disabledInherited: settings?.mcp?.disabledInherited ?? []
  }
}

/** 목록에서 서버 1개의 출처를 나타내는 배지. */
export type McpServerOrigin = 'user' | 'project' | 'wooi'

/** ~/.claude.json 에서 읽어 온 서버 1개(표시 전용 — 편집은 그 파일에서 한다). */
export interface InheritedMcpServer {
  name: string
  /** 'user' = 파일 최상위 mcpServers, 'project' = projects[<경로>].mcpServers. */
  origin: 'user' | 'project'
  /** project 스코프일 때 그 항목이 걸려 있는 리포 경로. */
  projectPath?: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  /** stdio 면 실행 명령줄, http/sse 면 엔드포인트 URL. 알 수 없으면 빈 문자열. */
  detail: string
}

/**
 * codex 설정의 `mcp_servers` 테이블 한 항목(stdio 전용) — Wooi 가 주입하는 쪽의 모양.
 *
 * 이 타입과 아래 env 이름이 **shared 에 있는 이유**가 있다. 값을 만드는 쪽은 메인
 * (main/mcpSettings.ts, 설정 store 를 읽는다)이고 쓰는 쪽은 codex-host(유틸리티 프로세스,
 * main/codex/appServer.ts)인데, 호스트가 메인 쪽 모듈을 **값으로** import 하면 번들이
 * store → `import { app } from 'electron'` 까지 끌고 들어가 로드 시점에 죽는다. 그래서 둘의
 * 접점만 electron 을 모르는 이 파일에 둔다.
 */
export interface CodexStdioServer {
  command: string
  args: string[]
  env: Record<string, string>
}

/** codex-host fork 에 실리는 env 변수 이름. 값은 CodexStdioServer 테이블의 JSON. */
export const CODEX_MCP_SERVERS_ENV = 'WOOI_MCP_SERVERS'

/**
 * `~/.codex/config.toml` 의 MCP 서버 1개.
 *
 * Codex 는 자기 설정 파일을 스스로 읽으므로 Claude 쪽처럼 "우리 목록에서 빼기" 로 끌 수 없다 —
 * 유일한 off 스위치가 그 파일의 `enabled` 다. 그래서 이 항목의 토글만은 사용자 파일에 직접
 * 쓴다(app-server 의 config/value/write). 목록도 파일을 파싱하지 않고 app-server 에 물어본다.
 */
export interface CodexMcpServer {
  name: string
  /** codex 가 실제로 띄우는 명령줄(표시용). */
  detail: string
  /** config.toml 의 `enabled`. 값이 없으면 켜진 것으로 본다 — codex 기본값이 그렇다. */
  enabled: boolean
  /** app-server 런타임이 보고한 인증 상태. unknown 은 판정 전/불가이며 로그인이 필요하다는 뜻이 아니다. */
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
}

/**
 * Codex Agent Plugin 하나(설정 화면 표시용으로 추린 것).
 *
 * app-server 의 `PluginSummary` 를 그대로 넘기지 않는다 — 그쪽은 로고 URL·스크린샷·공유 맥락까지
 * 30개 남짓한 필드가 달려 있고, 대부분 우리가 그리지 않는다. 화면이 읽는 것만 남겨야 codex 버전이
 * 올라 필드가 바뀌어도 [[codex/plugins]] 한 곳만 고치면 된다.
 */
export interface CodexPlugin {
  /** `<name>@<marketplace>`. 목록의 키이자 uninstall 이 받는 식별자다. */
  id: string
  /** 마켓플레이스 안에서의 이름. 스킬 접두사(`supabase:supabase`)가 이 이름이다. */
  name: string
  /** 사람이 읽는 이름. 없으면 name 을 쓴다. */
  displayName: string
  /** 한 줄 소개(없을 수 있다). */
  description: string
  /** 로컬에 풀린 버전 우선, 없으면 카탈로그가 말하는 버전. */
  version: string | null
  enabled: boolean
  /** 'local' | 'git' | 'npm' | 'remote' | 'unknown' */
  source: string
  /** 그 출처의 한 줄 표시(경로·git URL·npm 패키지). 원격 카탈로그는 빈 문자열. */
  sourceDetail: string
  /** 지금 쓸 수 있는가. false 면 reason 이 이유를 말한다. */
  available: boolean
  /** 쓸 수 없는 이유(사람이 읽는 문장). available 이면 null. */
  unavailableReason: string | null
}

/** 마켓플레이스 1개와 거기서 온 플러그인들. */
export interface CodexPluginMarketplace {
  name: string
  /** 사람이 읽는 이름. 없으면 name. */
  displayName: string
  /** 로컬 파일 경로. 원격 전용 카탈로그는 null 이다(경로가 없다). */
  path: string | null
  plugins: CodexPlugin[]
}

/** 설정 화면이 "이 Codex 에 무엇이 깔려 있는가" 를 그리기 위해 필요한 전부. */
export interface CodexPluginInventory {
  /**
   * 설치된 codex 가 `plugin/*` 를 아는가. 모르면 목록이 비는 것과 구분해야 한다 —
   * "플러그인이 없다" 와 "이 버전은 플러그인을 모른다" 는 사용자가 할 일이 다르다.
   */
  supported: boolean
  marketplaces: CodexPluginMarketplace[]
  /** 읽지 못한 마켓플레이스. 조용히 빠지면 왜 안 보이는지 화면에서 알 수 없다. */
  loadErrors: { path: string; message: string }[]
}

/** 플러그인 하나가 실제로 싣고 있는 것(`plugin/read`). 목록 행을 펼쳤을 때 채운다. */
export interface CodexPluginDetail {
  /** 목록의 한 줄 소개보다 긴 설명. 없으면 빈 문자열. */
  description: string
  /** 이 플러그인이 붙여 주는 스킬. 이름은 composer 의 `/이름` 과 같다. */
  skills: { name: string; description: string; enabled: boolean }[]
  /** 이 플러그인이 딸려 오게 하는 MCP 서버 이름들. */
  mcpServers: string[]
  hooks: { key: string; eventName: string }[]
  /** ChatGPT 커넥터(앱). 설치 URL 이 있으면 함께 준다. */
  apps: { id: string; name: string; description: string }[]
  scheduledTasks: { key: string; name: string }[]
}

/** 목록의 한 행에서 `plugin/read` 를 부르는 데 필요한 좌표. */
export interface CodexPluginRef {
  pluginName: string
  /**
   * 둘 중 **정확히 하나**만 실린다. 로컬 마켓플레이스는 경로로, 원격 카탈로그는 이름으로
   * 지칭하며, 둘 다 보내면 app-server 가 -32600 으로 거절한다(실측).
   */
  marketplacePath: string | null
  marketplaceName: string
}

export interface McpOauthLoginCompletedEvent {
  name: string
  success: boolean
  error?: string
}

/** 설정 화면이 "무엇이 주입되는가" 를 그리기 위해 필요한 전부. */
export interface McpInventory {
  /** 승계 목록의 출처 파일 경로(없어도 "이 파일을 여세요" 안내에 쓴다). */
  configPath: string
  configExists: boolean
  /** ~/.claude.json 의 서버들. Wooi 가 등록한 리포에 걸린 project 항목만 포함한다. */
  inherited: InheritedMcpServer[]
}

export interface AppSettings {
  /** 대화의 도구 로그 외형. 접기·요약 정책은 두 스타일이 공유한다. */
  toolLogStyle: 'wooi' | 'terminal'
  /**
   * 새 워크스페이스가 기본으로 쓸 에이전트 백엔드. 사용자가 두 에이전트를 모두 보유했을 때만
   * 의미가 있으며, 하나뿐이면 그 하나로 자동 해석된다.
   */
  defaultAgentBackend: AgentBackendId
  //
  // 팀으로 시작할지의 전역 기본값은 **두지 않는다**. 팀은 워크스페이스의 종류가 아니라 언제든
  // 켤 수 있는 능력이고, 무엇을 위임할 만한지는 만들기 전이 아니라 대화 중에 드러난다 — 미리
  // 고르게 하는 자리를 만들면 사용자가 가장 모르는 때에 고르게 하는 셈이다. 새 워크스페이스는
  // 언제나 Solo 로 시작하고, 켜는 것은 헤더 배지·사이드바 메뉴·`switch_to_agent_team` 이 맡는다.
  /** 백엔드별 전역 기본값(모델·effort·권한 모드). */
  agents: Record<AgentBackendId, AgentSettings>
  /**
   * MCP 서버 설정(Wooi 스코프 목록 + 승계 서버 제외 목록).
   * 저장된 설정에 없으면(이 기능 이전 버전에서 올라옴) `mcpSettingsOf` 가 빈 목록으로 읽는다.
   */
  mcp?: McpSettings
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
  /** Claude/Codex 계정 사용량 제한이 풀리면 중단된 작업을 같은 세션에서 자동으로 이어간다. */
  autoResumeAfterRateLimit: boolean
  /**
   * restack·캐스케이드가 충돌하면 그 워크트리의 에이전트에게 해결을 맡긴다. **기본 꺼짐.**
   *
   * 꺼져 있어도 충돌 카드의 "Resolve with agent" 버튼은 그대로 있다 — 이 설정은 "버튼을 없애고
   * 자동으로 시작할지"만 정한다. 기본을 끔으로 두는 이유는 토큰이다. 해결 턴 하나는 사용자가
   * 시키지도 않은 턴이고, 그 비용을 기본값으로 떠안기지 않는다.
   */
  autoResolveConflicts: boolean
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
  /**
   * 모바일 컴패니언의 원격 접근을 허용한다. **기본 꺼짐** — 옵트인이며, 꺼져 있으면
   * 릴레이 소켓도 타이머도 만들어지지 않아 네트워크 비용이 0이다.
   *
   * 이 필드가 없던 버전에서 올라온 사용자도 기본값 병합으로 false 가 되므로
   * schemaVersion 을 올리지 않는다(showRunningAgents·pickedDefaults 와 같은 이유).
   */
  remoteEnabled: boolean
  /**
   * 원격 접근 데이터 흐름에 동의한 버전. `null` 이면 아직 동의하지 않았다.
   *
   * 앱 전체 약관(`acceptedTermsVersion`)을 올리지 않는 이유는, 이 기능을 절대 켜지 않을
   * 사용자 전원에게 재동의를 강요하게 되기 때문이다. 동의는 **결정이 실제로 일어나는
   * 자리**, 즉 원격을 켜는 순간에 받는다.
   */
  remoteConsentVersion: number | null
  /**
   * 원격 접근 기능이 열려 있다고 **마지막으로 확인한** 값. 설정이 아니라 캐시다.
   *
   * 플래그는 네트워크로 오므로 기동 직후와 오프라인에서는 알 수 없다. 그때 꺼진 것으로
   * 치면 이미 쓰던 사용자에게서 기능이 사라졌다 나타났다 한다 — 마지막으로 알던 값을
   * 그대로 쓰는 편이 옳다.
   */
  remoteAccessAvailable: boolean
  /** 원격 접근이 켜져 있을 때 휴대폰 푸시 알림도 보낸다. 별도 옵트인이며 기본은 꺼짐이다. */
  remotePushEnabled: boolean
  /**
   * 데스크톱 앱을 쓰고 있는 동안에도 폰으로 푸시를 보낸다. 기본은 꺼짐 — 눈앞의 창이 이미
   * 알려 준 일로 주머니까지 울릴 이유가 없다. 랩탑과 폰을 오가며 쓰는 사람은 켜면 된다.
   *
   * 판정은 `shouldSendRemotePush` 한 곳에 있다(`src/main/remote/push.ts`).
   */
  remotePushWhileActive: boolean
  /**
   * 별도 창으로 분리한 패널(work/scripts)의 마지막 위치·크기.
   *
   * 설정 화면에서 고르는 값이 아니라 창을 닫을 때 기록되는 자리 기억이다 — 듀얼 모니터에서
   * 보조 화면에 옮겨 둔 창이 다음에 열 때도 같은 화면·같은 크기로 뜨게 한다. 저장된 자리가
   * 지금 연결된 디스플레이 밖이면(모니터를 뽑은 뒤) 무시하고 기본 위치로 연다.
   */
  paneWindowBounds?: Partial<Record<PaneKind, WindowBounds>>
}

// ── fan-out (같은 프롬프트를 여러 워크스페이스에 동시에) ────────────────────
//
// 스택(부모-자식)과 **섞이지 않는다**. 스택은 한 작업을 이어 쌓는 수직 관계라 자식의 base 가
// 부모 브랜치지만, fan-out 형제는 같은 질문에 대한 서로 다른 답이라 전부 리포 기본 브랜치에서
// 갈라진다(parentWorkspaceId 는 항상 null). 둘을 한 축으로 합치면 "형제" 라는 말이 두 가지를
// 뜻하게 되고, restack·캐스케이드가 fan-out 형제까지 건드리게 된다.

/** fan-out 으로 만들 수 있는 후보 수의 하한·상한. */
export const FANOUT_MIN_SLOTS = 2
export const FANOUT_MAX_SLOTS = 4

/**
 * 같은 프롬프트로 한꺼번에 만든 워크스페이스 묶음.
 *
 * 멤버십의 단일 출처는 이 `workspaceIds` 다 — 워크스페이스에 groupId 를 같이 심어 두면 둘이
 * 갈라지는 날이 오고, 그때 어느 쪽이 맞는지 판정할 방법이 없다. 역방향 조회는
 * [[fanoutGroupOf]] 가 맡는다(그룹 수는 사람이 만든 만큼이라 선형 조회로 충분하다).
 */
export interface FanoutGroup {
  id: string
  repoId: string
  /** 후보 브랜치들의 공통 뿌리 이름. 화면에서 이 그룹을 부르는 이름이기도 하다. */
  name: string
  /** 모든 후보에게 똑같이 보낸 첫 프롬프트. 비교 화면이 "무엇을 물었는지" 를 다시 보여 준다. */
  prompt: string
  /** 후보 워크스페이스 id(생성 순서 = 표시 순서). 아카이브돼도 목록에는 남는다. */
  workspaceIds: string[]
  /**
   * 채택한 후보. 아직 고르지 않았으면 null. 채택은 "이 그룹의 질문은 끝났다" 는 표시이고,
   * 나머지 형제의 아카이브는 그 결과로 따로 일어난다(이 필드가 아카이브를 뜻하지는 않는다).
   */
  adoptedWorkspaceId: string | null
  createdAt: number
}

/** 이 워크스페이스가 속한 fan-out 그룹(없으면 undefined). */
export function fanoutGroupOf(
  groups: FanoutGroup[] | undefined,
  workspaceId: string
): FanoutGroup | undefined {
  return groups?.find((g) => g.workspaceIds.includes(workspaceId))
}

/**
 * 아직 결론이 나지 않은 그룹만. 채택이 끝난 그룹은 사이드바에서 감춘다 — 남겨 두면 "고를 것이
 * 남아 있다" 는 신호가 영원히 켜져 있게 된다(기록 자체는 비교 화면에서 계속 열어 볼 수 있다).
 */
export function unresolvedFanoutGroups(
  groups: FanoutGroup[] | undefined,
  repoId?: string
): FanoutGroup[] {
  return (groups ?? []).filter(
    (g) => g.adoptedWorkspaceId === null && (repoId === undefined || g.repoId === repoId)
  )
}

/**
 * 후보 i 의 워크스페이스 이름. 뒤에 붙는 번호가 곧 화면에서의 순번이라, 브랜치 이름만 봐도
 * 어느 후보인지 알 수 있다. 실제 브랜치는 main 이 중복을 피해 접미사를 더 붙일 수 있다
 * ([[git]] resolveUniqueWorktree) — 그래도 순번은 이름 안에 남는다.
 */
export function fanoutSlotName(base: string, index: number): string {
  return `${base.trim() || 'fanout'}-${index + 1}`
}

/** fan-out 생성 요청. 슬롯 하나가 후보 하나이며, 슬롯마다 다른 에이전트를 고를 수 있다. */
export interface CreateFanoutArgs {
  repoId: string
  /** 후보 이름의 공통 뿌리. 비어 있으면 main 이 자동 생성한다. */
  name?: string
  /** 모든 후보에게 똑같이 보낼 프롬프트. 비어 있으면 후보들은 유휴 상태로 만들어진다. */
  prompt: string
  /** 후보별 설정. 길이가 곧 후보 수다(FANOUT_MIN_SLOTS ~ FANOUT_MAX_SLOTS). */
  slots: FanoutSlot[]
}

export interface FanoutSlot {
  /** 이 후보를 구동할 에이전트. 생략하면 전역 기본 백엔드. */
  agentBackend?: AgentBackendId
  /** 이 후보를 멀티 에이전트 모드로 만들지. 생략하면 전역 기본값. */
  multiAgent?: boolean
}

export interface CreateFanoutResult {
  groupId?: string
  workspaceIds?: string[]
  /** 요청 전체가 불가능했던 이유(리포 없음·슬롯 수 이상 등). 하나라도 만들었으면 비어 있다. */
  error?: string
  /** 일부 후보만 실패했을 때 그 사유들. 나머지 후보는 정상적으로 만들어졌다. */
  failures?: string[]
  carryFailures?: CarryFailure[]
  /** 후보들에 공통인 "원본 없음" 경로들([[types]] CreateWorkspaceResult carryMissing). */
  carryMissing?: string[]
  carrySuggestions?: string[]
}

/** 채택 결과. 아카이브된 형제와, 그 과정에서 실패한 아카이브 스크립트를 함께 싣는다. */
export interface AdoptFanoutResult {
  error?: string
  /** 아카이브한 형제 워크스페이스의 표시 이름들(토스트 문구용). */
  archived?: string[]
  archiveScriptFailures?: ArchiveScriptFailure[]
}

export interface AppState {
  repos: Repo[]
  workspaces: Workspace[]
  /**
   * 같은 프롬프트로 한꺼번에 만든 워크스페이스 묶음(fan-out). 워크스페이스와 같은 상태 방송에
   * 실어, 사이드바·비교 화면이 별도 조회 없이 형제 관계를 알 수 있게 한다.
   */
  fanoutGroups: FanoutGroup[]
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

/** 합쳐진 사용자 턴 안의 peer 메시지 한 건. 발신자가 사라져도 칩을 그릴 수 있게 스냅샷한다. */
export interface PeerMessagePart {
  fromName: string
  fromBranch: string
  fromRepoName: string
  crossRepo: boolean
  /** 앱이 모델용으로 덧댄 권한 문단을 제외한, 발신 에이전트의 원문. */
  message: string
  /** 답장 도구와 스택 관계를 모델용 전문에서 복원한다. */
  route: 'peer' | 'notifyChild'
}

/** 다른 Wooi 워크스페이스가 시작한 사용자 턴을 화면에서 구분하기 위한 출처 스냅샷. */
export interface PeerMessageOrigin {
  kind: 'peer'
  /** 한 턴 중 들어온 것을 한 사용자 메시지로 묶으므로 발신자가 여러 명일 수 있다. */
  messages: PeerMessagePart[]
}

export type ChatUserOrigin = PeerMessageOrigin

/** 백엔드까지 함께 흘려 보낼 사용자 턴의 표시·모델용 옵션. */
export interface SendMessageOptions {
  prefix?: string
  silent?: boolean
  origin?: ChatUserOrigin
}

/**
 * 도구 결과를 한 줄로 줄인 것.
 *
 * 에이전트가 받은 원문(수천 줄일 수 있다)이 아니라 **화면에 필요한 수치만** 담는다. 트랜스크립트
 * (.jsonl)에 그대로 실려 나가므로 여기에 큰 문자열을 넣으면 기록이 부풀고, 대화를 다시 열 때마다
 * 그 값을 되읽게 된다. 원문이 필요하면 같은 항목의 `text` 를 펼쳐서 본다.
 */
export type ToolSummary =
  | { kind: 'read'; path: string; lines: number; total?: number; truncated?: boolean }
  | { kind: 'view'; path: string }
  | { kind: 'write'; path: string; lines: number; created: boolean }
  | { kind: 'patch'; path: string; added: number; removed: number }
  | { kind: 'files'; paths: string[] }
  | { kind: 'found'; count: number; unit: 'file' | 'match'; across?: number; truncated?: boolean }
  | { kind: 'output'; empty: boolean; background?: boolean; interrupted?: boolean }
  | { kind: 'fetch'; url: string; code: number; bytes: number }
  | { kind: 'todos'; done: number; total: number }
  | { kind: 'agent'; toolUses: number }

export type ChatItem =
  | {
      id: string
      type: 'user'
      text: string
      ts: number
      attachments?: ChatAttachment[]
      /** 없으면 사용자가 직접 보낸 기존 메시지다. */
      origin?: ChatUserOrigin
    }
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
  | {
      id: string
      type: 'tool_result'
      toolId: string
      text: string
      isError: boolean
      ts: number
      /** 구조화 출력에서 화면에 필요한 값만 줄인 요약. 옛 기록에는 없으며 text 로 폴백한다. */
      summary?: ToolSummary
    }
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
  | {
      id: string
      /** 이 지점 이전의 UI 기록은 모델 컨텍스트에서 압축됐으므로 기본 렌더링에서도 접는다. */
      type: 'compaction'
      trigger: 'auto' | 'manual'
      ts: number
      preTokens?: number
      postTokens?: number
    }
  /**
   * Wooi 가 백엔드에서 받은 것 중 **해석하지 못한 것**을 알리는 카드.
   *
   * 매핑하지 못한 입력을 버리는 것 자체는 맞다 — throw 하면 대화가 통째로 멈춘다. 문제는
   * 조용히 버리면 사용자가 대화에 구멍이 났다는 사실조차 모른다는 것이다. 그 구멍을 눈에
   * 보이게 만드는 것이 이 항목의 존재 이유다(매핑을 늘리는 것과는 별개의 문제다).
   *
   * id 를 `unknown:<backend>:<what>` 로 고정해 같은 종류는 대화당 한 장으로 합친다(upsert).
   * 백엔드 쪽 dedupe 기준(warned Set)과 같은 키를 쓴다.
   */
  | {
      id: string
      type: 'unknown'
      /** 어느 백엔드가 못 알아봤는가. */
      backend: AgentBackendId
      /** 못 알아본 대상. 예: `item type "webSearch"`, `content block "server_tool_use"`. */
      what: string
      /** 사용자가 할 수 있는 일이 있으면. 예: codex 업데이트 안내. */
      hint?: string
      ts: number
    }
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
   * 스택 자식이 부모에게 올린 인계 보고 카드.
   *
   * 부모 **대화에** 나타나지만 부모 세션의 맥락에는 들어가지 않는다 — 트랜스크립트와 에이전트
   * 컨텍스트는 별개이기 때문이다. 부모 에이전트는 `check_stacked_work` 로 직접 읽는다.
   * 그래서 이 카드는 **사람에게 알리는 것**이 목적이고, 눌러 자식으로 건너뛸 수 있다.
   */
  | {
      id: string
      type: 'handoff'
      /** 보고를 올린 자식 워크스페이스. 카드를 누르면 그리로 이동한다. */
      childWorkspaceId: string
      /** 표시용 자식 이름(보고 시점 스냅샷 — 자식이 사라져도 카드는 읽혀야 한다). */
      childName: string
      childBranch: string
      status: StackedHandoffStatus
      summary: string
      ts: number
    }

/**
 * 워크스페이스를 가로지르는 대화 검색의 결과 1건.
 *
 * 항목 원문은 담지 않는다 — main 이 트랜스크립트를 훑고 **매치 주변 스니펫만** 렌더러로
 * 넘긴다. 대화 전체를 렌더러 힙에 올리지 않기 위한 경계다([[TranscriptStore]] 주석 참고).
 */
export interface TranscriptHit {
  workspaceId: string
  /** ChatItem.id — 결과를 고르면 이 항목으로 스크롤한다. */
  itemId: string
  /** 항목 종류(user·assistant·tool_use …). 결과 행의 라벨에 쓴다. */
  kind: ChatItem['type']
  ts: number
  /** 매치 주변 한 줄 발췌(공백은 한 칸으로 눌렀고, 잘린 쪽에는 … 이 붙는다). */
  snippet: string
  /** snippet 안에서 매치가 시작하는 위치와 길이 — 하이라이트용. */
  matchStart: number
  matchLength: number
}

export interface TranscriptSearchResult {
  /** 워크스페이스는 최근 매치가 있는 쪽부터, 그 안에서는 대화 순서. */
  hits: TranscriptHit[]
  /** 상한에 걸려 일부가 빠졌다. UI 는 이를 반드시 알린다 — 조용한 절단 금지. */
  truncated: boolean
  /** 실제로 훑은 워크스페이스 수. */
  scanned: number
  /** 상한을 이미 채워 아예 훑지 못한 워크스페이스 수. */
  skipped: number
}

/**
 * 자식이 보고하는 상태.
 * - done: 목적한 작업을 끝냈다.
 * - blocked: 막혔고 부모(또는 사람)의 판단이 필요하다.
 *
 * 둘로만 나눈 이유: 부모가 취할 행동이 갈리는 지점이 여기뿐이다. 진행률 같은 중간 상태는
 * 워크스페이스의 running/idle 로 이미 보인다.
 */
export type StackedHandoffStatus = 'done' | 'blocked'

/**
 * 스택 자식이 부모에게 남긴 마지막 인계 보고. **자식 레코드에** 둔다.
 *
 * 부모에 목록으로 쌓지 않는 이유: 부모가 알고 싶은 것은 "각 자식이 지금 어떤 상태인가" 이고,
 * 자식이 사라지면 그 보고도 함께 사라지는 게 맞다. 다시 보고하면 덮어쓴다.
 */
export interface StackedHandoff {
  status: StackedHandoffStatus
  /** 자식이 무엇을 했는지. 부모 에이전트가 이 문장을 그대로 읽는다. */
  summary: string
  at: number
}

/**
 * 다른 워크스페이스에서 온 메시지를 이 워크스페이스가 어떻게 받을 것인가.
 *
 * 이 값이 **수신 쪽에** 있는 것이 설계의 핵심이다. 스택에서는 발신을 제한해 왔지만
 * (`notify_child` 는 자기가 만든 직계 자식만), peer 는 리포까지 가로지르므로 같은 방식으로는
 * 막을 수 없다 — 형제도 남의 리포도 정당한 대상이다. 그래서 "누가 보낼 수 있는가" 대신
 * **"내가 받아서 턴을 돌릴 것인가"** 를 대상이 정한다.
 *
 * - `accept`(기본): 바로 전달한다. 워크스페이스끼리의 협업이 사람의 중계 없이 이어진다.
 * - `hold`: 받아 두되 전달하지 않는다. 사용자가 승인해야 턴이 시작된다.
 * - `refuse`: 받지 않는다. 발신자에게 거절로 알린다.
 *
 * 앱 안의 발신자는 Wooi 가 만든 도구·대상 제한·중복 방어를 통과하고 출처도 대화에 남으므로
 * `accept` 를 기본으로 삼는다. 비용을 매번 승인하는 대신 협업이 멈추지 않는 쪽을 택하되,
 * 사용자는 `hold`·`refuse` 로 이 워크스페이스의 경계를 다시 좁힐 수 있다.
 */
export type PeerInboundPolicy = 'accept' | 'hold' | 'refuse'

/** 수신 정책을 정하지 않은 워크스페이스의 기본값. 레거시 레코드(필드 없음)도 이 값으로 읽힌다. */
export const DEFAULT_PEER_INBOUND: PeerInboundPolicy = 'accept'

/**
 * 전달을 기다리는 peer 메시지 1건. **수신 워크스페이스 레코드에** 쌓인다.
 *
 * 발신자 정보를 id 가 아니라 **이름·브랜치·리포까지 스냅샷**해 둔다. 승인은 몇 시간 뒤일 수
 * 있고 그 사이 발신 워크스페이스가 아카이브되거나 이름이 바뀔 수 있는데, 그때 카드가
 * "누가 보냈는지 모를 메시지" 가 되면 사용자는 승인도 거절도 판단할 수 없다.
 */
export interface PendingPeerMessage {
  /** 승인·거절이 지목하는 키. */
  id: string
  /** 앱 밖 세션은 열어 볼 Wooi workspace가 없으므로 null이다. */
  fromWorkspaceId: string | null
  /** 표시용 발신자 이름(수신 시점 스냅샷). */
  fromName: string
  fromBranch: string
  /** 발신 리포 이름. 리포를 가로지른 메시지인지가 여기서 읽힌다. */
  fromRepoName: string
  /** 발신 워크스페이스와 같은 리포인가. 다르면 카드가 리포 이름을 앞세운다. */
  crossRepo: boolean
  /** 에이전트가 쓴 본문(평문). 대기 카드가 사용자에게 보여 주는 것이 이 문장이다. */
  message: string
  /** 승인 뒤에도 원래 도구에 맞는 답장 규칙을 만들기 위한 전달 경로. */
  route?: 'peer' | 'notifyChild'
  /**
   * 정책(`hold`)이 아니라 **전달하려다 실패해서** 여기 남은 것인가.
   *
   * 카드의 문구가 갈린다. 정책으로 잡힌 것은 사용자가 승인을 고르는 자리지만, 이쪽은 발신자가
   * 이미 "전달됐다" 는 답을 받아 간 뒤 대상 세션이 사라진 경우다 — 사용자에게 그 사실을 그대로
   * 말해야 "왜 저쪽은 못 받았는가" 가 여기서 끝난다.
   */
  undelivered?: true
  /**
   * 승인되면 대상 대화에 실제로 들어갈 완성된 문장 — 출처 문단까지 이미 씌운 것.
   *
   * 승인 시점에 다시 만들지 않고 **받은 순간의 것을 그대로 보관한다.** 두 가지가 걸려 있다:
   * 도구마다 출처 문단이 다르고(`notify_child` 는 "네 아래 브랜치에서 온 소식" 이라고 말한다),
   * 승인은 몇 시간 뒤라 그때는 발신 워크스페이스가 사라져 문단을 다시 만들 근거가 없을 수 있다.
   */
  text: string
  at: number
}

/** 워크스페이스 1곳이 쌓아 둘 수 있는 대기 메시지 수. 넘으면 가장 오래된 것부터 버린다. */
export const MAX_PEER_INBOX = 20

/**
 * Claude Code 세션이 **바깥에서 불릴 이름**(`--name`).
 *
 * Wooi 워크스페이스도 결국 하나의 Claude Code 세션이라, 2.1.224+ 의 cross-session messaging 은
 * 사용자의 다른 터미널 세션에서 `/list-agents` 로 이것을 본다. 이름을 우리가 정하지 않으면 CLI 가
 * 작업 디렉터리 이름으로 지어 버리는데, Wooi 의 워크트리는 전부 랜덤 이름이라(`fluffy-hornbill`)
 * 사용자가 목록에서 어느 것이 무슨 작업인지 알 수 없다.
 *
 * `wooi/` 접두사는 그 세션이 앱 안에 있다는 표시다 — 터미널에서 띄운 세션과 섞이는 목록에서
 * "여기에 보내면 Wooi 창이 뜬다" 를 읽히게 한다.
 *
 * 64 코드포인트 상한과 제어문자 제거는 CLI 가 표시명에 적용하는 정규화를 미리 맞춘 것이다.
 * 잘라도 코드포인트 경계에서 자른다 — 이모지가 든 브랜치 이름을 바이트로 자르면 깨진 문자가 남는다.
 */
export function peerSessionName(repoName: string, branch: string): string {
  // 카테고리 Cc/Cf/Cs/Zl/Zp — 양방향 제어문자·제로폭·태그 문자를 걷어낸다.
  const clean = (s: string): string =>
    Array.from(s)
      .filter((ch) => !/\p{Cc}|\p{Cf}|\p{Cs}|\p{Zl}|\p{Zp}/u.test(ch))
      .join('')
      .trim()
  const full = `wooi/${clean(repoName)}/${clean(branch)}`
  const points = Array.from(full)
  return points.length <= 64 ? full : points.slice(0, 63).join('') + '…'
}

/**
 * Wooi 의 수신 정책을 **네이티브** cross-session messaging 의 `crossSessionInbound` 로 옮긴다.
 *
 * 네이티브의 `hold` 는 CLI 가 승인 다이얼로그를 그려야 풀리지만 SDK 세션은 그 다이얼로그를
 * 띄울 수도 없고 보류된 메시지를 풀어 줄 API 도 없다. 그대로 넘기면 메시지가 영영 갇히므로
 * `hold`·`refuse` 를 모두 `refuse` 로 접을 수밖에 없다.
 *
 * 앱 안의 peer 전달 기본값은 `accept` 지만 여기서는 그 폴백을 보지 않고 **저장된 `accept`** 만
 * 인정한다. 네이티브 경로에는 Wooi 의 대상 제한·중복 방어가 없고 앱 바깥의 로컬 Claude Code
 * 세션도 들어오므로, 정책 필드가 없는 워크스페이스까지 자동으로 열어서는 안 된다.
 *
 * 이 접기가 **승인 배너를 우회하는 구멍도 함께 막는다.** Wooi 워크스페이스도 같은 머신의
 * Claude Code 세션이라 네이티브 `ListAgents` 에 그대로 보이므로, 모델이 우리 도구 대신 네이티브
 * `SendMessage` 로 옆 워크스페이스를 직접 찔러 볼 수 있다. 그 경로로 온 메시지도 결국 수신 쪽의
 * `crossSessionInbound` 를 통과해야 하는데, `hold` 워크스페이스는 여기서 `refuse` 가 되므로
 * 배너를 건너뛴 전달이 성립하지 않는다. 두 경로가 같은 정책 하나로 수렴한다.
 */
export function nativePeerInbound(policy: PeerInboundPolicy | undefined): 'accept' | 'refuse' {
  return policy === 'accept' ? 'accept' : 'refuse'
}

/**
 * 지금 살아 있는 서브에이전트 또는 백그라운드 task 1건의 표시용 스냅샷(사이드바 running 패널).
 *
 * 트랜스크립트 ChatItem 이 아니라 **휘발성 상태**다 — 영속하지 않고, 세션이 끝나면 사라진다.
 * 이미 부모 턴의 tool_use/tool_result 카드로 트랜스크립트에 남으므로, 여기서 다시 기록하면
 * 이중 표시가 된다. 패널은 "지금 무엇이 돌고 있나"만 답한다.
 */
export interface RunningAgent {
  /** SDK task_id. 이 워크스페이스 안에서 유일하며, 갱신·종료를 이 값으로 병합한다. */
  taskId: string
  /** 에이전트가 아닌 SDK 백그라운드 task 면 그 task_type. 없으면 서브에이전트다. */
  taskType?: string
  /** 이 항목만 중지할 수 있는 Claude 라이브 query 가 있음을 뜻한다. */
  canStop?: boolean
  /** 서브에이전트 타입(SDK subagent_type). 예: 'Explore', 'code-reviewer'. */
  agentType: string
  /**
   * 이 서브에이전트를 실제로 돌리는 백엔드. 없으면 **부모 워크스페이스의 백엔드**로 읽는다.
   *
   * 네이티브 서브에이전트(Claude 의 Task · Codex 의 collab)는 정의상 부모와 같은 백엔드라 이
   * 값을 싣지 않는다. 위임(delegate) 도구로 띄운 교차 백엔드 실행만 자기 백엔드를 명시하고,
   * 사이드바는 그 값으로 브랜드 마크를 갈아 끼운다.
   */
  backend?: AgentBackendId
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

/** API 가 다음 시도를 기다리는 동안만 보이는 세션 상태. ChatItem 이 아니므로 기록하지 않는다. */
export interface ApiRetryState {
  attempt: number
  maxRetries: number
  retryDelayMs: number
  errorStatus: number | null
}
export type CodexGoalStatus =
  'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

/**
 * 지금 세션에 붙어 있는 목표 1건의 표시용 스냅샷.
 *
 * RunningAgent 와 마찬가지로 트랜스크립트가 아니라 **휘발성 상태**다. 목표는 대화 내용이 아니라
 * 백엔드의 실행 제어 상태이고 알림이 갱신 정본이므로, ChatItem 으로 만들면 재시작 뒤 이미 끝난
 * 목표가 살아난다. 백엔드별 필드는 억지로 맞추지 않고 discriminator 아래 그대로 둔다.
 */
export type WorkspaceGoal =
  | {
      backend: 'codex'
      objective: string
      status: CodexGoalStatus
      tokenBudget: number | null
      tokensUsed: number
      timeUsedSeconds: number
    }
  | {
      backend: 'claude'
      condition: string
      iterations: number
      lastReason?: string
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
  | { type: 'session'; sessionId: string; model?: string; isFallback?: boolean }
  /** API 재시도 진행 상태. null 이면 진행/종료되어 표시를 즉시 지운다. */
  | { type: 'apiRetry'; retry: ApiRetryState | null }
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
   * 이 워크스페이스에서 지금 살아 있는 서브에이전트·백그라운드 task **전체 목록**.
   *
   * REPLACE 시맨틱이다 — 렌더러는 목록을 병합하지 말고 통째로 갈아끼운다. 시작/종료 엣지를
   * 짝지어 맞추는 방식이면 알림 하나만 유실돼도 스피너가 영구히 남는데, 매번 전량을 보내면
   * 다음 갱신에서 저절로 복구된다. 빈 배열 = 실행 중인 서브에이전트 없음.
   */
  | { type: 'agents'; agents: RunningAgent[] }
  /** 현재 세션의 목표 전체 스냅샷. null 이면 목표가 없다(REPLACE 시맨틱, 영속 금지). */
  | { type: 'goal'; goal: WorkspaceGoal | null }
  /** 다음 프롬프트 제안. null 이면 제거한다(REPLACE 시맨틱, 영속 금지). */
  | { type: 'promptSuggestion'; suggestion: string | null }
  /**
   * 에이전트가 방금 작업 트리를 건드렸다 — git 상태를 다시 읽으라는 **신호**다.
   *
   * 페이로드가 없는 것이 핵심이다. Codex 는 `turn/diff/updated` 로 누적 diff **본문**을 주지만
   * 그걸 Changes 패널의 정본으로 삼지 않는다: 그 diff 는 에이전트가 만든 변경만 담고, 사용자가
   * 직접 편집한 것이나 Claude 백엔드의 변경은 담지 못한다. 패널이 백엔드마다 다른 것을 보여
   * 주게 되는 셈이라, 정본은 지금처럼 git 하나로 두고 **언제 다시 읽을지만** 이 이벤트로 알린다.
   *
   * 이게 없으면 Changes 패널은 턴이 끝나야(result 아이템) 갱신된다 — 긴 턴 내내 비어 있다.
   */
  | { type: 'workingTreeChanged' }

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

/**
 * 이 요청이 "행위 승인" 이 아니라 **사용자에게 답을 묻는** 것인가.
 *
 * `kind === 'question'` 이 아니라 도구 이름으로 가른다 — codex 의 McpElicitation 도 kind 는
 * 'question' 이지만 그것은 Allow/Deny 로 답하는 요청이다. 반대로 codex 의
 * `tool/requestUserInput` 은 Claude 의 AskUserQuestion 과 같은 이름으로 매핑되어 들어온다
 * (`codex/mapping.ts`). 화면(ChatView·QuestionPrompt)과 폰이 쓰는 갈림과 같은 규칙이다.
 */
export function isQuestionPermission(request: Pick<PermissionRequest, 'toolName'>): boolean {
  return request.toolName === 'AskUserQuestion'
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
 *
 * 1번 자리는 CLI 와 같은 규칙으로 갈린다: auto mode 를 쓸 수 있으면 "Yes, and use auto mode",
 * 없으면 "Yes, auto-accept edits". 가용 여부는 부르는 쪽이 판단해 넘긴다
 * (main 은 모델을 보고 `supportsAutoMode` 로 정한다).
 */
export function planOptions(autoAvailable: boolean): PermissionOption[] {
  return [
    autoAvailable
      ? {
          id: 'plan-auto',
          label: 'Yes, and use auto mode',
          behavior: 'allow',
          description: 'Switches to Auto mode — a classifier approves actions as they come'
        }
      : {
          id: 'plan-auto-accept',
          label: 'Yes, auto-accept edits',
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
}

/**
 * 계획 승인 시 전환할 권한 모드.
 *
 * **id 가 모드를 결정한다** — 승인 시점에 auto 가용성을 다시 들고 다니지 않아도 되도록,
 * 프롬프트를 그릴 때 이미 갈라 둔 id 를 그대로 읽는다. 알 수 없는 선택지는 안전한 쪽
 * (매번 확인)으로 떨어진다.
 */
export function planApprovalMode(optionId: string | undefined): PermissionMode {
  if (optionId === 'plan-auto') return 'auto'
  if (optionId === 'plan-auto-accept') return 'acceptEdits'
  return 'default'
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

export const SETUP_SCRIPT_ID = 'setup'

export interface RunScript {
  id: string
  name: string
  command: string
  autoStart: boolean
}

/** setup 스크립트의 마지막 실행 결과(Workspace.setupState 에 영속). */
export type SetupState = 'idle' | 'success' | 'failed'

export interface ScriptOutputEvent {
  workspaceId: string
  scriptId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface ScriptExitEvent {
  workspaceId: string
  scriptId: string
  code: number | null
}

export type ScriptRunState = 'idle' | 'running' | 'exited'

// ── Preview 패널(워크트리의 dev 서버를 앱 안에서 보는 탭) ────────────────

/**
 * Preview `<webview>` 가 쓰는 Electron 세션 파티션.
 *
 * 앱의 기본 세션과 **반드시** 갈라 둔다. 이유가 둘이다:
 *  1. 격리 — 미리보는 페이지가 앱이 들고 있는 쿠키·스토리지·자격증명에 닿지 못한다.
 *  2. CSP — 메인은 프로덕션에서 defaultSession 의 모든 응답에 `default-src 'self'` 를 씌운다
 *     ([[main/index]] applyContentSecurityPolicy). 같은 세션을 쓰면 그 헤더가 미리보는
 *     dev 서버 페이지에도 붙어 자기 스크립트조차 못 불러온다. 파티션이 다르면 아예 걸리지 않는다.
 *
 * `persist:` 접두사로 디스크에 남긴다 — 로그인해 둔 dev 앱을 앱 재시작마다 다시 로그인하지 않도록.
 */
export const PREVIEW_PARTITION = 'persist:wooi-preview'

/** Preview 를 특정 주소로 열라는 신호(evtPreviewOpen 페이로드). */
export interface PreviewOpenEvent {
  workspaceId: string
  url: string
}

/**
 * 컴포저에 넣을 것 한 건. 스크린샷은 이미지만, 요소 픽커는 이미지(크롭)와 텍스트를 함께 싣는다.
 * 둘을 한 건으로 묶는 것이 요점이다 — 픽커의 그림과 설명은 짝이라, 따로 흘려보내면 컴포저에서
 * 순서가 갈리거나 한쪽만 도착한다.
 */
export interface ComposerAttachment {
  image?: ImageAttachment
  /** 초안 끝에 붙일 텍스트 블록(요소 픽커의 구조화 정보). */
  text?: string
}

/** 컴포저에 넣을 것이 도착했다(evtComposerAttach 페이로드). */
export type ComposerAttachEvent = ComposerAttachment & { workspaceId: string }

/** Preview 가 모은 문제의 개수(evtPreviewIssues 페이로드). */
export interface PreviewIssueCountEvent {
  workspaceId: string
  errors: number
  warnings: number
}

/** Preview 캡처 결과. 성공하면 이미지는 evtComposerAttach 로 따로 흘러가고 여기엔 아무것도 없다. */
export interface PreviewCaptureResult {
  error?: string
}

// ── 분리 가능한 패널(별도 창) ────────────────────────────────────────────

/**
 * 메인 창에서 떼어 별도 창으로 띄울 수 있는 패널.
 * 듀얼 모니터에서 대화는 이쪽 화면에, 파일·터미널·스크립트 로그는 저쪽 화면에 두기 위한 것.
 */
export type PaneKind = 'work' | 'scripts'

export const PANE_KINDS: readonly PaneKind[] = ['work', 'scripts'] as const

/** 지금 별도 창으로 떠 있는 패널(main 이 소유하고 모든 창에 방송한다). */
export type PaneState = Record<PaneKind, boolean>

/** 창의 위치·크기(분리한 패널 창의 자리를 기억하는 데 쓴다). */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ScriptStatus {
  scriptId: string
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
  /**
   * 이 워크트리에 rebase 가 진행 중인지. `conflicted` 만으로는 머지 충돌과 rebase 충돌을 가릴 수
   * 없어서 따로 둔다 — "에이전트에게 해결을 맡긴다" 는 rebase 에만 성립하므로, 머지 충돌에까지
   * 그 버튼을 띄우면 누를 때마다 거절당하는 버튼이 된다.
   */
  rebasing: boolean
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
 * - merge: 머지 트레인이 이 층의 PR 을 병합함. 진행 UI 와 최종 결과에 같은 단계로 남긴다.
 */
export type StackCascadeStepKind = 'retarget' | 'recover' | 'restack' | 'merge'

/** 캐스케이드 한 단계의 결과. 실패해도 다음 브랜치는 계속 시도하고, 결과를 모아 UI 로 올린다. */
export interface StackCascadeStep {
  branch: string
  prNumber: number | null
  /**
   * 모델 A 캐스케이드는 자식마다 별도 worktree 를 써서, 시작한 워크스페이스와 충돌이 난
   * 워크스페이스가 다르다. branch/prNumber 만으로 어느 에이전트가 그 worktree 를 소유하는지 알 수
   * 없어 싣는다. 이 필드 이전에 만든 단계와 worktree 가 자명한 경로의 단계는 없을 수 있다.
   */
  workspaceId?: string
  kind: StackCascadeStepKind
  /**
   * - skipped: 이미 원하는 상태였음(GitHub 가 자동 retarget 한 경우 등).
   * - diverged: 리모트 브랜치가 로컬 tip 과 갈라져 있어 rebase 를 **하지 않았다**. 워킹트리가
   *   깨끗해도 "할 일 없음"이 아니다 — GitHub 은 스택 아래층이 병합되면 위 브랜치들의 원격 ref
   *   를 서버에서 다시 쓴다(실측). 그 위에 옛 커밋을 재생하면 위 레이어가 아래층 변경까지 자기
   *   PR 에 끌어안아 자기만의 diff 를 잃는다. force-with-lease 는 이걸 막지 못하므로(cascade.ts
   *   참고) 명시적으로 멈추고 사용자에게 알린다.
   */
  status: 'ok' | 'skipped' | 'conflict' | 'failed' | 'diverged'
  /** status==='conflict' 일 때 충돌 파일들(RestackResult 와 같은 의미). */
  conflictedFiles?: string[]
  /** 실패·건너뜀 사유(사용자에게 그대로 보여 준다). */
  message?: string
}

/** 캐스케이드 전체 결과. 단계별 성공/실패를 모두 담아 조용히 삼키지 않는다. */
export interface StackCascadeResult {
  steps: StackCascadeStep[]
}

export interface StackOpProgress {
  workspaceId: string
  /** restack = 사용자가 직접 누른 rebase, sync = 부모 병합 후 캐스케이드, train = 머지 트레인. */
  kind: 'restack' | 'sync' | 'train'
  /** 예상 대상 브랜치 수. 모르면 null(단일 브랜치 restack). */
  total: number | null
  /** 끝난 단계들(순서대로). 실패·건너뜀도 담는다 — 조용히 삼키지 않는다. */
  done: StackCascadeStep[]
  /** 지금 돌고 있는 단계. 시작 전/끝난 뒤에는 null. */
  current: { branch: string; kind: StackCascadeStepKind } | null
  /** 작업이 끝났는가. 렌더러가 스피너를 내리고 결과 줄만 남긴다. */
  finished: boolean
  startedAt: number
}

/** 머지 트레인이 훑을 층 하나. 아래→위 순서로 담긴다. */
export interface StackTrainLayer {
  branch: string
  prNumber: number | null
  state: PrState | null
  /** 이 층에서 트레인이 멈추는 이유. null 이면 머지 가능. */
  blockedReason: string | null
}

export interface StackTrainPlan {
  layers: StackTrainLayer[]
  /** 막히기 전까지 실제로 머지될 층 수. */
  mergeableCount: number
  /** 이 트레인이 force-push 할 브랜치 수(사용자에게 반드시 보여 준다). */
  forcePushCount: number
  /** 위 숫자의 실제 브랜치 이름들 — 확인 화면이 나열한다. */
  forcePushBranches: string[]
  /** 계획 자체를 세우지 못한 이유(워크스페이스 없음·GitHub 미연결 등). */
  error?: string
}

export interface StackTrainResult {
  mergedPrs: number[]
  /** 모든 층의 단계를 이어 붙인다. 머지 단계도 빠뜨리지 않는다. */
  steps: StackCascadeStep[]
  stoppedAt: { branch: string; reason: string } | null
  /** 실행을 시작조차 못 한 이유. */
  error?: string
}

/**
 * 캐스케이드에서 사용자가 알아야 할(성공이 아닌) 단계만 추린다.
 * diverged 는 실패가 아니라 "일부러 하지 않았다"지만, 하지 않았다는 사실 자체를 사용자가
 * 알아야 스택이 조용히 어긋난 채로 남지 않는다 — 그래서 문제 목록에 함께 올린다.
 */
export function cascadeProblems(result: StackCascadeResult): StackCascadeStep[] {
  return result.steps.filter(
    (s) => s.status === 'conflict' || s.status === 'failed' || s.status === 'diverged'
  )
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
    /**
     * 리모트 브랜치가 로컬 tip 과 갈라져 있는지. 승인 **전에** 알려야 하는 사실이라 계획에
     * 함께 담는다 — 이 상태에서 "Sync stack" 을 누르면 캐스케이드가 그 브랜치의 rebase 를
     * 건너뛰므로(diverged 단계), 무엇이 안 될지 미리 보여 준다.
     */
    remoteDiverged?: boolean
  }>
  detectedAt: number
}

/**
 * PR 이 병합돼 이 워크스페이스에 남은 일이 없다고 앱이 판단한 상태.
 *
 * 판단을 에이전트에게 시키지 않는 이유: 앱은 이미 병합을 알고 있다(스택 캐스케이드가 그 신호로
 * 돈다). 앱이 아는 사실을 굳이 턴을 태워 다시 추론시키면 비용이 들고 판단이 틀릴 수도 있다.
 *
 * 감지만 하고 실행하지 않는 것은 stackSync 와 같은 이유다 — 아카이브는 worktree 를
 * `git worktree remove --force` 로 지우므로, 사용자 모르게 나가면 안 된다.
 */
export interface ArchiveSuggestion {
  /** 이 제안을 띄우게 만든 병합 브랜치. 해제 기억(archiveSuggestDismissed)의 키이기도 하다. */
  mergedBranch: string
  /** 병합된 PR 번호(배너에 보여 준다). 번호를 알아내지 못했으면 null. */
  prNumber: number | null
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

/**
 * 한 레이어(= PR 1건)의 diff. 스택 리뷰는 이 묶음을 여러 개 들고 다닌다.
 *
 * `ReviewDiff` 자체는 손대지 않는다 — PR 하나를 줄 단위로 파싱하는 코드는 정확하고 테스트도
 * 그쪽에 있다. 여러 PR 을 다루는 것은 그 위를 감싸는 그릇의 일이지 파서의 일이 아니다.
 */
export interface ReviewLayerDiff {
  prNumber: number
  diff: ReviewDiff
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
  /**
   * 이 지적이 어느 PR 의 diff 를 가리키는지. 스택 리뷰에서 **인라인 지적에는 필수**다 —
   * 같은 경로·같은 줄 번호가 여러 레이어에 존재할 수 있어, 없으면 엉뚱한 PR 에 코멘트가 달린다.
   * 레이어가 하나뿐인 리뷰에서는 생략해도 그 하나로 해석된다.
   */
  prNumber?: number
  /**
   * 스택 자체에 대한 지적이 관련짓는 PR 들(레이어 경계·순서·중복). 비어 있지 않으면 어느 한
   * 줄에도 속하지 않는 지적이라는 뜻이다.
   */
  stackPrNumbers?: number[]
}

/** 레이어 1건에 대한 총평. 판정을 낼 때 그 PR 의 본문으로 쓴다. */
export interface ReviewLayerSummary {
  prNumber: number
  summary: string
}

export interface ReviewArtifact {
  /** 스택 전체(레이어가 하나면 그 PR)에 대한 총평. */
  summary: string
  /** 후속 턴의 대화형 답변. 최초 리뷰에서는 비어 있다. */
  reply: string
  general: ReviewFindingInput[]
  inline: ReviewFindingInput[]
  /** 스택 자체에 대한 지적. 레이어가 하나인 리뷰에서는 비어 있다. */
  stack: ReviewFindingInput[]
  /** 레이어별 총평. 판정을 PR 마다 따로 내야 하므로 본문도 PR 마다 따로 필요하다. */
  layers: ReviewLayerSummary[]
  /** 앞선 턴이 낸 지적을 고쳐 쓴 것. 최초 리뷰에서는 비어 있다. */
  updates: ReviewFindingRevision[]
  /** 앞선 턴이 낸 지적 중 거둬들일 것. 최초 리뷰에서는 비어 있다. */
  discards: ReviewFindingDiscard[]
}

/**
 * 에이전트가 자기 지적 1건을 고쳐 쓴 것.
 *
 * `id` 는 프롬프트에 실어 준 **핸들**(지적 id 의 앞부분)이다 — uuid 를 통째로 복사하게 하면
 * 한 글자만 틀려도 조용히 무시되고, 모델도 토큰을 그만큼 더 쓴다.
 * 나머지 필드는 **준 것만 바뀐다** — 본문만 고치려는 턴이 제목까지 다시 짓게 만들면
 * 사용자가 이미 손본 문장이 이유 없이 사라진다.
 */
export interface ReviewFindingRevision {
  id: string
  severity?: ReviewSeverity
  title?: string
  body?: string
}

/** 에이전트가 거둬들이는 지적 1건. 이유는 활동 타임라인에 남는다. */
export interface ReviewFindingDiscard {
  id: string
  /** 왜 더 이상 유효하지 않은지. 사용자가 되살릴지 판단하는 유일한 근거다. */
  reason?: string
}

/** diff 의 실제 행에 확정 고정된 위치. 이 값이 있어야 인라인 코멘트를 걸 수 있다. */
export interface ReviewAnchor {
  /**
   * 이 줄을 담고 있는 diff 의 PR. 코멘트는 반드시 이 PR 로 간다 — 다른 PR 에 걸면 422 이거나,
   * 더 나쁘게는 같은 경로·줄이 우연히 존재해 **엉뚱한 PR 에 조용히 달린다**.
   * 옛 레코드(단일 PR 리뷰)에는 없다. 그때는 세션의 유일한 레이어를 뜻한다.
   */
  prNumber?: number
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
  /**
   * 이 지적이 게시될 PR. 인라인이면 `anchor.prNumber` 와 같고, 전반 지적이면 타임라인 코멘트가
   * 올라갈 PR 이다. 옛 레코드에는 없다 — 그때는 세션의 유일한 레이어.
   */
  prNumber?: number
  /**
   * 스택 자체에 대한 지적이 관련짓는 PR 들(아래→위). 비어 있지 않으면 화면에서 따로 묶어
   * 보여주고, 게시는 그중 **가장 아래 레이어**로 간다(먼저 바뀌어야 하는 쪽).
   */
  stackPrNumbers?: number[]
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
 * 이미 한 번 낸 리뷰를 빈 본문으로 또 내려 할 때의 안내.
 *
 * 제출과 동시에 총평을 비우므로(`ReviewSession.summary`), 다시 내려면 새로 쓴 말이 있어야
 * 한다 — 본문이 비었다는 건 할 말이 없다는 뜻이고, 그런 판정은 상대의 타임라인만 어지럽힌다.
 * 화면과 main 이 같은 문장을 공유한다.
 */
export const EMPTY_RESUBMIT_BLOCKED =
  'You already submitted a review — write a message to submit another.'

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
  /**
   * 이 코멘트가 달린 PR. 답글 폴링과 outdated 판정이 PR 마다 따로 돌므로, 어느 응답과 대조해야
   * 하는지 알려면 필요하다. 옛 레코드에는 없다 — 그때는 세션의 유일한 레이어.
   */
  prNumber?: number
  /** ISO 8601. 이 이후에 달린 남의 코멘트만 새 활동으로 본다. */
  createdAt: string
  /**
   * 코멘트가 걸린 줄이 최신 diff 에서 사라졌는가(GitHub 의 "Outdated").
   *
   * 폴링이 갱신한다. 화면에서 이걸 알려주지 않으면, 상대가 이미 고쳐 놓은 자리를 두고
   * 사용자는 아직 살아 있는 지적인 줄 안다.
   */
  outdated?: boolean
  /**
   * 이 코멘트가 뿌리인 GitHub 리뷰 스레드의 node id(GraphQL). REST 응답에는 없는 값이라
   * 스레드 질의로만 채워진다. issue 코멘트에는 스레드가 없어 영영 비어 있다.
   */
  threadId?: string
  /**
   * 상대(또는 내가) GitHub 에서 이 스레드를 **Resolved 로 접었는가**.
   *
   * 폴링이 갱신한다. 이걸 모르면 상대가 이미 처리했다고 접어 둔 지적을 리뷰 화면은 아직
   * 살아 있는 것으로 그려, 사용자는 끝난 일을 다시 붙잡는다.
   */
  resolved?: boolean
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
  /**
   * 이 리뷰를 돌리는 모델과 추론 강도. 에이전트와 마찬가지로 **시작할 때 정해져 고정**된다 —
   * 후속 턴이 앞선 대화를 이어받는데 도중에 모델이 바뀌면 같은 리뷰의 판단 기준이 달라진다.
   *
   * 시작 시점에 전역 기본값으로 해석해 둔 값이다. null 이면 에이전트가 알아서 고른다.
   */
  model: string | null
  effort: EffortSetting | null
  /**
   * 이 리뷰가 보는 레이어들(아래→위). **PR 하나짜리 리뷰는 원소가 하나인 스택이다** —
   * `workspaceStack()` 이 스택이 아닌 워크스페이스에 단일 엔트리를 합성해 주는 것과 같은 규칙이라,
   * 매니저·프롬프트·앵커링·화면이 분기 없이 한 경로로 돈다.
   */
  layers: ReviewLayer[]
  /** 컨텍스트 예산에 못 들어가 프롬프트에서 이름만 나열된 파일 수. 0 이 아니면 화면이 알린다. */
  truncatedFiles: number
  /** 리뷰를 시작할 때 사용자가 쓴 최초 프롬프트. */
  prompt: string
  status: ReviewStatus
  /**
   * 에이전트의 총평. 제출 모달의 본문을 이걸로 채우고, **리뷰를 제출하면 비운다** — 그 내용은
   * 이미 PR 로 갔으므로, 남겨 두면 같은 말이 다시 채워져 또 올라가기 쉽다. 후속 턴이 새 총평을
   * 내면 다시 찬다.
   */
  summary: string
  archived: boolean
  createdAt: number
  updatedAt: number
  /** 후속 턴을 같은 맥락으로 이어 붙이기 위한 SDK 세션 id. */
  agentSessionId: string | null
  postedComments: PostedComment[]
  /** 아직 확인하지 않은 새 활동(답글·커밋)이 있는지 — 사이드바 점. */
  unread: boolean
  /**
   * 마지막으로 실패한 이유. 성공하거나 다시 시작하면 지운다.
   *
   * **레코드가 들고 있어야 한다** — 렌더러의 `view.error` 는 그 실행 동안만 살아서, 앱을 껐다
   * 켜면 "Failed" 라는 상태만 남고 왜 실패했는지도, 이어서 무엇을 하면 되는지도 사라진다.
   * (옛 레코드에는 이 필드가 없다 — 읽는 쪽이 `?? null` 로 받는다.)
   */
  lastError: ReviewFailure | null
}

/** 리뷰가 멈춘 이유 1건. 사용량 제한은 "언제 다시 눌러야 하는가" 가 곧 처방이라 따로 들고 있다. */
export interface ReviewFailure {
  message: string
  /** 사용량 제한으로 멈췄는가. 화면이 "실패" 대신 "제한에 걸려 멈춤" 으로 말을 바꾼다. */
  rateLimited: boolean
  /** 제한이 풀리는 시각(epoch ms). 오류 문구가 알려 줬을 때만 채워진다. */
  resetsAt: number | null
}

/**
 * 스택 리뷰가 보는 레이어 1건 = PR 1건.
 *
 * 세션이 하나여도 **GitHub 을 향한 상태는 PR 마다 따로**다 — 인라인 코멘트의 commit_id,
 * 자기 PR 차단, 판정 제출, 답글 워터마크가 모두 PR 단위이기 때문이다. 그것들이 여기 모여 있다.
 */
export interface ReviewLayer {
  prNumber: number
  prUrl: string
  prTitle: string
  /** PR 작성자의 GitHub 로그인. 자기 PR 인지 판단하는 근거다. */
  prAuthor: string
  /**
   * 내가 쓴 PR 인가. GitHub 은 자기 PR 을 승인하거나 변경 요청할 수 없게 막으므로, 이 값이
   * true 면 판정 선택지에서 그 둘을 아예 뺀다(눌러 보고 GraphQL 에러를 받는 대신).
   *
   * **레이어마다 따로** 판정한다 — 둘이 함께 쌓은 스택이면 내 것과 남의 것이 섞여 있다.
   */
  viewerIsAuthor: boolean
  /** 인라인 코멘트의 commit_id 로 쓰인다. */
  headSha: string
  headRefName: string
  baseRefName: string
  /**
   * 이 레이어의 PR 이 병합됐는가. 병합돼도 레코드에서 빼지 않는다 — 거기 단 코멘트와 지적은
   * 그대로 기록이다. 대신 폴링·재조회 대상에서만 빠진다.
   */
  merged: boolean
  /** 답글 폴링 워터마크(ISO). 이보다 뒤에 생긴 남의 코멘트만 새 활동으로 본다. */
  lastSeenAt: string | null
  /** 마지막으로 확인한 PR head sha. 달라지면 새 커밋이 올라온 것이다. */
  lastSeenHeadSha: string
  /**
   * 이 레이어 하나에 대한 총평. 판정을 PR 마다 따로 내야 하므로 본문도 PR 마다 필요하다.
   * 세션의 `summary`(스택 전체)와 같은 규칙으로, 제출하면 비운다.
   */
  summary: string
  /** 이 PR 에 마지막으로 제출한 판정. 제출은 PR 마다 따로 나가므로 기록도 따로 남는다. */
  lastSubmission: ReviewSubmission | null
}

/** 스택의 맨 위 레이어. 리뷰의 이름·워크트리 기준이 된다(맨 위가 가장 늦게 병합돼 오래 남는다). */
export function stackHead(session: Pick<ReviewSession, 'layers'>): ReviewLayer | undefined {
  return session.layers[session.layers.length - 1]
}

/**
 * PR 번호로 레이어를 찾는다. 번호를 모르면(옛 레코드의 앵커·코멘트) **맨 위**로 떨어진다 —
 * 옛 레코드는 레이어가 하나뿐이라 그것이 곧 유일한 레이어다.
 */
export function layerFor(
  session: Pick<ReviewSession, 'layers'>,
  prNumber: number | undefined
): ReviewLayer | undefined {
  if (prNumber === undefined) return stackHead(session)
  return session.layers.find((l) => l.prNumber === prNumber)
}

/** 리뷰가 스택인가(레이어 2개 이상). `isBranchStack` 과 같은 결의 질문이다. */
export function isStackReview(session: Pick<ReviewSession, 'layers'>): boolean {
  return session.layers.length > 1
}

/**
 * 제출한 리뷰 1건의 기록. 화면의 판정 칩이 이 값을 그린다.
 *
 * 본문은 남기지 않는다 — 같은 말을 또 올리는 것은 제출과 동시에 총평(`summary`)을 비우는
 * 것으로 막고, 본문 비교로 판단하지 않기 때문이다.
 */
export interface ReviewSubmission {
  verdict: ReviewVerdict
  at: number
}

/** 실행 중 에이전트 활동을 사용자에게 보여주기 위한 축약 항목. */
export interface ReviewProgressItem {
  id: string
  kind: 'text' | 'tool' | 'error'
  /** 한 줄 요약. 도구 항목이면 `name  detail` 을 합친 문자열이다. */
  text: string
  /**
   * 도구 항목의 이름·인자 요약을 나눠 담는다(kind === 'tool' 일 때만).
   *
   * 화면이 워크스페이스 대화와 **같은 도구 행**으로 그리려면 이름과 인자가 분리돼 있어야
   * 한다. `text` 는 합쳐 둔 값이라 옛 기록·폴백용으로만 남긴다.
   */
  name?: string
  detail?: string
  ts: number
}

/**
 * 활동 타임라인의 한 항목. 에이전트와의 대화, 가져온 답글, 새 커밋을 한 줄기로 합친다 —
 * 사용자가 보고 싶은 건 "이 리뷰에서 무슨 일이 있었나" 라는 하나의 흐름이기 때문이다.
 */
export type ReviewActivityItem =
  | { id: string; kind: 'turn'; role: 'user' | 'agent'; text: string; ts: number }
  | { id: string; kind: 'tool'; text: string; name?: string; detail?: string; ts: number }
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
      /** 어느 레이어에서 온 답글인지. 없으면 세션의 유일한 레이어(옛 레코드). */
      prNumber?: number
      ts: number
    }
  | { id: string; kind: 'commits'; headSha: string; prNumber?: number; ts: number }
  /**
   * 내가 단 코멘트의 스레드가 GitHub 에서 Resolved 로 접혔다. 답글 없이 조용히 접히는 일이
   * 흔해서, 이걸 알리지 않으면 "아무 반응 없음" 과 "처리됐음" 이 화면에서 구분되지 않는다.
   */
  | {
      id: string
      kind: 'resolved'
      /** 접힌 스레드의 루트 코멘트 id(= 우리가 게시한 코멘트). */
      commentId: number
      /** 그 코멘트를 낳은 지적. 카드로 되짚어 갈 수 있게. */
      findingId: string
      path?: string
      prNumber?: number
      ts: number
    }
  /**
   * 에이전트가 다시 보고 자기 지적을 거둬들였다. 목록에서 사라지는 일이라 흔적이 남아야 —
   * 아무 말 없이 줄어들면 사용자는 무엇이 왜 사라졌는지 알 방법이 없다.
   */
  | {
      id: string
      kind: 'withdrawn'
      /** 거둬들인 지적의 제목. 지적 자체는 이미 목록에 없어 여기 남은 것이 전부다. */
      title: string
      reason: string
      ts: number
    }
  /**
   * 아래 레이어에 새 커밋이 올라가 위쪽이 통째로 rebase 됐지만 **내용은 그대로**인 경우.
   * 레이어마다 "새 커밋" 을 하나씩 띄우면 진짜 바뀐 것이 그 소음에 묻힌다.
   */
  | { id: string; kind: 'restack'; prNumbers: number[]; causedBy: number; ts: number }
  | { id: string; kind: 'error'; text: string; ts: number }

/** 리뷰 화면을 열 때 사이드카에서 한 번에 읽어오는 덩치 큰 부분. */
export interface ReviewBundle {
  /** 레이어별 diff(아래→위). PR 하나짜리 리뷰는 원소가 하나다. */
  diffs: ReviewLayerDiff[]
  findings: ReviewFinding[]
  activity: ReviewActivityItem[]
  /**
   * "봤음" 표시한 파일 경로 → 그때의 내용 지문. 지문이 지금 diff 와 어긋나면 그 사이 파일이
   * 바뀐 것이라 안 본 것으로 친다(`@shared/reviewViewed` 의 isFileViewed).
   */
  viewed: Record<string, string>
}

export type ReviewEvent =
  | { type: 'status'; status: ReviewStatus }
  | { type: 'diff'; diffs: ReviewLayerDiff[] }
  | { type: 'progress'; item: ReviewProgressItem }
  /**
   * 지적 목록의 변경분. `findings` 는 추가·갱신(같은 id 면 덮어쓴다), `removed` 는 에이전트가
   * 거둬들여 목록에서 빠진 id 다. 둘을 한 이벤트로 보내야 화면이 한 번에 같은 상태로 간다.
   */
  | { type: 'findings'; findings: ReviewFinding[]; removed?: string[] }
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

/** 워크스페이스 시작 모달과 에이전트 도구가 함께 쓰는 열린 이슈 목록 항목. */
export interface IssueCandidate {
  number: number
  title: string
  author: string
  labels: string[]
  url: string
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
  /**
   * 전달 목록의 경로 중 리포 루트에 실제로 없는 것을 골라낸다(설정 모달의 인라인 경고).
   * 파일 존재 확인은 main 만 할 수 있어 IPC 가 필요하다.
   */
  repoMissingCarryPaths: 'repo:missingCarryPaths',
  /** 사이드바 드래그 앤 드롭으로 리포 표시 순서를 바꾼다. */
  repoReorder: 'repo:reorder',
  repoListBranches: 'repo:listBranches',
  repoListIssues: 'repo:listIssues',
  repoGetIssueBody: 'repo:getIssueBody',
  workspaceCreate: 'workspace:create',
  workspaceArchive: 'workspace:archive',
  /** 병합된 PR 로 뜬 아카이브 제안을 해제한다(같은 병합은 다시 제안하지 않는다). */
  workspaceArchiveSuggestDismiss: 'workspace:archiveSuggestDismiss',
  workspaceUnarchive: 'workspace:unarchive',
  workspaceRemove: 'workspace:remove',
  /** 한 레포의 아카이브된 워크스페이스를 한 번에 영구 삭제한다(브랜치·기록 포함). */
  workspaceRemoveArchived: 'workspace:removeArchived',
  /** 대기 중인 peer 메시지를 전달한다(그 워크스페이스에서 턴이 시작된다). */
  workspacePeerInboxDeliver: 'workspace:peerInboxDeliver',
  /** 대기 중인 peer 메시지를 버린다. 전달되지 않고 사라진다. */
  workspacePeerInboxDismiss: 'workspace:peerInboxDismiss',
  /** 다른 워크스페이스에서 오는 메시지를 받는 방식([[PeerInboundPolicy]])을 바꾼다. */
  workspaceSetPeerInbound: 'workspace:setPeerInbound',
  /** 같은 프롬프트로 후보 워크스페이스 N 개를 한 번에 만들고 한 그룹으로 묶는다. */
  fanoutCreate: 'fanout:create',
  /** 승자 후보를 채택하고 나머지 형제를 아카이브한다(확인은 렌더러가 먼저 받는다). */
  fanoutAdopt: 'fanout:adopt',
  /** 그룹 기록을 지운다. 워크스페이스에는 손대지 않는다 — 묶음만 잊는다. */
  fanoutForget: 'fanout:forget',
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
  /**
   * 메인 에이전트 교체. 아직 아무것도 보내지 않은 워크스페이스에서만 통한다
   * ([[canSwitchAgentBackend]]) — 그 외에는 이유를 담은 error 로 돌아온다.
   */
  workspaceSetAgentBackend: 'workspace:setAgentBackend',
  /** 워크스페이스별 알림 음소거 토글. */
  workspaceSetMuted: 'workspace:setMuted',
  workspaceSetMultiAgent: 'workspace:setMultiAgent',
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
  chatStopTask: 'chat:stopTask',
  chatGetHistory: 'chat:getHistory',
  /** 워크스페이스별 누적 비용(USD). 대화 전체를 렌더러로 옮기지 않고 숫자만 받는다. */
  chatGetCosts: 'chat:getCosts',
  /** /btw 사이드 질문 — 메인 대화를 건드리지 않는 임시 질의를 띄운다. */
  chatSideQuestion: 'chat:sideQuestion',
  /** /clear — 트랜스크립트를 비우고 세션을 새로 시작한다(워크스페이스는 유지). */
  chatClear: 'chat:clear',
  chatClearGoal: 'chat:clearGoal',
  /** 워크스페이스를 가로지르는 대화 검색. 결과는 스니펫만 담긴다(원문은 main 에 남는다). */
  chatSearch: 'chat:search',
  permissionRespond: 'permission:respond',
  scriptRun: 'script:run',
  scriptStop: 'script:stop',
  scriptGetStatus: 'script:getStatus',
  /**
   * 스크립트의 누적 출력(꼬리 버퍼)을 읽는다. 출력은 이벤트로 흘려보내므로, 나중에 뜬 창
   * (분리한 스크립트 패널)은 그때까지의 로그를 볼 방법이 없다 — 그 창을 채우는 용도다.
   */
  scriptGetOutput: 'script:getOutput',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  /** 리포의 origin tracking ref 를 갱신한다. 실패는 main 에서 조용히 무시한다. */
  gitFetch: 'git:fetch',
  /** base 브랜치를 현재 워크스페이스 브랜치로 머지해 드리프트를 해소한다. */
  gitUpdateFromBase: 'git:updateFromBase',
  /** stacked 워크스페이스 브랜치를 최신 base(부모 브랜치) 위로 rebase 하고 리모트에 force-push 한다. */
  workspaceRestack: 'workspace:restack',
  /** 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요). */
  workspaceSwitchBranch: 'workspace:switchBranch',
  /** 외부에서 부모 PR 이 병합돼 생긴 대기 중 캐스케이드(stackSync)를 사용자 승인 후 실행한다. */
  stackSyncApply: 'stack:syncApply',
  /** 머지 N 번과 force-push M 번을 한 승인에 묶기 전, 아무것도 실행하지 않고 계획한다. */
  stackTrainPlan: 'stack:trainPlan',
  /** 사용자가 확인한 계획대로 아래→위 머지 트레인을 실행한다. */
  stackTrainRun: 'stack:trainRun',
  /** 대기 중 캐스케이드 계획을 무시하고 지운다. */
  stackSyncDismiss: 'stack:syncDismiss',
  /** 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다(gh pr edit --base). */
  stackBaseRetarget: 'stack:baseRetarget',
  /** 어긋난 base 를 의도한 것으로 받아들인다(그 base 를 채택하고 다시 묻지 않는다). */
  stackBaseKeep: 'stack:baseKeep',
  /** 충돌한 워크트리의 에이전트에게 rebase 충돌 해결을 맡긴다(사용자가 눌렀거나 autoResolveConflicts). */
  stackResolveConflict: 'stack:resolveConflict',
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
  /** 편집 모달을 열 때 PR 제목·본문 원문을 읽는다(PrStatus 에는 본문이 없다). */
  prEditable: 'pr:editable',
  /** PR 제목·본문을 고친다. */
  prEdit: 'pr:edit',

  /** 리뷰 시작 모달의 열린 PR 목록(제목·작성자 포함). */
  reviewListOpenPrs: 'review:listOpenPrs',
  /** PR 번호에서 그 PR 이 속한 스택을 복원한다(시작 모달의 "스택 전체" 선택지). */
  reviewResolveStack: 'review:resolveStack',
  /** PR 리뷰를 시작한다. 즉시 reviewId 를 돌려주고 나머지는 evtReview 로 흘린다. */
  reviewStart: 'review:start',
  /** 실행 중인 리뷰를 중단한다. */
  reviewCancel: 'review:cancel',
  /** 실패·중단된 리뷰를 이어서 다시 돌린다. */
  reviewResume: 'review:resume',
  /** 지적 1건을 실제 PR 에 코멘트로 게시한다(편집된 본문을 그대로 받는다). */
  reviewPost: 'review:post',
  /** 안 달기로 한 지적을 목록에서 버린다. */
  reviewDismiss: 'review:dismiss',
  /** 리뷰를 닫고 리뷰용 워크트리를 정리한다. */
  reviewClose: 'review:close',
  /** 아카이브된 리뷰를 한 번에 영구 삭제한다. */
  reviewRemoveArchived: 'review:removeArchived',
  /** 리뷰 화면 진입 시 사이드카(diff·지적·활동)를 읽어온다. */
  reviewLoad: 'review:load',
  /** 파일 1건의 "봤음" 표시를 켜고 끈다. */
  reviewSetFileViewed: 'review:setFileViewed',
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
  /** 설정 화면의 MCP 목록 — ~/.claude.json 에서 승계되는 서버들을 읽어 온다. */
  mcpInventory: 'mcp:inventory',
  /** 승계 서버를 고치려면 그 파일을 직접 열어야 한다(우리는 쓰지 않는다). */
  mcpOpenConfig: 'mcp:openConfig',
  /** 앱 밖 Claude Code에 Wooi peer 도구를 등록하는 현재 실행본용 명령. */
  mcpExternalSetupCommand: 'mcp:externalSetupCommand',
  /** `~/.codex/config.toml` 의 MCP 서버 목록(app-server 에 질의). */
  mcpCodexList: 'mcp:codexList',
  /** 그 서버의 `enabled` 를 사용자 파일에 쓰고 codex 에 재적용한다. */
  mcpCodexSetEnabled: 'mcp:codexSetEnabled',
  mcpCodexOauthLogin: 'mcp:codexOauthLogin',
  /** 설정 화면의 Codex 플러그인 목록(설치된 것만, 마켓플레이스별로 묶여 온다). */
  pluginCodexList: 'plugin:codexList',
  /** 그 목록의 플러그인 하나가 무엇을 싣고 있는지(행을 펼칠 때). */
  pluginCodexRead: 'plugin:codexRead',
  evtMcpCodexOauthLoginCompleted: 'mcp:codexOauthLoginCompleted',
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
   * `/wooi:*` 중 즉시 실행 명령을 에이전트를 거치지 않고 메인에서 바로 실행한다
   * ([[shared/wooiCommands]] 의 mode: 'direct'). 턴도 토큰도 쓰지 않는다.
   */
  wooiCommandRun: 'command:wooiRun',
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
  // 인터랙티브 터미널 (worktree PTY — 탭 하나당 하나)
  terminalStart: 'terminal:start',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  /** 워크스페이스의 터미널 PTY 를 전부 끊는다(탭 구성은 남는다). */
  terminalKill: 'terminal:kill',
  /** 워크스페이스의 탭 구성을 읽는다(없으면 탭 하나를 만들어 돌려준다). */
  terminalTabs: 'terminal:tabs',
  /** 새 탭을 만들고 그 탭을 활성으로 잡는다. */
  terminalTabCreate: 'terminal:tabCreate',
  /** 탭을 닫고 그 PTY 를 종료한다. 마지막 탭을 닫으면 빈 탭 하나가 새로 생긴다. */
  terminalTabClose: 'terminal:tabClose',
  /** 탭 이름을 바꾼다(빈 문자열이면 기본 이름으로 되돌린다). */
  terminalTabRename: 'terminal:tabRename',
  /** 보고 있는 탭을 바꾼다. */
  terminalTabSelect: 'terminal:tabSelect',
  /** 입력창의 `!명령` (Claude Code CLI bash 모드)을 PTY 에서 실행한다. */
  terminalRunCommand: 'terminal:runCommand',
  /** 입력창의 `!명령` 을 1회 실행하고 출력을 대화 흐름(트랜스크립트)에 인라인으로 흘려보낸다. */
  terminalExec: 'terminal:exec',
  /** 진행 중인 인라인 `!명령`(execInline)을 중단한다. 인자로 workspaceId 와 대상 아이템 id 를 받는다. */
  terminalKillInline: 'terminal:killInline',
  // 분리한 패널 창 (work / scripts)
  /** 해당 패널을 별도 창으로 띄운다(이미 떠 있으면 앞으로 가져온다). */
  paneOpen: 'pane:open',
  /** 분리한 패널 창을 닫는다 — 패널은 메인 창으로 되돌아간다. */
  paneClose: 'pane:close',
  /** 분리한 패널 창을 앞으로 가져온다. */
  paneFocus: 'pane:focus',
  /** 지금 분리돼 있는 패널 목록(창이 늦게 떠서 방송을 놓친 경우의 초기화용). */
  paneGetState: 'pane:getState',
  /** 메인 창의 선택 워크스페이스가 바뀌었음을 알린다 — 분리한 창이 따라 움직인다. */
  paneSetWorkspace: 'pane:setWorkspace',
  /** 분리한 창에서 리포 설정을 요청한다(메인 창을 앞으로 가져와 모달을 연다). */
  paneOpenRepoSettings: 'pane:openRepoSettings',
  // Preview 패널 (워크트리의 dev 서버를 앱 안에서 보는 탭)
  /** Preview 가 마지막으로 본 주소를 워크스페이스에 영속한다(주소창 입력·내비게이션 후). */
  previewSetUrl: 'preview:setUrl',
  /** 이 워크스페이스의 Preview 를 특정 주소로 연다(스크립트 패널의 "Open in Preview"). */
  previewOpen: 'preview:open',
  /** Preview 화면을 캡처해 컴포저 첨부로 흘려보낸다. 인자는 webview 게스트의 webContents id. */
  previewCapture: 'preview:capture',
  /**
   * 요소 픽커를 켠다. 사용자가 미리보는 페이지에서 요소를 고를 때까지 기다렸다가,
   * 선택자·outerHTML·적용된 CSS·크롭 이미지를 컴포저로 흘려보낸다.
   */
  previewPickElement: 'preview:pickElement',
  /** 진행 중인 요소 픽을 취소한다(Esc·패널 언마운트). */
  previewCancelPick: 'preview:cancelPick',
  /** 이 게스트의 콘솔·네트워크 문제를 이 워크스페이스 것으로 모으기 시작한다(dom-ready 에서). */
  previewWatchIssues: 'preview:watchIssues',
  /** 수집을 멈춘다(패널이 사라질 때). */
  previewUnwatchIssues: 'preview:unwatchIssues',
  /** 모아 둔 문제 목록을 읽는다(개수만 방송되므로 패널을 열 때 한 번 가져간다). */
  previewListIssues: 'preview:listIssues',
  /** 모아 둔 문제를 비운다. */
  previewClearIssues: 'preview:clearIssues',
  /** 고른 문제들을 컴포저에 넣는다. */
  previewSendIssues: 'preview:sendIssues',
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
  /** 지금 말고 "모든 워크스페이스 작업이 끝나면" 재시작하도록 예약한다(또는 예약을 해제한다). */
  updateSetRestartWhenIdle: 'update:setRestartWhenIdle',
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
  /** restack·stack sync 의 브랜치별 진행 스트림. */
  evtStackProgress: 'evt:stackProgress',
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
  /** 터미널 탭 구성 변경(생성·닫기·이름 변경·선택). 메인 창과 분리한 패널 창이 함께 따라간다. */
  evtTerminalTabs: 'evt:terminalTabs',
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
  /** 분리한 패널 창의 열림/닫힘 상태 — 메인 창은 이 값으로 인라인 패널을 감추거나 되돌린다. */
  evtPaneState: 'evt:paneState',
  /** 분리한 창이 따라가야 할 워크스페이스(메인 창의 선택을 그대로 따른다). */
  evtPaneWorkspace: 'evt:paneWorkspace',
  /** 분리한 창이 요청한 리포 설정 열기 — 메인 창이 받아 모달을 띄운다. */
  evtOpenRepoSettings: 'evt:openRepoSettings',
  /**
   * Preview 를 특정 주소로 열라는 신호. 스크립트 패널과 Preview 탭이 서로 **다른 창**에 있을 수
   * 있어(둘 다 분리 가능) renderer 안에서 직접 부를 수 없다 — main 을 거쳐 모든 창에 방송한다.
   */
  evtPreviewOpen: 'evt:previewOpen',
  /**
   * Preview 가 모은 문제의 **개수**. 목록이 아니라 개수만 보내는 것이 요점이다 — 매 콘솔 줄을
   * IPC 로 밀면 폭주하는 dev 로그가 메시지 홍수가 되어 메인 힙을 밀어 올린다([[main/previewIssues]]).
   */
  evtPreviewIssues: 'evt:previewIssues',
  /**
   * 컴포저에 붙일 이미지(Preview 스크린샷). 캡처는 어느 창에서든 일어날 수 있지만 컴포저는
   * 메인 창에만 있으므로, main 이 받아 방송하고 컴포저가 있는 창만 집어 간다.
   */
  evtComposerAttach: 'evt:composerAttach',
  /** 자동 업데이트 상태 변화(확인 중/최신/발견/다운로드 진행/준비됨/오류). */
  evtUpdate: 'evt:update',
  /** 원격 공지 목록이 갱신됨(main 이 주기적으로 가져온 결과). */
  evtNotice: 'evt:notice',
  /** 원격 접근 상태 변화(연결/페어링 진행/기기 목록). 설정 패널만 구독한다. */
  evtRemote: 'evt:remote',
  /**
   * 폰이 워크스페이스를 열어 보고 있다(workspaceId). 데스크톱의 미확인 표시를 해제하는 용도다 —
   * 미확인은 렌더러 메모리에만 있어서, 폰에서 읽었다는 사실이 이 방송 없이는 전달되지 않는다.
   */
  evtRemoteRead: 'evt:remoteRead',

  // 원격 접근(모바일 컴패니언) 관리 — **전부 데스크톱 전용이다.**
  // 이름이 `remote:` 로 시작하지만 원격에서 호출할 수 있어서는 절대 안 된다
  // (폰이 스스로 페어링을 시작하거나 다른 기기를 revoke 할 수 있게 된다).
  // allowlist.test.ts 의 영구 거부 목록이 이걸 잠근다.
  /** 연결 상태·페어링 진행 상태·페어링된 기기 목록을 한 번에 읽는다. */
  remoteGetStatus: 'remote:getStatus',
  /** 원격 접근 마스터 스위치. 끄면 소켓과 타이머가 전부 정리된다. */
  remoteSetEnabled: 'remote:setEnabled',
  /** QR 을 띄우고 폰의 claim 을 기다리기 시작한다. */
  remotePairStart: 'remote:pairStart',
  /** 사용자가 SAS 6자리를 확인했다 — 여기서 처음으로 세션키가 만들어진다. */
  remotePairConfirm: 'remote:pairConfirm',
  remotePairCancel: 'remote:pairCancel',
  /** 기기 하나의 접근을 끊는다(릴레이의 revoked_at + 로컬 키 삭제). */
  remoteRevokeDevice: 'remote:revokeDevice',
  /** 모든 원격 데이터를 지운다 — 키스토어와 릴레이 양쪽. */
  remoteClearData: 'remote:clearData',
  /**
   * 미확인 워크스페이스 id 목록을 main 에 올린다(렌더러 → main, 전량 교체).
   *
   * 미확인은 렌더러 메모리에만 있고 AppState 에 없어서, 이 채널이 없으면 원격 투영이
   * 그것을 볼 수 없다 — 폰은 무엇이 안 읽혔는지 영영 모른다. 반대 방향(`evt:remoteRead`)과
   * 짝이다.
   */
  remoteSetUnread: 'remote:setUnread'
} as const

// ── IPC 페이로드 타입 ────────────────────────────────────────────────────

/**
 * 예약 재시작이 "작업이 다 끝났다"고 판정한 뒤 실제로 재시작하기까지의 유예.
 * main 은 이 값으로 restartAt 을 잡고, renderer 는 카운트다운의 상한으로 쓴다.
 */
export const RESTART_SETTLE_MS = 30_000

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
  /**
   * "모든 워크스페이스 작업이 끝나면 재시작" 예약이 걸려 있는가.
   * state 와 독립적으로 유지되고(다운로드 중에 걸어 둘 수 있다), 실제 발동은 ready 일 때만.
   */
  restartWhenIdle?: boolean
  /**
   * 예약이 발동 조건을 만족해 카운트다운에 들어간 시각(epoch ms, 이 시각이 지나면 재시작).
   * 없으면 아직 기다리는 중(=진행 중인 작업이 남아 있다).
   */
  restartAt?: number
  /**
   * 예약이 기다리고 있는 진행 중 작업 수(에이전트 턴 + 리뷰). 배너가 "무엇을 기다리는지"를
   * 보여 주기 위한 값으로, 예약이 걸려 있을 때만 채워진다.
   */
  busyCount?: number
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
  /** 원격 공지가 실행할 수 있는 앱 내부 동작. 파서의 고정 allowlist에 있는 값만 허용한다. */
  action?: { type: NoticeAction; label: string }
}

export type NoticeAction = 'enableAutoResumeAfterRateLimit'

/** 워크스페이스별 자동 재개 예약. 앱을 재시작해도 store에서 복원한다. */
export interface PendingRateLimitResume {
  backend: AgentBackendId
  sessionId: string
  detectedAt: number
  retryAt: number
  attempt: number
}

/**
 * 이 워크스페이스의 마지막 턴이 계정 사용량 제한으로 멈췄다는 표시.
 *
 * 자동 이어가기(autoResumeAfterRateLimit)와 **무관하게** 기록한다 — 설정이 꺼져 있어도 사용자는
 * "왜 멈췄고 언제 풀리는지" 를 사이드바에서 알아야 하기 때문이다. 설정이 켜져 있으면
 * pendingRateLimitResume 이 함께 있고, 그쪽이 재개 시각까지 말해 준다.
 */
export interface RateLimitPause {
  backend: AgentBackendId
  detectedAt: number
  /** 아는 해제 시각(epoch ms). 오류도 사용량 스냅샷도 알려 주지 않았으면 null. */
  resetsAt: number | null
}

/**
 * 해제 시각을 끝내 알아내지 못한 표시를 언제까지 보여 줄지.
 *
 * 표시는 다음 전송 때 지워지므로, 이 상한은 "안 쓰는 워크스페이스에 rate limit 딱지가 며칠씩
 * 붙어 있는" 것만 막는다. 5시간 창은 물론이고 대부분의 제한이 이 안에 풀린다.
 */
const UNKNOWN_RESET_TTL_MS = 12 * 60 * 60_000

/** 지금도 유효한 제한 표시인지 — 해제 시각이 지났거나 너무 오래됐으면 더는 보여 주지 않는다. */
export function activeRateLimitPause(
  pause: RateLimitPause | null | undefined,
  now: number
): RateLimitPause | null {
  if (!pause) return null
  if (pause.resetsAt != null) return pause.resetsAt > now ? pause : null
  return now - pause.detectedAt < UNKNOWN_RESET_TTL_MS ? pause : null
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
   * 만든 주체가 다른 워크스페이스의 에이전트면 그 워크스페이스 id. 렌더러(사람)는 넘기지 않는다.
   * 나중에 그 에이전트가 이 워크스페이스를 아카이브할 수 있는지의 근거가 된다.
   */
  createdByWorkspaceId?: string | null
  /**
   * 이 워크스페이스를 구동할 에이전트. 생성 시 한 번 정해져 세션 내내 고정된다.
   * 생략하면 stacked 자식은 부모 에이전트를 상속하고, 스택 뿌리는 전역 기본 백엔드를 쓴다.
   */
  agentBackend?: AgentBackendId
  /**
   * 이 워크스페이스만의 모델 오버라이드. 생략하면 null 로 저장돼 백엔드 전역 기본값을 따른다
   * (`AgentSettings.model`). 백엔드가 아는 모델 id 여야 한다 — 검증은 넘기는 쪽이 한다.
   */
  model?: string | null
  /** 이 워크스페이스만의 reasoning effort 오버라이드. 생략하면 백엔드 전역 기본값을 따른다. */
  effort?: EffortSetting | null
  /**
   * 팀 워크스페이스로 만들지. 생략하면 Solo 다 — 새 워크스페이스의 기본은 언제나 Solo 이고,
   * 이것을 켜서 넘기는 경로는 fan-out 슬롯뿐이다(사람이 후보별로 골라 둔 값).
   */
  multiAgent?: boolean
}

/**
 * 워크스페이스 생성 결과. 렌더러(IPC)와 에이전트 도구가 **같은 계약**을 쓰도록 이름을 붙여 둔다 —
 * 생성 자체는 main 의 한 함수([[workspaces]] createWorkspace)이고 호출 경로만 여럿이다.
 */
export interface CreateWorkspaceResult {
  workspaceId?: string
  name?: string
  branch?: string
  error?: string
  /** worktree 전달에 실패한 항목들. 생성 자체는 성공했지만 사용자에게 알려야 한다. */
  carryFailures?: CarryFailure[]
  /**
   * 전달 목록에 등록돼 있지만 **메인 체크아웃에 원본이 없어** 아무것도 전달되지 않은 경로들.
   *
   * 실패가 아니라서 오래 조용히 넘겨 왔는데, 그 침묵이 곧 버그였다 — gitignore 된 파일을
   * 워크트리 안에서만 만들어 온 사용자는 원본(리포 루트)이 비어 있다는 걸 알 길이 없어,
   * "등록해 뒀는데 새 워크스페이스에 아무것도 안 온다" 를 영영 겪는다. 렌더러가 리포·경로당
   * 한 번만 알려 잔소리가 되지 않게 한다.
   */
  carryMissing?: string[]
  /**
   * 리포의 전달 목록이 **비어 있을 때만** 채워지는, 지금 리포에 실제로 존재하는 후보 경로들.
   * 이 경우 새 worktree 는 `.env`·`CLAUDE.local.md` 없이 만들어졌다는 뜻이므로 렌더러가
   * 한 번 제안한다(구버전부터 쓰던 리포가 기능의 존재조차 모르는 상태를 깨는 유일한 지점).
   */
  carrySuggestions?: string[]
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
  | 'ci_pending'
  | 'ci_failed'
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
  /** 표시용 라벨: Draft / Review required / Changes requested / Checks pending / Checks failed / Ready to merge / Conflict / Open / Merged / Closed */
  label: string
  /** GitHub 가 base 브랜치 업데이트가 필요하다고 판정했는지(`mergeStateStatus === 'BEHIND'`). */
  needsBaseUpdate: boolean
}

/**
 * PR 에서 사람이 고칠 수 있는 부분. 편집 모달을 열 때만 읽는다 — 본문은 길 수 있어 PrStatus 에
 * 실으면 워크스페이스마다 도는 상태 폴링이 매번 그 문자열을 실어 나르게 된다.
 */
export interface PrEditable {
  title: string
  /** 본문이 없는 PR 도 있다 — 그때는 빈 문자열이다. */
  body: string
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

/**
 * 주간 창의 label. Codex 의 durationLabel 이 붙이고 renderer 가 상태줄 대표 창을 고르는 데 쓴다
 * (SESSION_RATE_LIMIT_LABEL 과 같은 이유로 SSOT).
 */
export const WEEKLY_RATE_LIMIT_LABEL = 'Weekly'

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

/** 터미널 탭 하나 = PTY 하나. 셸 세션은 영속하지 않고 이 메타데이터만 저장한다. */
export interface TerminalTab {
  id: string
  /** 사용자가 탭을 더블클릭해 붙인 이름. 없으면 화면이 순번으로 이름을 만든다(Terminal, Terminal 2 …). */
  title?: string
}

/** 한 워크스페이스의 터미널 탭 구성. 탭이 바뀔 때마다 모든 창에 이 형태로 방송된다. */
export interface TerminalTabsState {
  workspaceId: string
  tabs: TerminalTab[]
  /** 지금 보고 있는 탭. tabs 가 비어 있지 않은 한 항상 그중 하나를 가리킨다. */
  activeId: string
}

export interface TerminalDataEvent {
  workspaceId: string
  /** 이 출력을 낸 탭(PTY). */
  terminalId: string
  data: string
  /** true 면 재부착 시 누적 버퍼 재생 — 수신 측은 화면을 비우고 data 로 다시 채운다. */
  reset?: boolean
}

export interface TerminalExitEvent {
  workspaceId: string
  /** 종료된 탭(PTY). */
  terminalId: string
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
