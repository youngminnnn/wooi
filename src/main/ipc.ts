import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { listDir, readFileInRoot, searchFiles } from './fsbrowse'
import { log } from './logger'
import {
  abortMerge,
  addWorktree,
  checkoutBranch,
  currentBranch,
  detectDefaultBranch,
  revParse,
  getDiff,
  getGithubOwner,
  getStatus,
  isGitRepo,
  isWorktreeClean,
  listBranches,
  removeWorktree,
  repoNameFromPath,
  resolveUniqueWorktree,
  restackOnto,
  updateFromBase
} from './git'
import {
  applyCarryExcludes,
  carryIntoWorktree,
  detectCarryItems,
  isAgentContextPath,
  validateCarryPath
} from './carry'
import { generateWorkspaceName } from './names'
import { buildStackFromPrs } from './stack'
import { findFreePort, waitForPortFree } from './net'
import {
  getPrStatus,
  getPrChecks,
  getPrMeta,
  createPrWeb,
  mergePr,
  closePr,
  reopenPr,
  markPrReady,
  listOpenPrs,
  fetchOwnerAvatarDataUrl
} from './github'
import { cascadeRetarget, cascadeRestackBranchStack, stepFromRestack } from './cascade'
import {
  getAuthStatus,
  claudeLoginStart,
  claudeLoginSubmitCode,
  claudeLoginCancel,
  claudeLogout,
  githubLoginStart,
  githubLoginCancel,
  githubLogout
} from './auth'
import { IPC, DEFAULT_AGENT_BACKEND, reorderById, workspaceStack } from '@shared/types'
import type {
  AppSettings,
  CarryFailure,
  CarryItem,
  CommandPanelKind,
  CommandResult,
  CreateWorkspaceArgs,
  DropPosition,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  PermissionDecision,
  PermissionMode,
  PrMergeMethod,
  Repo,
  RestackResult,
  RewindActionResult,
  ScriptKind,
  StackCascadeResult,
  StackCascadeStep,
  StackedBranch,
  StackSyncPlan,
  UpdateFromBaseResult,
  Workspace
} from '@shared/types'
import type { AgentOrchestrator } from './agent/orchestrator'
import type { ScriptRunner } from './scripts'
import type { TerminalManager } from './terminal'

interface IpcContext {
  sessions: AgentOrchestrator
  scripts: ScriptRunner
  terminals: TerminalManager
  getWindow: () => BrowserWindow | null
}

/**
 * 새로 만든 worktree 에 리포의 전달 목록(gitignore 되어 딸려오지 않는 파일들)을 옮긴다.
 *
 * 반드시 **셋업 스크립트 실행 전에** 끝나야 한다 — 셋업이 `.env` 를 읽거나, 심링크된
 * `node_modules` 를 보고 설치를 건너뛸 수 있어야 하기 때문. 전달이 실패해도 워크스페이스
 * 생성 자체는 성공시키고, 실패 목록만 돌려 호출 측이 사용자에게 알리게 한다.
 */
