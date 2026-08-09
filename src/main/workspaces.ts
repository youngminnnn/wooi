import { randomUUID } from 'node:crypto'
import {
  DEFAULT_AGENT_BACKEND,
  SETUP_SCRIPT_ID,
  agentSettingsFor,
  normalizePermissionMode
} from '@shared/types'
import type {
  AgentBackendId,
  CarryFailure,
  CreateWorkspaceArgs,
  CreateWorkspaceResult,
  Repo,
  Workspace
} from '@shared/types'
import { backendMeta } from './agent/backend'
import {
  applyCarryExcludes,
  carryIntoWorktree,
  detectCarryItems,
  isAgentContextPath
} from './carry'
import { addWorktree, removeWorktree, resolveUniqueWorktree, syncGhMergeBase } from './git'
import { getPrStatus } from './github'
import { log } from './logger'
import { generateWorkspaceName } from './names'
import { findFreePort } from './net'
import { invalidateWorkspacePr } from './prCache'
import { getStore } from './store'
import type { ScriptRunner } from './scripts'

/**
 * 워크스페이스(= worktree + 브랜치 + 세션) 생성.
 *
 * IPC 핸들러 안에 인라인으로 있던 것을 여기로 옮겼다 — 호출 경로가 렌더러 하나가 아니게 됐기
 * 때문이다. 에이전트가 자기 작업 위에 stacked 워크스페이스를 직접 쌓는 도구도 **이 함수를
 * 그대로** 부른다. 생성 규칙(고유 브랜치 이름, 스택 base 계산, 전달 파일, 셋업 스크립트,
 * dev 포트 배정)이 경로마다 갈라지면 그 순간 두 경로가 서로 다른 워크스페이스를 만든다.
 */
export interface CreateWorkspaceDeps {
  scripts: ScriptRunner
  /** 생성 직후 전체 상태를 창들에 방송한다(사이드바에 새 행이 나타나는 시점). */
  broadcastState: () => void
}

/**
 * 아카이브에 필요한 것. 생성보다 넓다 — 워크스페이스에 매달려 있던 것들을 전부 끊어야 하기
 * 때문이다. 구체 클래스가 아니라 쓰는 메서드만 적어 두어, 부르는 쪽(IPC 의 IpcContext,
 * 도구의 AgentToolDeps)이 자기 모양 그대로 넘길 수 있게 한다.
 */
export interface ArchiveWorkspaceDeps {
  sessions: { dispose: (workspaceId: string) => void }
  scripts: Pick<ScriptRunner, 'disposeWorkspace' | 'runOnce'>
  terminals: { disposeWorkspace: (workspaceId: string) => void }
  broadcastState: () => void
}

function repoFor(repoId: string): Repo | undefined {
  return getStore()
    .getState()
    .repos.find((r) => r.id === repoId)
}

/** workspace 별 스크립트에 주입할 환경변수. dev 서버가 충돌 없이 고유 포트를 쓰게 한다. */
export function portEnvName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function scriptEnvFor(repo: Repo, ws: Workspace, scriptId: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const script of repo.runScripts) {
    const port = ws.ports[script.id]
    const key = portEnvName(script.name)
    if (typeof port === 'number' && key && env[`WOOI_PORT_${key}`] === undefined)
      env[`WOOI_PORT_${key}`] = String(port)
  }
  const own = ws.ports[scriptId]
  if (typeof own === 'number') {
    env.PORT = String(own)
    env.WOOI_DEV_PORT = String(own)
  }
  return env
}

export function startAutoRunScripts(scripts: ScriptRunner, ws: Workspace, repo: Repo): void {
  for (const script of repo.runScripts.filter((item) => item.autoStart))
    scripts.run(
      ws.id,
      script.id,
      script.command,
      ws.worktreePath,
      scriptEnvFor(repo, ws, script.id)
    )
}

/**
 * 생성 요청에 agent 가 명시되지 않았을 때의 기본값.
 *
 * 스택 자식은 부모 작업의 연속이므로 부모 agent 를 물려받고, 스택 뿌리만 전역 기본값을 쓴다.
 * 이 규칙을 renderer 호출부에 맡기면 수동 생성·agent tool 같은 다른 생성 경로가 서로 달라진다.
 */
