import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_BACKEND, agentSettingsFor, normalizePermissionMode } from '@shared/types'
import type {
  CarryFailure,
  CreateWorkspaceArgs,
  CreateWorkspaceResult,
  Repo,
  Workspace
} from '@shared/types'
import { backendMeta } from './agent/registry'
import {
  applyCarryExcludes,
  carryIntoWorktree,
  detectCarryItems,
  isAgentContextPath
} from './carry'
import { addWorktree, resolveUniqueWorktree, syncGhMergeBase } from './git'
import { log } from './logger'
import { generateWorkspaceName } from './names'
import { findFreePort } from './net'
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

function repoFor(repoId: string): Repo | undefined {
  return getStore()
    .getState()
    .repos.find((r) => r.id === repoId)
}

/** workspace 별 스크립트에 주입할 환경변수. dev 서버가 충돌 없이 고유 포트를 쓰게 한다. */
export function scriptEnvFor(port: number): Record<string, string> {
  return {
    PORT: String(port),
    WOOI_DEV_PORT: String(port)
  }
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
  // 워크스페이스가 쓸 에이전트는 여기서 정해져 세션 내내 고정된다. 호출자가 지정하지 않으면
  // 전역 기본 백엔드를 쓴다. 권한 모드는 그 백엔드의 전역 기본값을 따르되, 백엔드가 모르는
  // 값(다른 백엔드에서 넘어온 기본값)이면 그 백엔드의 기본 모드로 보정한다.
  const agentBackend = args.agentBackend ?? settings.defaultAgentBackend ?? DEFAULT_AGENT_BACKEND
  const meta = backendMeta(agentBackend)
  const permissionMode = normalizePermissionMode(
    meta,
    agentSettingsFor(settings, agentBackend).permissionMode
  )
  const id = randomUUID()
  // 병렬 dev 서버 포트 충돌을 막기 위해 생성 시점에 고유 포트를 배정한다.
  const used = new Set<number>(
    store
      .getState()
      .workspaces.map((w) => w.devPort)
      .filter((p): p is number => typeof p === 'number')
  )
  const devPort = await findFreePort(used)
  store.update((st) =>
    st.workspaces.push({
      id,
      repoId: repo.id,
      agentBackend,
      // 모드 하나만 저장한다. 어떤 종류로 위임할지는 미리 고르지 않고 대화에서 정해진다.
      multiAgent: args.multiAgent === true,
      name: rawName,
      displayName: null,
      branch,
      baseBranch,
      parentWorkspaceId,
      prNumber: null,
      worktreePath,
      devPort,
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
    deps.scripts.run(id, 'setup', repo.setupScript, worktreePath, scriptEnvFor(devPort))
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