async function carryIntoNewWorktree(repo: Repo, worktreePath: string): Promise<CarryFailure[]> {
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
function carrySuggestionsFor(repo: Repo): string[] | undefined {
  if (repo.carryItems.length > 0) return undefined
  const detected = detectCarryItems(repo.path).map((i) => i.path)
  return detected.length > 0 ? detected : undefined
}

export function registerIpc(ctx: IpcContext): void {
  const store = getStore()

  /** 전체 상태 스냅샷을 모든 창에 방송한다. */
  const broadcastState = (): void => {
    const state = store.getState()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evtState, state)
    }
  }

  /** 단방향 이벤트를 모든 창에 보낸다(파괴된 webContents 송신 예외가 호출부를 끊지 않게 가드). */
  const dispatch = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      try {
        win.webContents.send(channel, payload)
      } catch (err) {
        log.error(`dispatch failed on ${channel}`, err)
      }
    }
  }

  const repoFor = (repoId: string): Repo | undefined =>
    store.getState().repos.find((r) => r.id === repoId)

  /**
   * 리포의 origin 리모트가 GitHub 이면 소유자 아바타를 받아 data URL 로 저장한다(best-effort).
   * 네트워크·비 GitHub 리모트 등으로 실패하면 조용히 넘어가 기본 아이콘을 유지한다.
   * repo 추가 직후·앱 시작 시 백그라운드로 호출해, 아바타 조회가 UI 흐름을 막지 않게 한다.
   */
  const backfillRepoAvatar = async (repoId: string): Promise<void> => {
    const repo = repoFor(repoId)
    if (!repo) return
    const owner = await getGithubOwner(repo.path).catch(() => null)
    if (!owner) return
    const dataUrl = await fetchOwnerAvatarDataUrl(owner)
    if (!dataUrl) return
    store.update((st) => {
      const r = st.repos.find((x) => x.id === repoId)
      if (r) r.avatarDataUrl = dataUrl
    })
    broadcastState()
  }

  // 앱 시작 시, 아바타가 아직 없는 기존 리포들에 대해 한 번씩 백필을 시도한다.
  for (const repo of store.getState().repos) {
    if (!repo.avatarDataUrl) void backfillRepoAvatar(repo.id)
  }

  /** workspace 별 스크립트에 주입할 환경변수. dev 서버가 충돌 없이 고유 포트를 쓰게 한다. */
  const scriptEnvFor = (port: number): Record<string, string> => ({
    PORT: String(port),
    WOOI_DEV_PORT: String(port)
  })

  /**
   * workspace 의 dev 포트를 반환한다. 아직 배정 전(레거시)이면 다른 workspace 와 겹치지 않는
   * 포트를 BASE_DEV_PORT 부터 골라 배정·영속한 뒤 반환한다.
   */
  const ensureDevPort = async (workspaceId: string): Promise<number | null> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    if (typeof ws.devPort === 'number') return ws.devPort
    const used = new Set<number>(
      store
        .getState()
        .workspaces.map((w) => w.devPort)
        .filter((p): p is number => typeof p === 'number')
    )
    const port = await findFreePort(used)
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.devPort = port
    })
    return port
  }

  // ── 리포 ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.repoAdd, async (): Promise<{ repo?: Repo; error?: string }> => {
    const win = ctx.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return {}

    const path = result.filePaths[0]
    if (!(await isGitRepo(path))) {
      return { error: 'The selected folder is not a git repository.' }
    }
    if (store.getState().repos.some((r) => r.path === path)) {
      return { error: 'This repository has already been added.' }
    }

    const defaultBranch = await detectDefaultBranch(path)
    const repo: Repo = {
      id: randomUUID(),
      name: repoNameFromPath(path),
      path,
      defaultBranch,
      setupScript: '',
      devScript: '',
      archiveScript: '',
      // 흔한 에이전트 컨텍스트·런타임 설정 파일이 실제로 있으면 미리 채워 둔다. 빈 목록으로
      // 시작하면 사용자가 이 기능을 모른 채, worktree 에 지침 파일이 없어 에이전트가 조용히
      // 다르게 동작하는 문제를 계속 겪게 된다. 안전한 copy 모드로만 넣는다.
      carryItems: detectCarryItems(path),
      addedAt: Date.now()
    }
    store.update((st) => st.repos.push(repo))
    broadcastState()
    // GitHub 소유자 아바타는 네트워크 조회가 필요하므로 추가를 막지 않도록 백그라운드로 채운다.
    void backfillRepoAvatar(repo.id)
    return { repo }
  })

  ipcMain.handle(
    IPC.repoUpdate,
    (
      _e,
      repoId: string,
      patch: Partial<
        Pick<Repo, 'name' | 'setupScript' | 'devScript' | 'archiveScript' | 'carryItems'>
      >
    ): { error?: string } => {
      // carryItems 는 그대로 복사·심링크 대상 경로가 되므로 **저장 시점에** 검증한다.
      // 예전에는 Object.assign 만 해서, 리포 밖을 가리키는 경로도 모달에서 멀쩡히 저장되고
      // 한참 뒤 워크스페이스를 만들 때가 되어서야 실패 토스트로 드러났다.
      // 렌더러도 같은 규칙으로 인라인 검증하지만, IPC 는 신뢰 경계라 여기서 다시 본다.
      let normalized: CarryItem[] | undefined
      if (patch.carryItems) {
        normalized = []
        for (const item of patch.carryItems) {
          const checked = validateCarryPath(item.path)
          // 하나라도 잘못되면 패치 전체를 거부한다 — 일부만 저장되면 사용자가 본 화면과
          // 실제 저장된 값이 어긋난다.
          if (!checked.ok) return { error: `“${item.path}”: ${checked.reason}` }
          normalized.push({ path: checked.path, mode: item.mode })
        }
      }

      store.update((st) => {
        const repo = st.repos.find((r) => r.id === repoId)
        if (repo) Object.assign(repo, patch, normalized ? { carryItems: normalized } : {})
      })
      broadcastState()
      return {}
    }
  )

  /**
   * 전달 목록이 빈 리포에 후보를 한 번에 등록하고, 지정된 worktree 로도 즉시 전달한다.
   * 구버전(v11 이하)부터 쓰던 리포는 마이그레이션이 carryItems 를 빈 배열로 남겨 둬서
   * 신규 리포와 달리 자동 탐지 혜택을 못 받았다 — 그 구멍을 사용자 동의 한 번으로 메운다.
   */
  ipcMain.handle(
    IPC.repoAdoptCarry,
    async (
      _e,
      repoId: string,
      workspaceId?: string
    ): Promise<{ error?: string; added: string[]; carryFailures?: CarryFailure[] }> => {
      const repo = repoFor(repoId)
      if (!repo) return { error: 'Repository not found.', added: [] }

      const detected = detectCarryItems(repo.path)
      if (detected.length === 0) return { added: [] }

      // 이미 등록된 경로는 사용자의 선택(모드 포함)을 존중해 건드리지 않고, 없는 것만 더한다.
      const existing = new Set(repo.carryItems.map((i) => i.path))
      const fresh = detected.filter((i) => !existing.has(i.path))
      if (fresh.length === 0) return { added: [] }

      store.update((st) => {
        const r = st.repos.find((x) => x.id === repoId)
        if (r) r.carryItems = [...r.carryItems, ...fresh]
      })
      broadcastState()

      // 제안이 뜬 계기가 된 worktree 는 이미 만들어져 있으므로, 설정만 고치면 그 워크스페이스는
      // 여전히 파일이 없는 상태로 남는다. 지금 바로 채워 준다(carryIntoWorktree 는 이미 있는
      // 파일을 덮어쓰지 않으므로 반복 호출해도 안전하다).
      let carryFailures: CarryFailure[] | undefined
      const ws = workspaceId
        ? store.getState().workspaces.find((w) => w.id === workspaceId && !w.archived)
        : null
      if (ws) {
        const { carried, failures } = carryIntoWorktree(repo.path, ws.worktreePath, fresh)
        await applyCarryExcludes(ws.worktreePath, carried)
        if (failures.length > 0) carryFailures = failures
      }

      return { added: fresh.map((i) => i.path), carryFailures }
    }
  )

  ipcMain.handle(IPC.repoRemove, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    const workspaces = store.getState().workspaces.filter((w) => w.repoId === repoId)
    for (const ws of workspaces) {
      ctx.sessions.dispose(ws.id)
      ctx.scripts.disposeWorkspace(ws.id)
      ctx.terminals.disposeWorkspace(ws.id)
      getTranscripts().remove(ws.id)
      if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, false)
    }
    store.update((st) => {
      st.workspaces = st.workspaces.filter((w) => w.repoId !== repoId)
      st.repos = st.repos.filter((r) => r.id !== repoId)
    })
    broadcastState()
  })

  // 리포·워크스페이스 목록은 저장된 배열 순서가 곧 사이드바 표시 순서라, 재정렬은
  // 별도 order 필드 없이 배열을 다시 엮는 것으로 끝난다(스키마 변경·마이그레이션 불필요).
  ipcMain.handle(
    IPC.repoReorder,
    (_e, repoId: string, targetRepoId: string, position: DropPosition) => {
      store.update((st) => {
        st.repos = reorderById(st.repos, repoId, targetRepoId, position)
      })
      broadcastState()
    }
  )

  ipcMain.handle(
    IPC.workspaceReorder,
    (_e, workspaceId: string, targetWorkspaceId: string, position: DropPosition) => {
      const { workspaces } = store.getState()
      const dragged = workspaces.find((w) => w.id === workspaceId)
      const target = workspaces.find((w) => w.id === targetWorkspaceId)
      if (!dragged || !target) return

      // 사이드바는 워크스페이스를 orderByStack 의 DFS 결과로 그리므로, 배열 순서가 실제 표시
      // 순서를 좌우하는 범위는 "같은 부모를 둔 형제들 사이"뿐이다. 그 밖의 조합(다른 레포·다른
      // stack 부모)은 배열만 흔들고 화면은 그대로여서 사용자에게 아무 일도 안 일어난 것처럼 보인다.
      // 부모를 바꾸는 건 stack 의 베이스 브랜치를 갈아 끼우는 git 작업이라 드래그로 다루지 않는다.
      // 렌더러도 같은 규칙으로 드롭을 막지만, IPC 는 신뢰 경계이므로 여기서 다시 확인한다.
      if (dragged.repoId !== target.repoId) return
      if ((dragged.parentWorkspaceId ?? null) !== (target.parentWorkspaceId ?? null)) return
      if (dragged.archived !== target.archived) return

      store.update((st) => {
        st.workspaces = reorderById(st.workspaces, workspaceId, targetWorkspaceId, position)
      })
      broadcastState()
    }
  )

  ipcMain.handle(IPC.repoListBranches, async (_e, repoId: string): Promise<string[]> => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listBranches(repo.path).catch(() => [repo.defaultBranch])
  })

  // ── workspace ────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.workspaceCreate,
    async (
      _e,
      args: CreateWorkspaceArgs
    ): Promise<{
      workspaceId?: string
      name?: string
      branch?: string
      error?: string
      carryFailures?: CarryFailure[]
      carrySuggestions?: string[]
    }> => {
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

      // 셋업 스크립트보다 먼저 — 셋업이 전달된 .env·node_modules 를 볼 수 있어야 한다.
      const carryFailures = await carryIntoNewWorktree(repo, worktreePath)

      const settings = store.getState().settings
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
          agentBackend: DEFAULT_AGENT_BACKEND,
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
          permissionMode: settings.defaultPermissionMode,
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
      broadcastState()

      // 셋업 스크립트가 설정돼 있으면 생성 직후 실행(dev 와 같은 포트 env 를 주입).
      if (repo.setupScript.trim()) {
        ctx.scripts.run(id, 'setup', repo.setupScript, worktreePath, scriptEnvFor(devPort))
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
  )

  // 아카이브: 세션·스크립트를 정리하고 worktree 디렉토리를 제거하되 브랜치·대화 기록·세션 ID 는
  // 유지한다 (언아카이브 시 worktree 를 다시 만들고 같은 세션을 이어갈 수 있다).
  ipcMain.handle(IPC.workspaceArchive, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const repo = repoFor(ws.repoId)

    ctx.sessions.dispose(workspaceId)
    ctx.scripts.disposeWorkspace(workspaceId)
    ctx.terminals.disposeWorkspace(workspaceId)
    // 아카이브 스크립트는 worktree 가 아직 살아 있을 때 실행한다.
    if (repo?.archiveScript.trim()) {
      await ctx.scripts.runOnce(repo.archiveScript, ws.worktreePath)
    }
    // override 가 없으면 현재 표시 이름(PR 제목 등)을 worktree 제거 전에 보존한다.
    // 아카이브 후에는 worktree·PR 조회가 불가능하므로, 같은 이름을 유지하려면 지금 스냅샷해야 한다.
    let snapshotName: string | null = null
    if (!ws.displayName?.trim()) {
      const pr = await getPrStatus(ws.worktreePath).catch(() => null)
      if (pr?.title?.trim()) snapshotName = pr.title.trim()
    }
    if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, false)

    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) {
        w.archived = true
        w.status = 'idle'
        if (snapshotName && !w.displayName?.trim()) w.displayName = snapshotName
      }
    })
    broadcastState()
  })

  // 언아카이브: 브랜치로부터 worktree 를 복원한다.
  ipcMain.handle(
    IPC.workspaceUnarchive,
    async (
      _e,
      workspaceId: string
    ): Promise<{
      error?: string
      carryFailures?: CarryFailure[]
      carrySuggestions?: string[]
    }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      const repo = repoFor(ws.repoId)
      if (!repo) return { error: 'Repository not found.' }

      try {
        await addWorktree(repo.path, ws.branch, ws.baseBranch, ws.worktreePath)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
      // 언아카이브도 worktree 를 새로 만드는 경로다 — 전달을 빠뜨리면 복원된 워크스페이스만
      // 지침 파일 없이 동작하게 된다.
      const carryFailures = await carryIntoNewWorktree(repo, ws.worktreePath)
      // worktree 가 복원됐으니 PR 조회가 다시 가능하다. 보존했던 표시 이름이 현재 PR 제목과
      // 같다면(= 아카이브 시 자동 스냅샷한 값) override 를 지워 기본 규칙을 되살린다.
      // 사용자가 직접 지정한 이름은 PR 제목과 다르므로 그대로 유지된다.
      if (ws.displayName?.trim()) {
        const pr = await getPrStatus(ws.worktreePath).catch(() => null)
        if (pr?.title?.trim() === ws.displayName.trim()) {
          store.update((st) => {
            const w = st.workspaces.find((x) => x.id === workspaceId)
            if (w) w.displayName = null
          })
        }
      }
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w) w.archived = false
      })
      broadcastState()
      return { carryFailures, carrySuggestions: carrySuggestionsFor(repo) }
    }
  )

  ipcMain.handle(IPC.workspaceRemove, async (_e, workspaceId: string, deleteBranch: boolean) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const repo = repoFor(ws.repoId)

    ctx.sessions.dispose(workspaceId)
    ctx.scripts.disposeWorkspace(workspaceId)
    ctx.terminals.disposeWorkspace(workspaceId)
    getTranscripts().remove(workspaceId)
    if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, deleteBranch)

    store.update((st) => {
      st.workspaces = st.workspaces.filter((w) => w.id !== workspaceId)
    })
    broadcastState()
  })

  // 일괄 삭제: 한 레포의 아카이브된 워크스페이스를 모두 영구 제거한다.
  // 단건 remove 와 동일한 정리 절차(세션·스크립트·터미널·기록·worktree·브랜치)를 각 항목에
  // 적용하되, 상태 갱신·broadcast 는 마지막에 한 번만 수행한다.
  ipcMain.handle(
    IPC.workspaceRemoveArchived,
    async (_e, repoId: string): Promise<{ count: number }> => {
      const targets = store.getState().workspaces.filter((w) => w.repoId === repoId && w.archived)
      const repo = repoFor(repoId)

      for (const ws of targets) {
        ctx.sessions.dispose(ws.id)
        ctx.scripts.disposeWorkspace(ws.id)
        ctx.terminals.disposeWorkspace(ws.id)
        getTranscripts().remove(ws.id)
        // 아카이브된 워크스페이스는 worktree 디렉토리가 이미 제거된 상태일 수 있으나,
        // removeWorktree 는 누락된 worktree 를 prune 으로 정리하므로 안전하다. 브랜치도 함께 삭제.
        if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, true)
      }

      if (targets.length > 0) {
        const ids = new Set(targets.map((w) => w.id))
        store.update((st) => {
          st.workspaces = st.workspaces.filter((w) => !ids.has(w.id))
        })
        broadcastState()
      }
      return { count: targets.length }
    }
  )

  ipcMain.handle(
    IPC.workspaceSetPermissionMode,
    async (_e, workspaceId: string, mode: PermissionMode) => {
      await ctx.sessions.setPermissionMode(workspaceId, mode)
      broadcastState()
    }
  )

  ipcMain.handle(IPC.workspaceSetModel, (_e, workspaceId: string, model: string | null) => {
    ctx.sessions.setModel(workspaceId, model)
    broadcastState()
  })

  ipcMain.handle(
    IPC.workspaceSetEffort,
    (_e, workspaceId: string, effort: EffortSetting | null) => {
      ctx.sessions.setEffort(workspaceId, effort)
      broadcastState()
    }
  )

  ipcMain.handle(IPC.workspaceSetFastMode, (_e, workspaceId: string, fastMode: boolean | null) => {
    ctx.sessions.setFastMode(workspaceId, fastMode)
    broadcastState()
  })

  ipcMain.handle(IPC.workspaceSetMuted, (_e, workspaceId: string, muted: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.muted = muted
    })
    broadcastState()
  })

  // 표시 이름 수정: 사용자 override(displayName)만 바꾼다. worktree 이름(name)·브랜치는 그대로 둔다.
  // 빈 문자열을 넘기면 override 를 지워 기본 규칙(worktree 이름 → PR 제목)으로 되돌린다.
  ipcMain.handle(IPC.workspaceRename, (_e, workspaceId: string, name: string) => {
    const trimmed = name.trim()
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.displayName = trimmed || null
    })
    broadcastState()
  })

  ipcMain.handle(IPC.workspaceRevealInFinder, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (ws) shell.openPath(ws.worktreePath)
  })

  ipcMain.handle(IPC.workspaceOpenInEditor, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return

    // VS Code 의 `code` CLI 를 best-effort 로 호출, 실패하면 Finder 로 폴백.
    // 경로는 positional 인자($1)로 넘겨 셸 보간을 거치지 않는다 — 리포 폴더명에
    // 셸 메타문자가 섞여도 명령으로 해석되지 않는다. PATH 확보를 위해 로그인 셸은 유지.
    const loginShell = process.env.SHELL || '/bin/zsh'
    const proc = spawn(loginShell, ['-lc', 'code "$1"', loginShell, ws.worktreePath])
    proc.on('error', () => shell.openPath(ws.worktreePath))
    proc.on('exit', (code) => {
      if (code !== 0) shell.openPath(ws.worktreePath)
    })
  })

  // /memory — worktree 의 CLAUDE.md 를 에디터로 연다. 파일이 없으면 worktree 디렉토리를 열어
  // 사용자가 새로 만들 수 있게 한다(VS Code `code`, 실패 시 Finder 폴백).
  ipcMain.handle(IPC.workspaceOpenMemory, (_e, workspaceId: string): { error?: string } => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { error: 'Workspace not found.' }

    const memoryPath = join(ws.worktreePath, 'CLAUDE.md')
    const target = existsSync(memoryPath) ? memoryPath : ws.worktreePath
    const loginShell = process.env.SHELL || '/bin/zsh'
    const proc = spawn(loginShell, ['-lc', 'code "$1"', loginShell, target])
    proc.on('error', () => shell.openPath(ws.worktreePath))
    proc.on('exit', (code) => {
      if (code !== 0) shell.openPath(ws.worktreePath)
    })
    return {}
  })

  // ── 채팅 ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.chatSend,
    (_e, workspaceId: string, text: string, images?: ImageAttachment[]) => {
      ctx.sessions.sendMessage(workspaceId, text, images)
    }
  )

  ipcMain.handle(IPC.chatInterrupt, (_e, workspaceId: string) => {
    return ctx.sessions.interrupt(workspaceId)
  })

  ipcMain.handle(IPC.chatSideQuestion, (_e, workspaceId: string, question: string) => {
    ctx.sessions.sideQuestion(workspaceId, question)
  })

  // /clear — 세션을 정리하고 대화 맥락(sessionId)·트랜스크립트를 비운다(워크스페이스는 유지).
  // 다음 메시지는 빈 맥락의 새 세션으로 시작한다. 렌더러는 호출 후 자기 트랜스크립트를 비운다.
  ipcMain.handle(IPC.chatClear, (_e, workspaceId: string) => {
    ctx.sessions.clearSession(workspaceId)
    getTranscripts().remove(workspaceId)
    broadcastState()
  })

  ipcMain.handle(IPC.chatGetHistory, (_e, workspaceId: string) => {
    return getTranscripts().load(workspaceId)
  })

  ipcMain.handle(IPC.permissionRespond, (_e, requestId: string, decision: PermissionDecision) => {
    ctx.sessions.respondPermission(requestId, decision)
  })

  // ── 스크립트 ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.scriptRun, async (_e, workspaceId: string, kind: ScriptKind) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const repo = repoFor(ws.repoId)
    if (!repo) return
    const command = kind === 'setup' ? repo.setupScript : repo.devScript
    // 고유 포트를 env(PORT/WOOI_DEV_PORT)로 주입한다. 레거시 workspace 는 여기서 lazy 배정.
    let port = await ensureDevPort(workspaceId)

    // dev 서버는 실제로 포트를 바인딩하므로, 배정된 포트가 며칠 전 값이라 그 사이 다른 프로세스가
    // 차지했을 수 있다. 실행 직전에 실제 가용성을 확인하고, 외부 프로세스가 점유 중이면 비어 있는
    // 포트로 재배정해 bind 실패를 막는다. 이 워크스페이스 자신의 이전 dev 가 같은 포트를 잡고 있을
    // 수 있으므로 먼저 종료하고 잠깐 기다린다 — 자기 포트를 외부 점유로 오인해 매번 바꾸지 않도록.
    if (kind === 'dev' && port != null) {
      ctx.scripts.stop(workspaceId, 'dev')
      const freed = await waitForPortFree(port, 1500)
      if (!freed) {
        const used = new Set<number>(
          store
            .getState()
            .workspaces.map((w) => w.devPort)
            .filter((p): p is number => typeof p === 'number')
        )
        // 외부 점유 중인 현재 포트는 findFreePort 의 OS 프로브에서 자동으로 걸러진다.
        const next = await findFreePort(used)
        store.update((st) => {
          const w = st.workspaces.find((x) => x.id === workspaceId)
          if (w) w.devPort = next
        })
        port = next
      }
    }

    const env = port != null ? scriptEnvFor(port) : undefined
    if (env) broadcastState()
    ctx.scripts.run(workspaceId, kind, command, ws.worktreePath, env)
  })

  ipcMain.handle(IPC.scriptStop, (_e, workspaceId: string, kind: ScriptKind) => {
    ctx.scripts.stop(workspaceId, kind)
  })

  ipcMain.handle(IPC.scriptGetStatus, (_e, workspaceId: string) => {
    return ctx.scripts.getStatus(workspaceId)
  })

  // ── git ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.gitStatus, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return getStatus(ws.worktreePath, ws.baseBranch).catch(() => null)
  })

  ipcMain.handle(IPC.gitDiff, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return getDiff(ws.worktreePath, ws.baseBranch).catch(() => null)
  })

  // base 브랜치를 현재 브랜치로 머지해 드리프트를 해소한다(충돌 시 워킹트리에 충돌이 남는다).
  ipcMain.handle(
    IPC.gitUpdateFromBase,
    async (_e, workspaceId: string): Promise<UpdateFromBaseResult> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) {
        return { status: 'error', baseBranch: '', message: 'Workspace not found.' }
      }
      return updateFromBase(ws.worktreePath, ws.baseBranch).catch((err) => ({
        status: 'error' as const,
        baseBranch: ws.baseBranch,
        message: err instanceof Error ? err.message : String(err)
      }))
    }
  )

  ipcMain.handle(IPC.gitAbortMerge, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    await abortMerge(ws.worktreePath).catch(() => {})
  })

  /**
   * 모델 B 스택(단일 worktree · N 브랜치)을 아래→위로 순차 rebase 한다. 각 상위 브랜치를 이전
   * tip 기준으로 `--onto` 재배치해(중복 커밋 없이) 정확히 옮긴다. 충돌/dirty 시 그 브랜치에 멈춰
   * worktree 를 남겨 두고 결과를 돌려준다. 성공하면 원래 체크아웃 브랜치로 되돌아온다.
   */
  const restackWholeStack = async (
    worktreePath: string,
    stack: StackedBranch[],
    returnTo: string
  ): Promise<RestackResult> => {
    if (!(await isWorktreeClean(worktreePath))) {
      return {
        status: 'dirty',
        baseBranch: '',
        message: 'Commit or stash your changes before restacking the stack.'
      }
    }
    // rebase 시작 전, 각 스택 브랜치의 현재 tip 을 잡아 둔다(상위 브랜치의 --onto oldBase 로 쓴다).
    const oldTip = new Map<string, string>()
    for (const e of stack) {
      const sha = await revParse(worktreePath, e.branch)
      if (sha) oldTip.set(e.branch, sha)
    }
    let anyChanged = false
    for (const entry of stack) {
      const co = await checkoutBranch(worktreePath, entry.branch)
      if (co.error) return { status: 'error', baseBranch: entry.baseBranch, message: co.error }
      // base 가 다른 스택 멤버면(=상위 브랜치) 그 base 의 이전 tip 을 oldBase 로 넘겨 정확히 재배치한다.
      const oldBase = oldTip.get(entry.baseBranch)
      const res = await restackOnto(worktreePath, entry.baseBranch, oldBase).catch((err) => ({
        status: 'error' as const,
        baseBranch: entry.baseBranch,
        message: err instanceof Error ? err.message : String(err)
      }))
      if (res.status === 'conflict' || res.status === 'error' || res.status === 'dirty') return res
      if (res.status === 'restacked') anyChanged = true
    }
    await checkoutBranch(worktreePath, returnTo).catch(() => {})
    return { status: anyChanged ? 'restacked' : 'up-to-date', baseBranch: '' }
  }

  // stacked 브랜치를 최신 base 위로 rebase·force-push 한다. 모델 B 스택이면 전체를 아래→위로 순차 처리.
  ipcMain.handle(IPC.workspaceRestack, async (_e, workspaceId: string): Promise<RestackResult> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) {
      return { status: 'error', baseBranch: '', message: 'Workspace not found.' }
    }
    if (ws.status === 'running') {
      return {
        status: 'error',
        baseBranch: ws.baseBranch,
        message: 'The agent is running — wait for it to finish before restacking.'
      }
    }
    if (ws.stack && ws.stack.length > 1) {
      return restackWholeStack(ws.worktreePath, ws.stack, ws.branch)
    }
    return restackOnto(ws.worktreePath, ws.baseBranch).catch((err) => ({
      status: 'error' as const,
      baseBranch: ws.baseBranch,
      message: err instanceof Error ? err.message : String(err)
    }))
  })

  // 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요).
  ipcMain.handle(
    IPC.workspaceSwitchBranch,
    async (_e, workspaceId: string, branch: string): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      if (branch === ws.branch) return {}
      const entry = workspaceStack(ws).find((e) => e.branch === branch)
      if (!entry) return { error: `"${branch}" is not part of this stack.` }
      if (ws.status === 'running') {
        return { error: 'The agent is running — wait for it to finish before switching branches.' }
      }
      const res = await checkoutBranch(ws.worktreePath, branch)
      if (res.error) return res
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        w.branch = entry.branch
        w.baseBranch = entry.baseBranch
        w.prNumber = entry.prNumber
      })
      broadcastState()
      return {}
    }
  )

  // 발견한 PR 번호를 워크스페이스(현재 브랜치면 top-level)와, 해당 브랜치의 스택 엔트리에 영속한다.
  // stacked 관계·병합 캐스케이드가 브랜치 이름 대신 안정적인 PR 번호로 대상을 식별할 수 있게 한다.
  const persistPrNumber = (workspaceId: string, branch: string, prNumber: number): void => {
    let changed = false
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      if (w.branch === branch && w.prNumber !== prNumber) {
        w.prNumber = prNumber
        changed = true
      }
      const entry = w.stack?.find((e) => e.branch === branch)
      if (entry && entry.prNumber !== prNumber) {
        entry.prNumber = prNumber
        changed = true
      }
    })
    if (changed) broadcastState()
  }

  /** 대기 중이던 동기화 계획을 지운다(캐스케이드가 실행됐거나 사용자가 무시했을 때). */
  const clearStackSync = (workspaceId: string, alsoDismissal = false): void => {
    let changed = false
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      if (w.stackSync) {
        w.stackSync = null
        changed = true
      }
      // 캐스케이드를 실제로 실행했으면 "무시" 기억도 지운다(다음 병합은 다시 알려야 한다).
      if (alsoDismissal && w.stackSyncDismissed) {
        w.stackSyncDismissed = null
        changed = true
      }
    })
    if (changed) broadcastState()
  }

  /**
   * "이미 병합된 부모"를 찾아 캐스케이드 계획을 만든다.
   *
   * 병합은 wooi·`gh pr merge`·GitHub 웹 어디서든 일어날 수 있는 교체 가능한 행위라, 감지를 여기
   * 한 곳에 모은다. 예전에는 캐스케이드가 IPC.prMerge 핸들러 안에만 있어서, wooi 로 병합할 때만
   * 돌고 외부 병합은 통째로 놓쳤다(스택은 stale 한 채 방치). 이제는 어디서 병합했든 이 재동기화
   * 지점이 똑같이 잡아낸다.
   *
   * 감지만 하고 실행은 하지 않는다. 캐스케이드는 자식 브랜치를 rebase 한 뒤 force-push 하므로,
   * 병합 행위에 딸려 자동으로 나가면 안 된다. 계획을 워크스페이스에 얹어 UI 가 승인을 받게 한다.
   *
   * 비용: 후보가 있을 때만 gh 를 추가 호출하고, 계획이 이미 있으면 다시 조회하지 않는다
   * (재동기화는 PR 상태 갱신마다 돈다).
   */
  const detectStackSync = async (
    ws: Workspace,
    prs: Array<{ number: number; head: string; base: string }>
  ): Promise<StackSyncPlan | null> => {
    if (ws.stackSync) return ws.stackSync // 이미 대기 중 — 사용자가 처리하거나 무시할 때까지 유지.
    const openHeads = new Set(prs.map((p) => p.head))
    const dismissed = ws.stackSyncDismissed ?? null

    // ── 모델 B: worktree 안 브랜치 스택 ────────────────────────────────────
    const stack = ws.stack
    if (stack && stack.length > 1) {
      // 맨 위 엔트리가 병합된 건 캐스케이드 대상이 아니므로 length-1 까지만 본다.
      for (let i = 0; i < stack.length - 1; i++) {
        const e = stack[i]
        if (e.branch === dismissed) continue
        if (openHeads.has(e.branch)) continue // 아직 열려 있음 → 병합되지 않았다.
        const meta = await getPrMeta(ws.worktreePath, e.prNumber ?? e.branch).catch(() => null)
        if (!meta || meta.state !== 'MERGED') continue

        // 이 브랜치를 직속 base 로 삼던 엔트리들이 옮겨갈 대상이다.
        // 새 base 는 병합 시점의 실제 base(meta.baseRefName)를 권위 있는 값으로 쓴다.
        const affected: StackSyncPlan['affected'] = []
        for (const a of stack.slice(i + 1)) {
          if (a.baseBranch !== e.branch) continue
          const am = await getPrMeta(ws.worktreePath, a.prNumber ?? a.branch).catch(() => null)
          affected.push({
            branch: a.branch,
            prNumber: am?.number ?? a.prNumber,
            // base 브랜치가 삭제되면 GitHub 이 자식 PR 을 닫아 버린다 — 복구 단계가 필요하다.
            prClosed: am?.state === 'CLOSED'
          })
        }
        if (!affected.length) continue

        return {
          mergedBranch: e.branch,
          newBase: meta.baseRefName,
          affected,
          detectedAt: Date.now()
        }
      }
    }

    // ── 모델 A: 자식이 각자 별도 worktree 를 가진 스택 ──────────────────────
    // 이 워크스페이스 자신의 PR 이 병합됐고 살아 있는 자식이 있으면, 자식들을 조부모로 옮겨야 한다.
    const children = store
      .getState()
      .workspaces.filter((w) => w.parentWorkspaceId === ws.id && !w.archived)
    if (children.length && ws.branch !== dismissed && !openHeads.has(ws.branch)) {
      const meta = await getPrMeta(ws.worktreePath, ws.prNumber ?? ws.branch).catch(() => null)
      if (meta && meta.state === 'MERGED') {
        const affected: StackSyncPlan['affected'] = []
        for (const c of children) {
          const cm = await getPrMeta(c.worktreePath, c.prNumber ?? c.branch).catch(() => null)
          affected.push({
            branch: c.branch,
            prNumber: cm?.number ?? c.prNumber,
            prClosed: cm?.state === 'CLOSED'
          })
        }
        return {
          mergedBranch: ws.branch,
          newBase: meta.baseRefName,
          affected,
          detectedAt: Date.now()
        }
      }
    }

    return null
  }

  /**
   * worktree 의 실제 git/PR 상태에서 워크스페이스의 현재 브랜치와 브랜치 스택(모델 B)을 재동기화한다.
   * 에이전트가 UI 의 Split 을 거치지 않고 직접 `git checkout -b`·`gh pr create` 로 스택을 만든 경우에도
   * wooi 가 이를 인식하도록, HEAD 를 반영하고 열린 PR 의 base 체인에서 스택을 감지해 반영한다.
   * git 을 변경하지 않고 상태만 갱신하므로 에이전트 실행 중에도 안전하다. 변경이 있으면 방송한다.
   */
  const reconcileWorkspaceStack = async (workspaceId: string): Promise<void> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    const head = await currentBranch(ws.worktreePath).catch(() => '')
    // 리포 단위로 묶어 조회한다 — 같은 리포의 워크스페이스를 연달아 재동기화할 때(PR 상태 전체
    // 훑기) 완전히 같은 목록을 워크스페이스 수만큼 다시 받아오지 않는다.
    const prs = await listOpenPrs(ws.worktreePath, ws.repoId).catch(() => [])
    // 다른 워크스페이스(모델 A 스택 포함)가 소유한 브랜치는 이 스택의 경계로 취급한다.
    const exclude = new Set<string>()
    for (const other of store.getState().workspaces) {
      if (other.id === ws.id || other.repoId !== ws.repoId || other.archived) continue
      for (const e of workspaceStack(other)) exclude.add(e.branch)
    }
    // HEAD → 원래 브랜치 순으로 anchor 를 시도해 스택을 복원한다.
    let detected: StackedBranch[] | null = null
    for (const anchor of [head, ws.branch].filter(Boolean)) {
      detected = buildStackFromPrs(anchor, prs, exclude)
      if (detected) break
    }
    const headPr = prs.find((p) => p.head === head)
    // 외부에서 부모 PR 이 병합됐는지 감지한다(감지만 — 실행은 사용자 승인 후).
    const plan = await detectStackSync(ws, prs).catch(() => null)

    let changed = false
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      // 실제 HEAD 로 현재 브랜치를 맞춘다(에이전트가 브랜치를 옮겼을 수 있다).
      if (head && w.branch !== head) {
        w.branch = head
        changed = true
      }
      if ((w.stackSync?.mergedBranch ?? null) !== (plan?.mergedBranch ?? null)) {
        w.stackSync = plan
        changed = true
      }
      // 대기 중인 계획이 있는 동안에는 기록된 스택을 그대로 보존한다. detected 는 "열린 PR" 로만
      // 만들어져 병합된 엔트리가 이미 빠져 있으므로, 지금 덮어쓰면 캐스케이드가 대상 브랜치를 잃는다.
      if (!plan && detected) {
        // 감지한 스택이 저장값과 다르면 반영한다(브랜치·base·PR번호).
        const same =
          w.stack &&
          w.stack.length === detected.length &&
          detected.every(
            (e, i) =>
              w.stack![i].branch === e.branch &&
              w.stack![i].baseBranch === e.baseBranch &&
              w.stack![i].prNumber === e.prNumber
          )
        if (!same) {
          w.stack = detected
          changed = true
        }
        const cur = detected.find((e) => e.branch === w.branch)
        if (cur) {
          if (w.baseBranch !== cur.baseBranch) {
            w.baseBranch = cur.baseBranch
            changed = true
          }
          if (w.prNumber !== cur.prNumber) {
            w.prNumber = cur.prNumber
            changed = true
          }
        }
      } else if (headPr && w.baseBranch !== headPr.base) {
        // 스택은 아니지만 현재 브랜치의 PR base 가 다르면 맞춘다(ahead/behind 정확도).
        w.baseBranch = headPr.base
        changed = true
      }
    })
    if (changed) broadcastState()
  }

  ipcMain.handle(IPC.prStatus, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    // 실제 git/PR 상태에서 현재 브랜치·스택을 먼저 재동기화한다(에이전트가 직접 만든 스택도 인식).
    await reconcileWorkspaceStack(workspaceId).catch(() => {})
    // worktree 의 현재 브랜치에 연결된 PR (gh 가 현재 브랜치로 자동 조회).
    const after = store.getState().workspaces.find((w) => w.id === workspaceId) ?? ws
    const status = await getPrStatus(after.worktreePath).catch(() => null)
    if (status) persistPrNumber(workspaceId, after.branch, status.number)
    return status
  })

  // 모델 B 스택 조망: 현재 체크아웃되지 않은 브랜치의 PR 상태도 조회한다.
  ipcMain.handle(IPC.prStatusForBranch, async (_e, workspaceId: string, branch: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    const status = await getPrStatus(ws.worktreePath, branch).catch(() => null)
    if (status) persistPrNumber(workspaceId, branch, status.number)
    return status
  })

  ipcMain.handle(
    IPC.prCreate,
    async (_e, workspaceId: string, branch?: string): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      const repo = repoFor(ws.repoId)
      // branch 를 주면(모델 B: 현재 체크아웃되지 않은 스택 브랜치) 그 엔트리를, 없으면 현재 브랜치를 대상으로 한다.
      const entry = branch ? workspaceStack(ws).find((e) => e.branch === branch) : null
      const targetBranch = entry ? entry.branch : ws.branch
      const targetBase = entry ? entry.baseBranch : ws.baseBranch
      // base 가 리포 기본 브랜치가 아니면(=stacked) --base 로 명시한다. head 는 현재 브랜치가 아닐 때만 붙인다.
      const base = repo && targetBase !== repo.defaultBranch ? targetBase : undefined
      const head = targetBranch !== ws.branch ? targetBranch : undefined
      return createPrWeb(ws.worktreePath, { base, head }).catch((err) => ({
        error: err instanceof Error ? err.message : String(err)
      }))
    }
  )

  // ── PR 라이프사이클 액션 (merge / close / reopen / ready) ────────────────
  // merge 는 UI 가 보여 준 PR 번호를 명시적으로 넘기고, 나머지는 worktree 현재 브랜치의 PR 을 쓴다.

  /**
   * 병합된 브랜치를 부모로 삼던 자식들을 조부모로 옮기는 캐스케이드(모델 A + 모델 B 공통).
   * 사용자가 배너에서 승인했을 때만 호출된다 — rebase 후 force-push 가 나가기 때문이다.
   * 모든 단계 결과를 모아 돌려주므로 호출부는 실패를 사용자에게 노출할 수 있다.
   *
   * newBase 는 계획이 GitHub 에서 읽어 온 병합 시점의 실제 base 다. 저장된 ws.baseBranch 는
   * 그 사이 리타겟 등으로 어긋나 있을 수 있어 권위 있는 값으로 쓰지 않는다.
   */
  const runMergeCascade = async (
    workspaceId: string,
    mergedBranch: string,
    newBase: string
  ): Promise<StackCascadeResult> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { steps: [] }
    const steps: StackCascadeStep[] = []

    // ── 모델 A: 자식이 각자 별도 worktree 를 가진 경우 ──────────────────────
    // 병합된 워크스페이스를 부모로 삼던 자식들의 PR base 를 조부모로 옮기고, 그 위로 rebase 한다.
    const grandparentBranch = newBase
    const grandparentId = ws.parentWorkspaceId
    const children = store
      .getState()
      .workspaces.filter((w) => w.parentWorkspaceId === ws.id && !w.archived)
    for (const child of children) {
      steps.push(
        ...(await cascadeRetarget({
          worktreePath: child.worktreePath,
          mergedBranch,
          newBase: grandparentBranch,
          entries: [{ branch: child.branch, baseBranch: mergedBranch, prNumber: child.prNumber }]
        }))
      )
      store.update((st) => {
        const c = st.workspaces.find((x) => x.id === child.id)
        if (c) {
          c.parentWorkspaceId = grandparentId
          c.baseBranch = grandparentBranch
        }
      })
      const r = await restackOnto(child.worktreePath, grandparentBranch, mergedBranch).catch(
        (err): RestackResult => ({
          status: 'error',
          baseBranch: grandparentBranch,
          message: err instanceof Error ? err.message : String(err)
        })
      )
      steps.push(stepFromRestack(child.branch, child.prNumber, r))
    }
    if (children.length) broadcastState()

    // ── 모델 B: 단일 worktree 안 브랜치 스택 ────────────────────────────────
    const stack = ws.stack
    if (stack && stack.length > 1 && stack.some((e) => e.branch === mergedBranch)) {
      const idx = stack.findIndex((e) => e.branch === mergedBranch)
      // 기록된 base 보다 GitHub 이 알려 준 병합 시점 base 를 우선한다(기록은 어긋나 있을 수 있다).
      const mergedBase = newBase || stack[idx].baseBranch
      const above = stack.slice(idx + 1)

      // PR 쪽(retarget·닫힌 PR 복구)은 워킹트리 상태와 무관하므로 항상 시도한다.
      steps.push(
        ...(await cascadeRetarget({
          worktreePath: ws.worktreePath,
          mergedBranch,
          newBase: mergedBase,
          entries: above
        }))
      )
      // git 히스토리 쪽(rebase + force-push).
      steps.push(
        ...(await cascadeRestackBranchStack({
          worktreePath: ws.worktreePath,
          mergedBranch,
          newBase: mergedBase,
          entries: above,
          allEntries: stack
        }))
      )

      // 스택에서 병합 엔트리를 제거하고 링크를 갱신한다.
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w || !w.stack) return
        const i = w.stack.findIndex((e) => e.branch === mergedBranch)
        if (i < 0) return
        const base = w.stack[i].baseBranch
        for (const e of w.stack) if (e.baseBranch === mergedBranch) e.baseBranch = base
        w.stack.splice(i, 1)
        if (w.stack.length <= 1) w.stack = undefined
      })
      // 현재 브랜치가 방금 제거된 병합 브랜치면, 실제 HEAD 를 읽어 top-level 미러를 맞춘다.
      const head = await currentBranch(ws.worktreePath).catch(() => '')
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        const entry = workspaceStack(w).find((e) => e.branch === head)
        if (entry) {
          w.branch = entry.branch
          w.baseBranch = entry.baseBranch
          w.prNumber = entry.prNumber
        }
      })
      broadcastState()
    }

    return { steps }
  }

  /**
   * PR 을 병합한다. 병합만 한다 — 스택 캐스케이드(리타겟·rebase·force-push)는 여기 딸려 오지 않는다.
   *
   * 병합은 wooi 말고도 `gh pr merge`·GitHub 웹에서 얼마든지 일어난다. 캐스케이드를 병합 핸들러에
   * 묶으면 "어디서 병합했느냐"에 따라 동작이 갈리고(= 원래 버그), 무엇보다 병합 승인 한 번으로
   * 자식 브랜치의 리모트 히스토리를 되쓰는 force-push 까지 나가 버린다.
   * 그래서 병합 후에는 재동기화만 돌려 캐스케이드 계획을 띄우고, 실행은 사용자 승인에 맡긴다.
   */
  ipcMain.handle(
    IPC.prMerge,
    async (_e, workspaceId: string, method: PrMergeMethod): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      // UI 가 보여 준 PR 을 그대로 병합한다 — 번호를 알면 명시적으로 넘겨, 그 사이 에이전트가
      // 브랜치를 옮겼더라도 엉뚱한 PR 이 병합되지 않게 한다.
      const result = await mergePr(ws.worktreePath, method, ws.prNumber ?? undefined).catch(
        (err) => ({ error: err instanceof Error ? err.message : String(err) })
      )
      if (result.error) return result
      // 방금 병합으로 스택이 stale 해졌으면 계획을 만들어 배너로 알린다(외부 병합과 같은 경로).
      await reconcileWorkspaceStack(workspaceId).catch(() => {})
      return {}
    }
  )

  /**
   * 외부(gh CLI·GitHub 웹)에서 병합된 부모를 감지해 만들어 둔 계획을 사용자 승인 후 실행한다.
   * 이 경로에서만 force-push 가 나가므로, 승인 없이는 절대 호출되지 않는다.
   */
  ipcMain.handle(
    IPC.stackSyncApply,
    async (_e, workspaceId: string): Promise<{ error?: string; cascade?: StackCascadeResult }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      const plan = ws.stackSync
      if (!plan) return { error: 'Nothing to sync.' }
      const cascade = await runMergeCascade(workspaceId, plan.mergedBranch, plan.newBase).catch(
        (err): StackCascadeResult => ({
          steps: [
            {
              branch: plan.mergedBranch,
              prNumber: null,
              kind: 'retarget',
              status: 'failed',
              message: err instanceof Error ? err.message : String(err)
            }
          ]
        })
      )
      clearStackSync(workspaceId, true)
      return { cascade }
    }
  )

  /**
   * 계획을 무시한다. 어떤 병합을 무시했는지 기억해 두지 않으면 다음 재동기화가 같은 병합을 다시
   * 감지해 배너가 계속 뜬다("무시" = 이 병합은 내가 알아서 한다는 뜻).
   */
  ipcMain.handle(IPC.stackSyncDismiss, async (_e, workspaceId: string): Promise<void> => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w?.stackSync) w.stackSyncDismissed = w.stackSync.mergedBranch
    })
    clearStackSync(workspaceId)
  })

  ipcMain.handle(IPC.prClose, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return closePr(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  ipcMain.handle(IPC.prReopen, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return reopenPr(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  ipcMain.handle(IPC.prReady, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return markPrReady(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  // PR 의 CI 체크. prStatus 와 동일하게 worktree 의 현재 브랜치 PR 을 기준으로 한다.
  ipcMain.handle(IPC.prChecks, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return getPrChecks(ws.worktreePath).catch(() => null)
  })

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // ── 파일 브라우저 (All files 탭) ─────────────────────────────────────────

  ipcMain.handle(IPC.fsList, (_e, workspaceId: string, relPath: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    return listDir(ws.worktreePath, relPath ?? '').catch(() => [])
  })

  ipcMain.handle(IPC.fsRead, (_e, workspaceId: string, relPath: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return readFileInRoot(ws.worktreePath, relPath).catch(() => null)
  })

  ipcMain.handle(IPC.fsSearch, (_e, workspaceId: string, query: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    return searchFiles(ws.worktreePath, query ?? '').catch(() => [])
  })

  // ── 슬래시 명령 목록 (입력창 자동완성) ───────────────────────────────────

  ipcMain.handle(IPC.commandsList, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return []
    return ctx.sessions.listCommands(ws.id, ws.worktreePath).catch(() => [])
  })

  // 인터랙티브 명령(/mcp·/context·/reload-plugins 등) — 결과 카드용 데이터를 조회한다.
  ipcMain.handle(
    IPC.commandRun,
    async (
      _e,
      workspaceId: string,
      kind: CommandPanelKind
    ): Promise<{ result?: CommandResult; error?: string }> => {
      try {
        const result = await ctx.sessions.runCommand(workspaceId, kind)
        return { result }
      } catch (err) {
        // 명령 실행 실패는 렌더러 카드로만 전달돼 진단이 어렵다. 영속 로그에도 남긴다.
        log.error(`command '${kind}' failed:`, err)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // /mcp 패널의 서버별 동작(재연결·활성/비활성) — 적용 후 갱신된 서버 목록을 돌려준다.
  ipcMain.handle(
    IPC.mcpAction,
    async (
      _e,
      workspaceId: string,
      serverName: string,
      action: McpAction
    ): Promise<{ servers?: McpServerInfo[]; error?: string }> => {
      try {
        const servers = await ctx.sessions.mcpAction(workspaceId, serverName, action)
        return { servers }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // /rewind 패널 — 고른 체크포인트(사용자 메시지 UUID)로 추적된 파일을 되돌린다.
  ipcMain.handle(
    IPC.commandRewindAction,
    async (
      _e,
      workspaceId: string,
      userMessageId: string
    ): Promise<{ result?: RewindActionResult; error?: string }> => {
      try {
        const result = await ctx.sessions.rewindAction(workspaceId, userMessageId)
        return { result }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * 레이트리밋 수동 갱신(상태줄 팝오버). 라이브 세션이 없으면 단명 쿼리로 폴백하도록 허용한다 —
   * 사용자가 직접 누른 것이라 프로세스 spawn 비용이 정당화된다.
   * 갱신된 값은 반환값이 아니라 evtState 방송으로 흘러가므로 여기서는 아무것도 돌려주지 않는다.
   */
  ipcMain.handle(IPC.rateLimitsRefresh, async (): Promise<void> => {
    try {
      await ctx.sessions.refreshRateLimits(true)
    } catch (err) {
      log.error('rate limits: manual refresh failed:', err)
    }
  })

  // ── 인터랙티브 터미널 (worktree PTY) ─────────────────────────────────────

  ipcMain.handle(IPC.terminalStart, (_e, workspaceId: string, cols: number, rows: number) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    ctx.terminals.start(workspaceId, ws.worktreePath, cols, rows)
  })

  ipcMain.handle(IPC.terminalInput, (_e, workspaceId: string, data: string) => {
    ctx.terminals.write(workspaceId, data)
  })

  ipcMain.handle(IPC.terminalRunCommand, (_e, workspaceId: string, command: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    ctx.terminals.runCommand(workspaceId, ws.worktreePath, command)
  })

  ipcMain.handle(IPC.terminalExec, (_e, workspaceId: string, command: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    ctx.terminals.execInline(workspaceId, ws.worktreePath, command)
  })

  ipcMain.handle(IPC.terminalKillInline, (_e, workspaceId: string, itemId: string) => {
    ctx.terminals.killInline(workspaceId, itemId)
  })

  ipcMain.handle(IPC.terminalResize, (_e, workspaceId: string, cols: number, rows: number) => {
    ctx.terminals.resize(workspaceId, cols, rows)
  })

  ipcMain.handle(IPC.terminalKill, (_e, workspaceId: string) => {
    ctx.terminals.disposeWorkspace(workspaceId)
  })

  // ── Dock 미확인 배지 ─────────────────────────────────────────────────────

  ipcMain.handle(IPC.appSetBadge, (_e, count: number) => {
    // 설치 빌드에서 app.setBadgeCount 는 Dock 배지를 그리지 않는 것으로 확인돼(실험: 같은
    // 시점에 app.dock.setBadge 는 보이고 setBadgeCount 는 안 보임), NSDockTile 라벨을 직접
    // 세팅한다. 0 이면 빈 문자열로 지운다. dock 은 macOS 전용이라 다른 OS 는 no-op.
    const n = Math.max(0, Math.floor(count))
    app.dock?.setBadge(n > 0 ? String(n) : '')
  })

  // ── 설정 ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.appGetState, () => store.getState())

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => {
    store.update((st) => Object.assign(st.settings, patch))
    broadcastState()
  })

  // ── 외부 연동 인증 ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.authGetStatus, () => getAuthStatus())
  // 별도 Terminal 창 없이 앱 내부 PTY 에서 로그인하고, 진행 상황은 evtClaudeLogin 으로 흘려보낸다.
  // 로그인이 성공하면(= 계정이 바뀔 수 있으면) 세션 프로세스를 재활용한다 — 옛 자격증명을 들고
  // 있는 CLI 를 남기지 않으면서 대화 맥락(sessionId)은 유지해, 다음 메시지가 새 계정으로 같은
  // 대화를 이어간다(터미널에서 CLI 를 재시작하고 `claude --resume` 하는 것과 같은 결과).
  ipcMain.handle(IPC.authClaudeLoginStart, () =>
    claudeLoginStart(dispatch, () => ctx.sessions.recycleAll())
  )
  ipcMain.handle(IPC.authClaudeLoginSubmitCode, (_e, code: string) => claudeLoginSubmitCode(code))
  ipcMain.handle(IPC.authClaudeLoginCancel, () => claudeLoginCancel())
  ipcMain.handle(IPC.authClaudeLogout, async () => {
    // 로그아웃 완료까지 await 해야, 렌더러의 invoke Promise 가 그 시점에 resolve 된다.
    // 그래야 UI 의 로딩 표시가 실제 소요 시간만큼 유지되고, 이어지는 refreshAuth()가
    // 로그아웃이 반영된 상태를 읽는다(await 없이 반환하면 로딩이 곧장 사라진다).
    await claudeLogout()
    // 로그아웃하면 진행 중이던 세션은 인증이 끊겨 더 진행되지도 중단되지도 않는다.
    // 세션을 정리하고 '진행 중' 표시를 idle 로 되돌려, 재로그인 후 유령 상태가 남지 않게 한다.
    ctx.sessions.abortAll()
    broadcastState()
  })
  // GitHub 로그인도 별도 Terminal 창 없이 앱 내부 PTY(디바이스 플로우)로 진행하고,
  // 진행 상황은 evtGithubLogin 으로 흘려보낸다.
  ipcMain.handle(IPC.authGithubLoginStart, () => githubLoginStart(dispatch))
  ipcMain.handle(IPC.authGithubLoginCancel, () => githubLoginCancel())
  ipcMain.handle(IPC.authGithubLogout, () => githubLogout())
}