export function resolveWorkspaceAgentBackend(
  explicit: AgentBackendId | undefined,
  parent: Pick<Workspace, 'agentBackend'> | null | undefined,
  configuredDefault: AgentBackendId | undefined
): AgentBackendId {
  return explicit ?? parent?.agentBackend ?? configuredDefault ?? DEFAULT_AGENT_BACKEND
}

/**
 * `--base` 없이 실행된 `gh pr create` 가 향할 base 를 워크스페이스의 실제 base 에 맞춘다
 * ([[git]] syncGhMergeBase). Wooi 의 Create PR 버튼은 `--base` 를 직접 붙이지만, 에이전트나
 * 사용자가 터미널에서 맨손으로 여는 PR 은 이 설정이 없으면 전부 리포 기본 브랜치를 향한다.
 *
 * base 가 리포 기본 브랜치면 설정을 지워 gh 기본값에 맡긴다 — 값을 굳이 고정해 두면 나중에
 * 리포 기본 브랜치가 바뀌거나 fork 로 PR 을 열 때 어긋난 값만 남는다.
 * best-effort 다: 실패해도 워크스페이스 생성·캐스케이드를 막지 않는다.
 */
export async function syncPrBase(
  ws: Pick<Workspace, 'repoId' | 'worktreePath' | 'branch'>,
  base: string
): Promise<void> {
  const repo = repoFor(ws.repoId)
  if (!repo) return
  await syncGhMergeBase(
    ws.worktreePath,
    ws.branch,
    base === repo.defaultBranch ? null : base
  ).catch(() => {})
}

/**
 * 새로 만든 worktree 에 리포의 전달 목록(gitignore 되어 딸려오지 않는 파일들)을 옮긴다.
 *
 * 반드시 **셋업 스크립트 실행 전에** 끝나야 한다 — 셋업이 `.env` 를 읽거나, 심링크된
 * `node_modules` 를 보고 설치를 건너뛸 수 있어야 하기 때문. 전달이 실패해도 워크스페이스
 * 생성 자체는 성공시키고, 실패 목록만 돌려 호출 측이 사용자에게 알리게 한다.
 */
export async function carryIntoNewWorktree(
  repo: Repo,
  worktreePath: string
): Promise<CarryFailure[]> {
  if (repo.carryItems.length === 0) return []
  try {
    const { carried, failures } = carryIntoWorktree(repo.path, worktreePath, repo.carryItems)
    await applyCarryExcludes(worktreePath, carried)
    for (const f of failures) log.warn(`worktree 전달 실패: ${f.path} — ${f.reason}`)
    return failures
  } catch (err) {
    // 전달 단계 전체가 터져도 워크스페이스는 살린다(요구사항: 생성은 성공해야 한다).
    log.error('worktree 전달 단계 실패', err)
    return repo.carryItems.map((i) => ({
      path: i.path,
      reason: err instanceof Error ? err.message : String(err),
      agentContext: isAgentContextPath(i.path)
    }))
  }
}

/**
 * 전달 목록이 **비어 있는** 리포에 한해, 지금 리포에 실제로 존재하는 후보 경로들을 돌려준다.
 *
 * 신규 리포는 추가 시점에 detectCarryItems 로 목록이 채워지지만, v11 이하부터 쓰던 리포는
 * 마이그레이션이 빈 배열로 남겨 뒀다(사용자 의사 없이 파일을 옮기지 않으려는 의도적 선택).
 * 그 결과 기존 사용자에게는 이 기능이 존재조차 하지 않는 것처럼 보이고, worktree 는 계속
 * `.env`·`CLAUDE.local.md` 없이 만들어진다. 워크스페이스를 만드는 순간이 그 사실이 실제로
 * 문제가 되는 유일한 시점이므로, 여기서 후보를 돌려 렌더러가 한 번 제안하게 한다.
 */
export function carrySuggestionsFor(repo: Repo): string[] | undefined {
  if (repo.carryItems.length > 0) return undefined
  const detected = detectCarryItems(repo.path).map((i) => i.path)
  return detected.length > 0 ? detected : undefined
}

export async function createWorkspace(
  deps: CreateWorkspaceDeps,
  args: CreateWorkspaceArgs
): Promise<CreateWorkspaceResult> {
  const store = getStore()
  const repo = repoFor(args.repoId)
  if (!repo) return { error: 'Repository not found.' }

  // 이름 미입력 시 자동 생성, 베이스 미입력 시 리포 기본 브랜치(main/origin) 사용.
  let rawName = (args.name ?? '').trim()
  if (!rawName) {
    const existing = new Set(
      store
        .getState()
        .workspaces.filter((w) => w.repoId === repo.id)
        .map((w) => w.branch)
    )
    rawName = generateWorkspaceName(existing)
  }
  // stacked PR: parentWorkspaceId 가 주어지면 그 워크스페이스의 브랜치 위에 쌓는다(base=부모 브랜치).
  // 없으면 기존대로 origin 기본 브랜치(origin/<defaultBranch>)에서 분기한다. args.baseBranch 는 무시.
  const parent = args.parentWorkspaceId
    ? store
        .getState()
        .workspaces.find(
          (w) => w.id === args.parentWorkspaceId && w.repoId === repo.id && !w.archived
        )
    : null
  if (args.parentWorkspaceId && !parent) {
    return { error: 'Parent workspace not found (or archived).' }
  }
  const baseBranch = parent ? parent.branch : repo.defaultBranch
  const parentWorkspaceId = parent ? parent.id : null
  // 기존 브랜치/worktree 디렉토리와 충돌하면 접미사(-2, -3 …)를 붙여 고유 이름을 만든다.
  const { branch, worktreePath } = await resolveUniqueWorktree(repo.path, rawName)

  try {
    await addWorktree(repo.path, branch, baseBranch, worktreePath)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  // 스택이면 여기서 gh 의 기본 PR base 를 부모 브랜치로 못 박는다 — 에이전트가 첫 PR 을
  // 열기 전에 심어야 의미가 있다.
  await syncPrBase({ repoId: repo.id, worktreePath, branch }, baseBranch)

  // 셋업 스크립트보다 먼저 — 셋업이 전달된 .env·node_modules 를 볼 수 있어야 한다.
  const carryFailures = await carryIntoNewWorktree(repo, worktreePath)

  const settings = store.getState().settings
  // 워크스페이스가 쓸 에이전트는 여기서 정해져 세션 내내 고정된다. 호출자가 지정하지 않은
  // 스택 자식은 부모를 상속하고, 스택 뿌리만 전역 기본값을 쓴다. 권한 모드는 최종 백엔드의
  // 전역 기본값을 따르되, 백엔드가 모르는 값이면 그 백엔드의 기본 모드로 보정한다.
  const agentBackend = resolveWorkspaceAgentBackend(
    args.agentBackend,
    parent,
    settings.defaultAgentBackend
  )
  const meta = backendMeta(agentBackend)
  const permissionMode = normalizePermissionMode(
    meta,
    agentSettingsFor(settings, agentBackend).permissionMode
  )
  const id = randomUUID()
  // 모든 run script 에 워크스페이스 전체에서 고유한 포트를 하나씩 예약한다.
  const used = new Set<number>(store.getState().workspaces.flatMap((w) => Object.values(w.ports)))
  const ports: Record<string, number> = {}
  for (const script of repo.runScripts) {
    const port = await findFreePort(used)
    ports[script.id] = port
    used.add(port)
  }
  store.update((st) =>
    st.workspaces.push({
      id,
      repoId: repo.id,
      agentBackend,
      // 모드 하나만 저장한다. 어떤 종류로 위임할지는 미리 고르지 않고 대화에서 정해진다.
      // 호출자가 말하지 않으면 전역 기본값을 따른다 — 기본 설정에서는 모달 없이 만들어지므로
      // 이 폴백이 없으면 설정에서 고른 "Multi-agent" 가 그 경로에서 통째로 무시된다.
      multiAgent: args.multiAgent ?? settings.defaultMultiAgent === true,
      name: rawName,
      displayName: null,
      branch,
      baseBranch,
      parentWorkspaceId,
      // 누가 만들었는가. 부모 관계와 별개로 기록한다 — 사람이 UI 에서 만들면 여기가 null 이고,
      // 그 덕에 에이전트는 자기가 만든 것에만 손댈 수 있다([[agent/tools/target]]).
      createdByWorkspaceId: args.createdByWorkspaceId ?? null,
      prNumber: null,
      worktreePath,
      ports,
      // setup 은 아래에서 곧 실행된다. 종료 시 onExit 훅이 success/failed 로 갱신한다.
      setupState: 'idle',
      sessionId: null,
      permissionMode,
      model: null,
      effort: null,
      fastMode: null,
      status: 'idle',
      lastModel: null,
      fastModeState: null,
      fastModeReason: null,
      archived: false,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    })
  )
  deps.broadcastState()

  // 셋업 스크립트가 설정돼 있으면 생성 직후 실행(dev 와 같은 포트 env 를 주입).
  if (repo.setupScript.trim()) {
    const ws = store.getState().workspaces.find((item) => item.id === id)!
    deps.scripts.run(
      id,
      SETUP_SCRIPT_ID,
      repo.setupScript,
      worktreePath,
      scriptEnvFor(repo, ws, SETUP_SCRIPT_ID)
    )
  } else {
    const ws = store.getState().workspaces.find((item) => item.id === id)!
    startAutoRunScripts(deps.scripts, ws, repo)
  }

  // name·branch 를 함께 반환해 호출 측이 별도 getState 왕복 없이 토스트를 만들 수 있게 한다.
  // carryFailures 는 렌더러가 별도 토스트로 알린다 — 특히 에이전트 컨텍스트 파일이 빠지면
  // 에러 없이 에이전트만 다르게 동작하므로 조용히 넘기면 안 된다.
  return {
    workspaceId: id,
    name: rawName,
    branch,
    carryFailures,
    carrySuggestions: carrySuggestionsFor(repo)
  }
}

/**
 * 아카이브: 세션·스크립트·터미널을 정리하고 worktree 디렉토리를 제거하되 브랜치·대화 기록·
 * 세션 ID 는 유지한다(언아카이브하면 worktree 를 다시 만들고 같은 세션을 이어간다).
 *
 * createWorkspace 와 같은 이유로 IPC 핸들러에서 여기로 올라왔다 — 에이전트가 워크스페이스를
 * 아카이브하는 도구도 이 함수를 그대로 부른다([[agent/tools/workspace]]). 복사해 두면 한쪽만
 * 고쳐지는 날이 오는데, 이 절차는 **순서가 곧 정확성**이라 어긋나면 조용히 틀린다:
 * 아카이브 스크립트는 worktree 가 살아 있을 때 돌아야 하고, 표시 이름은 PR 을 물어볼 수
 * 있을 때 스냅샷해야 한다.
 *
 * 없는 워크스페이스는 조용히 넘긴다 — 아카이브의 목적은 "없는 상태" 이고 이미 그 상태다.
 */
export async function archiveWorkspace(
  deps: ArchiveWorkspaceDeps,
  workspaceId: string
): Promise<void> {
  const store = getStore()
  const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return
  const repo = repoFor(ws.repoId)

  deps.sessions.dispose(workspaceId)
  deps.scripts.disposeWorkspace(workspaceId)
  deps.terminals.disposeWorkspace(workspaceId)
  // 아카이브 스크립트는 worktree 가 아직 살아 있을 때 실행한다.
  if (repo?.archiveScript.trim()) {
    await deps.scripts.runOnce(repo.archiveScript, ws.worktreePath)
  }
  // override 가 없으면 현재 표시 이름(PR 제목 등)을 worktree 제거 전에 보존한다.
  // 아카이브 후에는 worktree·PR 조회가 불가능하므로, 같은 이름을 유지하려면 지금 스냅샷해야 한다.
  let snapshotName: string | null = null
  if (!ws.displayName?.trim()) {
    const pr = await getPrStatus(ws.worktreePath).catch(() => null)
    if (pr?.title?.trim()) snapshotName = pr.title.trim()
  }
  if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, false)
  // worktree 가 사라졌으니 캐시된 PR 상태도 물어볼 근거가 없다(언아카이브하면 다시 조회된다).
  invalidateWorkspacePr(workspaceId)

  store.update((st) => {
    const w = st.workspaces.find((x) => x.id === workspaceId)
    if (w) {
      w.archived = true
      w.status = 'idle'
      if (snapshotName && !w.displayName?.trim()) w.displayName = snapshotName
      // 제안을 받아 아카이브했든 다른 경로(사이드바·단축키·에이전트 도구)로 했든 그 병합은
      // 처리된 것이다. 해제로 기록해 두지 않으면 언아카이브했을 때 같은 제안이 곧바로 다시 뜬다.
      if (w.archiveSuggest) {
        w.archiveSuggestDismissed = w.archiveSuggest.mergedBranch
        w.archiveSuggest = null
      }
    }
  })
  deps.broadcastState()
}
