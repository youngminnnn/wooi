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
  restackOnto,
  updateFromBase
} from './git'
import { applyCarryExcludes, carryIntoWorktree, detectCarryItems, validateCarryPath } from './carry'
import { getWorkspacePrStatus, invalidateWorkspacePr } from './prCache'
import { buildStackFromPrs, detectArchiveSuggestion, detectBaseMismatch } from './stack'
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
  getPrEditable,
  editPr,
  retargetPr,
  listOpenPrs,
  listOpenPrsForReview,
  listOpenIssues,
  getIssueBody,
  fetchOwnerAvatarDataUrl
} from './github'
import { ReviewManager } from './review/manager'
import type { ReviewVerdict, TranscriptSearchResult } from '@shared/types'
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
import {
  IPC,
  SETUP_SCRIPT_ID,
  agentSettingsFor,
  canSwitchAgentBackend,
  isBranchStack,
  normalizePermissionMode,
  reorderById,
  workspaceStack
} from '@shared/types'
import { resolveToolPermission } from './agent/tools/permission'
import { appendMemory } from './claude/memory'
import {
  archiveWorkspace,
  carryIntoNewWorktree,
  carrySuggestionsFor,
  createWorkspace,
  portEnvName,
  runArchiveScript,
  scriptEnvFor,
  syncPrBase,
  type ArchiveOutcome,
  type ArchiveWorkspaceDeps,
  type CreateWorkspaceDeps
} from './workspaces'
import type {
  AgentBackendId,
  AppState,
  AppSettings,
  CarryFailure,
  CarryItem,
  CodexLoginMethod,
  CommandPanelKind,
  CommandResult,
  CreateWorkspaceArgs,
  CreateWorkspaceResult,
  DropPosition,
  EffortSetting,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  MemoryScope,
  PaneKind,
  PermissionDecision,
  PermissionMode,
  PrMergeMethod,
  Repo,
  RestackResult,
  RewindActionResult,
  StackCascadeResult,
  StackCascadeStep,
  StackedBranch,
  StackSyncPlan,
  UpdateFromBaseResult,
  Workspace
} from '@shared/types'
import type { AgentOrchestrator } from './agent/orchestrator'
import type { PaneWindows } from './paneWindows'
import type { ScriptRunner } from './scripts'
import type { TerminalManager } from './terminal'

interface IpcContext {
  sessions: AgentOrchestrator
  scripts: ScriptRunner
  terminals: TerminalManager
  panes: PaneWindows
  getWindow: () => BrowserWindow | null
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

  /** 워크스페이스 생성이 메인에서 필요로 하는 것들([[workspaces]] createWorkspace). */
  const workspaceDeps: CreateWorkspaceDeps = { scripts: ctx.scripts, broadcastState }
  /** 아카이브는 워크스페이스에 매달린 것들까지 끊어야 해 더 넓다([[workspaces]] archiveWorkspace). */
  const archiveDeps: ArchiveWorkspaceDeps = {
    sessions: ctx.sessions,
    scripts: ctx.scripts,
    terminals: ctx.terminals,
    broadcastState
  }

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

  /**
   * workspace 의 dev 포트를 반환한다. 아직 배정 전(레거시)이면 다른 workspace 와 겹치지 않는
   * 포트를 BASE_DEV_PORT 부터 골라 배정·영속한 뒤 반환한다.
   */
  const ensureScriptPort = async (
    workspaceId: string,
    scriptId: string
  ): Promise<number | null> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    if (typeof ws.ports[scriptId] === 'number') return ws.ports[scriptId]
    const used = new Set<number>(store.getState().workspaces.flatMap((w) => Object.values(w.ports)))
    const port = await findFreePort(used)
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.ports[scriptId] = port
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
      runScripts: [],
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
    async (
      _e,
      repoId: string,
      patch: Partial<
        Pick<Repo, 'name' | 'setupScript' | 'runScripts' | 'archiveScript' | 'carryItems'>
      >
    ): Promise<{ error?: string }> => {
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
      if (patch.runScripts) {
        const names = new Set<string>()
        for (const script of patch.runScripts) {
          const key = portEnvName(script.name)
          if (!key) return { error: 'Run script names cannot be empty.' }
          if (key === SETUP_SCRIPT_ID) return { error: '“setup” is a reserved run script name.' }
          if (names.has(key)) return { error: `Run script name “${script.name}” is duplicated.` }
          names.add(key)
        }
      }

      store.update((st) => {
        const repo = st.repos.find((r) => r.id === repoId)
        if (repo) Object.assign(repo, patch, normalized ? { carryItems: normalized } : {})
      })
      if (patch.runScripts) {
        const used = new Set(store.getState().workspaces.flatMap((w) => Object.values(w.ports)))
        for (const ws of store.getState().workspaces.filter((w) => w.repoId === repoId)) {
          const ports: Record<string, number> = {}
          for (const script of patch.runScripts) {
            const port = ws.ports[script.id] ?? (await findFreePort(used))
            ports[script.id] = port
            used.add(port)
          }
          store.update((st) => {
            const target = st.workspaces.find((w) => w.id === ws.id)
            if (target) target.ports = ports
          })
        }
      }
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

  ipcMain.handle(IPC.repoListIssues, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listOpenIssues(repo.path).catch(() => [])
  })

  ipcMain.handle(IPC.repoGetIssueBody, async (_e, repoId: string, number: number) => {
    const repo = repoFor(repoId)
    if (!repo) return null
    return getIssueBody(repo.path, number).catch(() => null)
  })

  // ── workspace ────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.workspaceCreate,
    async (_e, args: CreateWorkspaceArgs): Promise<CreateWorkspaceResult> =>
      createWorkspace(workspaceDeps, args)
  )

  // 아카이브 절차 자체는 [[workspaces]] 에 있다 — 에이전트 도구도 같은 일을 해야 하기 때문이다.
  // 아카이브 스크립트가 실패했으면 그 결과를 실어 보낸다(렌더러가 토스트로 알린다).
  ipcMain.handle(IPC.workspaceArchive, async (_e, workspaceId: string): Promise<ArchiveOutcome> =>
    archiveWorkspace(archiveDeps, workspaceId)
  )

  /**
   * 아카이브 제안을 해제한다. 어떤 병합을 해제했는지 기억해 두지 않으면 다음 재동기화가 같은
   * 병합을 다시 감지해 배너가 계속 뜬다("해제" = 이 워크스페이스는 아직 쓸 일이 있다는 뜻).
   */
  ipcMain.handle(
    IPC.workspaceArchiveSuggestDismiss,
    async (_e, workspaceId: string): Promise<void> => {
      let changed = false
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w?.archiveSuggest) return
        w.archiveSuggestDismissed = w.archiveSuggest.mergedBranch
        w.archiveSuggest = null
        changed = true
      })
      if (changed) broadcastState()
    }
  )

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
      // worktree 를 새로 만드는 경로라 gh 기본 base 도 다시 맞춘다(설정 자체는 리포 공용이라
      // 보통 남아 있지만, 아카이브 중에 base 가 바뀌었을 수 있다).
      await syncPrBase(ws, ws.baseBranch)
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

  // 영구 삭제: 아카이브와 달리 되돌릴 수 없다 — worktree·대화 기록에 더해 (deleteBranch 면)
  // 브랜치까지 지우고 워크스페이스 레코드 자체를 목록에서 없앤다. 아카이브된 것뿐 아니라
  // 살아 있는 워크스페이스에도 쓰인다(사이드바 메뉴 · ⌥⌘⌫ · 생성 되돌리기).
  ipcMain.handle(
    IPC.workspaceRemove,
    async (_e, workspaceId: string, deleteBranch: boolean): Promise<ArchiveOutcome> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return {}
      const repo = repoFor(ws.repoId)

      ctx.sessions.dispose(workspaceId)
      ctx.scripts.disposeWorkspace(workspaceId)
      ctx.terminals.disposeWorkspace(workspaceId)
      // 아카이브 스크립트는 "이 worktree 를 정리한다" 는 훅이다(dev 컨테이너 종료 등). 워크트리가
      // 아직 살아 있는 워크스페이스를 지울 때는 아카이브와 같은 이유로 실행해야 한다 —
      // 이미 아카이브된 워크스페이스는 그때 한 번 돌았으므로 건너뛴다.
      const archiveScriptFailure =
        !ws.archived && repo
          ? await runArchiveScript(ctx.scripts, repo.archiveScript, ws.worktreePath)
          : undefined
      getTranscripts().remove(workspaceId)
      invalidateWorkspacePr(workspaceId)
      if (repo) await removeWorktree(repo.path, ws.worktreePath, ws.branch, deleteBranch)

      store.update((st) => {
        st.workspaces = st.workspaces.filter((w) => w.id !== workspaceId)
      })
      broadcastState()
      return archiveScriptFailure ? { archiveScriptFailure } : {}
    }
  )

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

  /**
   * 메인 에이전트 교체. 생성 시 골랐어야 할 값을, **아직 아무것도 보내지 않은** 동안에만 고쳐 준다
   * ([[canSwitchAgentBackend]]).
   *
   * 규칙은 렌더러와 같은 함수를 쓰지만 판정 재료는 여기서 다시 읽는다 — 렌더러의 화면이 낡았거나
   * (교체 직전에 첫 메시지가 나갔거나) 다른 창에서 이미 대화가 시작됐을 수 있고, 그때 그대로
   * 바꿔 주면 남의 대화 맥락을 다른 CLI 로 넘기게 된다.
   */
  ipcMain.handle(
    IPC.workspaceSetAgentBackend,
    async (_e, workspaceId: string, agentBackend: AgentBackendId): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      if (ws.agentBackend === agentBackend) return {}
      if (!canSwitchAgentBackend(ws, getTranscripts().load(workspaceId).length)) {
        return {
          error:
            'The agent is fixed once the conversation starts. Clear the conversation (/clear) or create a new workspace.'
        }
      }

      // 등록 여부·가용성(CLI 설치·버전)을 카탈로그에서 확인한다. 쓸 수 없는 에이전트로 갈아타면
      // 워크스페이스가 첫 메시지에서야 실패하므로, 그 전에 이유를 그대로 돌려준다.
      const target = (await ctx.sessions.listBackends()).find((b) => b.id === agentBackend)
      if (!target) return { error: 'Unknown agent.' }
      if (!target.available) {
        return { error: target.unavailableReason ?? `${target.label} is not available.` }
      }

      // 세션은 첫 전송에서야 생기므로 보통 아무것도 없지만, 남아 있다면 **바꾸기 전에** 정리한다 —
      // agentBackend 를 바꾸고 나면 라우팅이 새 백엔드로 가서 옛 세션에 손이 닿지 않는다.
      ctx.sessions.dispose(workspaceId)

      const settings = store.getState().settings
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        w.agentBackend = agentBackend
        // 모델·effort·fast mode 는 백엔드마다 값 자체가 다르다(Claude 의 모델 ID 를 Codex 에 줄 수
        // 없다). 그대로 들고 가면 조용히 무시되거나 거부되므로 새 백엔드의 기본값으로 되돌린다.
        w.model = null
        w.lastModel = null
        w.effort = null
        w.fastMode = null
        w.fastModeState = null
        w.fastModeReason = null
        w.permissionMode = normalizePermissionMode(
          target,
          agentSettingsFor(settings, agentBackend).permissionMode
        )
      })
      broadcastState()
      return {}
    }
  )

  ipcMain.handle(IPC.workspaceSetMuted, (_e, workspaceId: string, muted: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.muted = muted
    })
    broadcastState()
  })

  /**
   * 멀티 에이전트 모드 전환(실험 기능). 세션 옵션에 실리는 값이라 **다음 세션부터** 적용된다 —
   * 여기서 세션을 끊지 않는 이유는, 도는 중인 턴을 설정 변경만으로 죽이는 편이 더 놀랍기 때문이다.
   */
  ipcMain.handle(IPC.workspaceSetMultiAgent, (_e, workspaceId: string, multiAgent: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.multiAgent = multiAgent
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

  // `#` 단축키 — 대화를 끊지 않고 CLAUDE.md 에 기억 한 줄을 덧붙인다.
  ipcMain.handle(
    IPC.workspaceAddMemory,
    (
      _e,
      workspaceId: string,
      scope: MemoryScope,
      text: string
    ): { path?: string; error?: string } => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      return appendMemory(scope, ws.worktreePath, text)
    }
  )

  // /add-dir — worktree 밖 디렉토리를 작업 루트로 더한다(세션은 다음 메시지에서 새로 열린다).
  ipcMain.handle(IPC.workspaceAddDir, (_e, workspaceId: string, dir: string) =>
    ctx.sessions.addDirectory(workspaceId, dir)
  )

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

  // 활성 워크스페이스의 누적 비용만 모아 돌려준다. 대화 기록을 렌더러로 옮기지 않기 위한
  // 통로다 — 화면에 필요한 건 숫자 하나인데, 예전에는 그것 때문에 전체 트랜스크립트가
  // 렌더러 힙에 올라간 채 매 토큰마다 다시 합산됐다.
  ipcMain.handle(IPC.chatGetCosts, (): Record<string, number> => {
    const costs: Record<string, number> = {}
    for (const w of store.getState().workspaces) {
      if (w.archived) continue
      costs[w.id] = getTranscripts().costOf(w.id)
    }
    return costs
  })

  ipcMain.handle(IPC.chatGetHistory, (_e, workspaceId: string) => {
    return getTranscripts().load(workspaceId)
  })

  // 워크스페이스를 가로지르는 대화 검색. 훑는 일은 전부 여기서 끝내고 렌더러에는 스니펫만
  // 넘긴다 — 워크스페이스가 수십 개일 때 원문을 넘기면 검색 한 번에 힙이 수백 MB 로 뛴다.
  // 아카이브된 워크스페이스도 기본 포함이다("그 결정 어디서 했더라" 의 답은 대개 거기 있다).
  ipcMain.handle(
    IPC.chatSearch,
    (_e, query: string, opts?: { includeArchived?: boolean }): Promise<TranscriptSearchResult> => {
      const includeArchived = opts?.includeArchived ?? true
      const ids = store
        .getState()
        .workspaces.filter((w) => includeArchived || !w.archived)
        .map((w) => w.id)
      return getTranscripts().search(query, ids)
    }
  )

  ipcMain.handle(IPC.permissionRespond, (_e, requestId: string, decision: PermissionDecision) => {
    ctx.sessions.respondPermission(requestId, decision)
    // Wooi 도구 승인은 백엔드가 아니라 메인이 띄운다([[agent/tools/permission]]). requestId 는
    // 어디서 나왔는지 구분되지 않으므로 양쪽에 흘리고, 자기 것이 아니면 무시한다.
    resolveToolPermission(requestId, decision)
  })

  // ── 스크립트 ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.scriptRun, async (_e, workspaceId: string, scriptId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const repo = repoFor(ws.repoId)
    if (!repo) return
    const command =
      scriptId === SETUP_SCRIPT_ID
        ? repo.setupScript
        : (repo.runScripts.find((s) => s.id === scriptId)?.command ?? '')
    if (!command.trim()) return
    // 고유 포트를 env(PORT/WOOI_DEV_PORT)로 주입한다. 레거시 workspace 는 여기서 lazy 배정.
    const port = scriptId === SETUP_SCRIPT_ID ? null : await ensureScriptPort(workspaceId, scriptId)

    // dev 서버는 실제로 포트를 바인딩하므로, 배정된 포트가 며칠 전 값이라 그 사이 다른 프로세스가
    // 차지했을 수 있다. 실행 직전에 실제 가용성을 확인하고, 외부 프로세스가 점유 중이면 비어 있는
    // 포트로 재배정해 bind 실패를 막는다. 이 워크스페이스 자신의 이전 dev 가 같은 포트를 잡고 있을
    // 수 있으므로 먼저 종료하고 잠깐 기다린다 — 자기 포트를 외부 점유로 오인해 매번 바꾸지 않도록.
    if (port != null) {
      ctx.scripts.stop(workspaceId, scriptId)
      const freed = await waitForPortFree(port, 1500)
      if (!freed) {
        const used = new Set<number>(
          store.getState().workspaces.flatMap((w) => Object.values(w.ports))
        )
        // 외부 점유 중인 현재 포트는 findFreePort 의 OS 프로브에서 자동으로 걸러진다.
        const next = await findFreePort(used)
        store.update((st) => {
          const w = st.workspaces.find((x) => x.id === workspaceId)
          if (w) w.ports[scriptId] = next
        })
      }
    }

    const current = store.getState().workspaces.find((w) => w.id === workspaceId) ?? ws
    const env = scriptEnvFor(repo, current, scriptId)
    if (env) broadcastState()
    ctx.scripts.run(workspaceId, scriptId, command, ws.worktreePath, env)
  })

  ipcMain.handle(IPC.scriptStop, (_e, workspaceId: string, scriptId: string) => {
    ctx.scripts.stop(workspaceId, scriptId)
  })

  ipcMain.handle(IPC.scriptGetStatus, (_e, workspaceId: string) => {
    return ctx.scripts.getStatus(workspaceId)
  })

  ipcMain.handle(IPC.scriptGetOutput, (_e, workspaceId: string, scriptId: string) => {
    return ctx.scripts.getOutput(workspaceId, scriptId)
  })

  // ── 분리한 패널 창 ─────────────────────────────────────────────────────

  ipcMain.handle(IPC.paneOpen, (_e, kind: PaneKind, workspaceId: string | null) => {
    ctx.panes.open(kind, workspaceId)
  })

  ipcMain.handle(IPC.paneClose, (_e, kind: PaneKind) => {
    ctx.panes.close(kind)
  })

  ipcMain.handle(IPC.paneFocus, (_e, kind: PaneKind) => {
    ctx.panes.focus(kind)
  })

  ipcMain.handle(IPC.paneGetState, () => ctx.panes.state())

  ipcMain.handle(IPC.paneSetWorkspace, (_e, workspaceId: string | null) => {
    ctx.panes.setWorkspace(workspaceId)
  })

  // 분리한 창에는 리포 설정 모달이 없다(설정은 메인 창의 것이다). 요청을 메인 창으로 넘기고
  // 그 창을 앞으로 가져와, 보조 모니터에서 누른 버튼이 아무 일도 안 일어난 것처럼 보이지 않게 한다.
  ipcMain.handle(IPC.paneOpenRepoSettings, (_e, repoId: string) => {
    const win = ctx.getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC.evtOpenRepoSettings, repoId)
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
    // 스택 관계상 이 브랜치의 PR 이 향해야 할 base. 부모가 아카이브됐으면 판정하지 않는다.
    const parentBranch = ws.parentWorkspaceId
      ? (store.getState().workspaces.find((w) => w.id === ws.parentWorkspaceId && !w.archived)
          ?.branch ?? null)
      : null
    const mismatch = detectBaseMismatch({
      headPr: headPr ? { number: headPr.number, base: headPr.base } : null,
      parentBranch,
      pendingSync: plan !== null,
      dismissed: ws.baseMismatchDismissed ?? null
    })
    // PR 이 병합돼 이 워크스페이스가 끝났으면 정리를 제안한다. 병합은 캐스케이드 감지가 이미
    // 보고 있는 사실이라, 같은 자리에서 함께 판정해 gh 호출을 늘리지 않는다.
    const curBranch = head || ws.branch
    const suggestion = await detectArchiveSuggestion({
      branch: curBranch,
      existing: ws.archiveSuggest,
      branchStack: isBranchStack(ws),
      hasLiveChildren: store
        .getState()
        .workspaces.some((w) => w.parentWorkspaceId === ws.id && !w.archived),
      pendingSync: plan !== null,
      dismissed: ws.archiveSuggestDismissed,
      now: Date.now(),
      lookupMerged: async () => {
        // 열린 PR 목록에 이 브랜치가 있으면 병합되지 않은 것이다 — 이미 손에 든 목록으로
        // 먼저 걸러낸다(대부분의 워크스페이스가 여기서 끝난다).
        if (prs.some((p) => p.head === curBranch)) return null
        // 아는 PR 번호가 없으면 조회하지 않는다. 이 재동기화는 상태 갱신마다 도는데, PR 을 연
        // 적 없는 워크스페이스까지 매번 gh 를 띄우면 그 비용이 상시로 깔린다. 번호는 PR 이
        // 한 번이라도 조회되면 persistPrNumber 가 적어 두므로(병합된 PR 도 포함), 늦어도
        // 다음 갱신에는 여기까지 온다.
        if (curBranch !== ws.branch || ws.prNumber == null) return null
        const meta = await getPrMeta(ws.worktreePath, ws.prNumber).catch(() => null)
        if (meta?.state !== 'MERGED') return null
        // 저장된 번호가 예전 브랜치의 것일 수 있다(HEAD 가 옮겨간 뒤 새 브랜치에 PR 이 없으면
        // prNumber 가 갱신되지 않는다). 남의 병합을 이 브랜치의 것으로 읽지 않도록 확인한다.
        return meta.headRefName === curBranch ? { number: meta.number } : null
      }
    }).catch(() => null)

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
      if ((w.archiveSuggest?.mergedBranch ?? null) !== (suggestion?.mergedBranch ?? null)) {
        w.archiveSuggest = suggestion
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
      } else if (headPr && !mismatch && w.baseBranch !== headPr.base) {
        // 스택은 아니지만 현재 브랜치의 PR base 가 다르면 맞춘다(ahead/behind 정확도).
        // mismatch 일 때는 채택하지 않는다 — PR 의 base 를 그대로 믿으면 스택 관계가 조용히
        // 사라지고, 이후 restack·캐스케이드가 전부 엉뚱한 기준으로 돌아간다.
        w.baseBranch = headPr.base
        changed = true
      }
      const sameMismatch =
        (w.baseMismatch?.prNumber ?? null) === (mismatch?.prNumber ?? null) &&
        (w.baseMismatch?.prBase ?? null) === (mismatch?.prBase ?? null) &&
        (w.baseMismatch?.expectedBase ?? null) === (mismatch?.expectedBase ?? null)
      if (!sameMismatch) {
        w.baseMismatch = mismatch
        changed = true
      }
      // 어긋난 동안에도 기록상의 base 는 스택 관계(부모 브랜치)로 유지한다. 이 수정 이전에
      // PR base 를 그대로 채택해 버린 워크스페이스도 여기서 제자리를 찾는다.
      if (mismatch && w.baseBranch !== mismatch.expectedBase) {
        w.baseBranch = mismatch.expectedBase
        changed = true
      }
    })
    if (changed) broadcastState()

    // 기록된 base 를 gh 의 기본 PR base 에도 반영한다. 여기서 함께 처리하면 이 변경 이전에
    // 만들어진 스택 워크스페이스도 다음 PR 상태 갱신 때 자동으로 백필된다.
    const after = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (after) await syncPrBase(after, after.baseBranch)
  }

  ipcMain.handle(IPC.prStatus, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    // 실제 git/PR 상태에서 현재 브랜치·스택을 먼저 재동기화한다(에이전트가 직접 만든 스택도 인식).
    // 이 과정에서 리포의 열린 PR 목록을 이미 받아 두므로, 아래 상태 조회는 대개 그 목록에서
    // 답이 나온다 — 워크스페이스마다 gh 를 따로 띄우지 않는다.
    await reconcileWorkspaceStack(workspaceId).catch(() => {})
    // worktree 의 현재 브랜치에 연결된 PR. reconcile 이 w.branch 를 실제 HEAD 로 맞춰 둔다.
    const after = store.getState().workspaces.find((w) => w.id === workspaceId) ?? ws
    const status = await getWorkspacePrStatus(after, after.branch)
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
          // 부모가 사라졌으니 그 부모를 기준으로 잡아 둔 base 어긋남 판정도 무효다.
          c.baseMismatch = null
        }
      })
      // base 가 조부모로 내려갔으므로 gh 기본 base 도 함께 옮긴다(조부모가 리포 기본
      // 브랜치면 설정이 지워져 gh 기본값으로 되돌아간다).
      await syncPrBase(child, grandparentBranch)
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

  /**
   * 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다([[types]] BaseMismatch).
   * 리타겟은 GitHub 쪽 상태만 바꾸고 커밋 히스토리는 건드리지 않는다 — force-push 가 없으므로
   * 캐스케이드와 달리 되돌리기 쉽다. 그래도 남의 PR 을 바꾸는 일이라 사용자 승인 후에만 돈다.
   */
  ipcMain.handle(
    IPC.stackBaseRetarget,
    async (_e, workspaceId: string): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      const m = ws.baseMismatch
      if (!m) return { error: 'Nothing to retarget.' }
      const res = await retargetPr(ws.worktreePath, m.expectedBase, String(m.prNumber)).catch(
        (err) => ({ error: err instanceof Error ? err.message : String(err) })
      )
      if (res.error) return res
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        w.baseBranch = m.expectedBase
        w.baseMismatch = null
      })
      broadcastState()
      await syncPrBase(ws, m.expectedBase)
      return {}
    }
  )

  /**
   * 어긋난 base 를 사용자가 의도한 것으로 받아들인다 — 그 base 를 기록상의 base 로 채택하고,
   * 같은 base 로는 다시 묻지 않는다. 부모 링크는 그대로 둔다(사이드바의 스택 묶음은 유지).
   */
  ipcMain.handle(IPC.stackBaseKeep, async (_e, workspaceId: string): Promise<void> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    const kept = ws?.baseMismatch?.prBase
    if (!ws || !kept) return
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      w.baseBranch = kept
      w.baseMismatchDismissed = kept
      w.baseMismatch = null
    })
    broadcastState()
    // 채택한 base 를 gh 기본값에도 반영한다 — 그러지 않으면 다음 재동기화가 부모 브랜치로
    // 되돌려 놓아, 사용자의 선택과 어긋난 PR 이 또 만들어진다.
    await syncPrBase(ws, kept)
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

  // 편집 모달을 열 때만 제목·본문 원문을 읽는다(상태 폴링에 본문을 싣지 않기 위해).
  ipcMain.handle(IPC.prEditable, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return getPrEditable(ws.worktreePath).catch(() => null)
  })

  ipcMain.handle(
    IPC.prEdit,
    async (
      _e,
      workspaceId: string,
      edits: { title?: string; body?: string }
    ): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      const res = await editPr(ws.worktreePath, edits, ws.prNumber ?? undefined).catch((err) => ({
        error: err instanceof Error ? err.message : String(err)
      }))
      if (res.error) return res
      // 제목은 워크스페이스 표시 이름의 기본값이다(displayName override → PR 제목 → worktree 이름).
      // 캐시를 버려야 다음 상태 조회가 새 제목을 읽고, 사이드바가 곧바로 따라온다.
      invalidateWorkspacePr(workspaceId)
      return {}
    }
  )

  // PR 의 CI 체크. prStatus 와 동일하게 worktree 의 현재 브랜치 PR 을 기준으로 한다.
  ipcMain.handle(IPC.prChecks, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return getPrChecks(ws.worktreePath).catch(() => null)
  })

  // ── PR 리뷰 모드 ─────────────────────────────────────────────────────────
  // 워크스페이스가 아니라 repo + PR 번호로 동작한다 — 리뷰 대상은 임의의 PR 이다.

  const reviewManager = new ReviewManager(
    (envelope) => dispatch(IPC.evtReview, envelope),
    broadcastState
  )

  // 앱을 닫을 때는 **워크트리만** 정리한다. 리뷰 레코드·ref·사이드카를 지우면 다음 실행에
  // 리뷰가 통째로 사라져 영속화가 무의미해진다(ref 를 남겨야 오프라인에서도 복원된다).
  app.on('before-quit', () => {
    void reviewManager.disposeWorktreesOnQuit()
  })

  ipcMain.handle(IPC.reviewListOpenPrs, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listOpenPrsForReview(repo.path).catch(() => [])
  })

  ipcMain.handle(
    IPC.reviewStart,
    async (
      _e,
      args: {
        repoId: string
        prNumber: number
        prompt: string
        agentBackend?: AgentBackendId
        model?: string | null
        effort?: EffortSetting | null
      }
    ) => {
      const repo = repoFor(args.repoId)
      if (!repo) return { error: '리포를 찾을 수 없습니다.' }
      const settings = store.getState().settings
      const agentBackend = args.agentBackend ?? settings.defaultAgentBackend
      // 모델·effort 는 고른 에이전트의 전역 기본값을 따른다(백엔드마다 모델 ID 가 다르므로
      // 다른 백엔드의 값을 흘리면 CLI 가 거부한다).
      const defaults = agentSettingsFor(settings, agentBackend)
      return reviewManager.start({
        repo,
        prNumber: args.prNumber,
        prompt: args.prompt,
        agentBackend,
        // 워크스페이스처럼 개별 오버라이드가 없으므로 전역 설정을 따른다.
        model: args.model === undefined ? defaults.model : args.model,
        effort: args.effort === undefined ? defaults.effort : args.effort
      })
    }
  )

  ipcMain.handle(IPC.reviewCancel, (_e, reviewId: string) => {
    reviewManager.cancel(reviewId)
  })

  ipcMain.handle(IPC.reviewPost, async (_e, reviewId: string, findingId: string, body: string) =>
    reviewManager.post(reviewId, findingId, body)
  )

  ipcMain.handle(IPC.reviewDismiss, (_e, reviewId: string, findingId: string) =>
    reviewManager.dismissFinding(reviewId, findingId)
  )

  ipcMain.handle(IPC.reviewClose, async (_e, reviewId: string) => {
    await reviewManager.remove(reviewId)
  })

  ipcMain.handle(IPC.reviewLoad, (_e, reviewId: string) => reviewManager.loadBundle(reviewId))

  ipcMain.handle(IPC.reviewSetFileViewed, (_e, reviewId: string, path: string, viewed: boolean) =>
    reviewManager.setFileViewed(reviewId, path, viewed)
  )

  ipcMain.handle(IPC.reviewArchive, async (_e, reviewId: string) => {
    await reviewManager.archive(reviewId)
  })

  ipcMain.handle(IPC.reviewUnarchive, async (_e, reviewId: string) =>
    reviewManager.unarchive(reviewId)
  )

  ipcMain.handle(
    IPC.reviewSubmit,
    async (_e, reviewId: string, verdict: ReviewVerdict, body: string) =>
      reviewManager.submitReview(reviewId, verdict, body)
  )

  ipcMain.handle(IPC.reviewPoll, async (_e, reviewId: string) => {
    await reviewManager.pollActivity(reviewId)
  })

  ipcMain.handle(IPC.reviewMarkSeen, (_e, reviewId: string) => {
    reviewManager.markSeen(reviewId)
  })

  ipcMain.handle(IPC.reviewReply, async (_e, reviewId: string, commentId: number, body: string) =>
    reviewManager.replyToThread(reviewId, commentId, body)
  )

  ipcMain.handle(IPC.reviewFollowUp, async (_e, reviewId: string, text: string) => {
    const state = store.getState()
    // 후속 턴은 리뷰를 시작한 그 에이전트로 이어진다 — 세션 id 가 그 백엔드에서만 유효하다.
    const review = state.reviews.find((r) => r.id === reviewId)
    const backend = review?.agentBackend ?? state.settings.defaultAgentBackend
    const defaults = agentSettingsFor(state.settings, backend)
    // 모델·강도도 시작할 때 고른 것으로 이어 간다. 옛 레코드에는 없으므로 그때는 전역 기본값
    // (지금까지의 동작)으로 떨어진다.
    return reviewManager.followUp(reviewId, text, {
      model: review?.model ?? defaults.model,
      effort: review?.effort ?? defaults.effort
    })
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

  // ── 에이전트 카탈로그 (렌더러의 선택지 UI 근거) ──────────────────────────

  // 백엔드 메타 + 가용성. 렌더러는 이 값으로 권한 모드·effort 선택지와 에이전트 피커를 그린다.
  ipcMain.handle(IPC.agentListBackends, () => ctx.sessions.listBackends())

  // 백엔드별 모델 목록. Claude 는 정적, Codex 는 app-server 의 model/list 조회라 비동기·동적이다.
  ipcMain.handle(IPC.agentListModels, (_e, backendId: AgentBackendId) =>
    ctx.sessions.listModels(backendId)
  )

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
   * agentId가 있으면 해당 backend만 갱신하고, 호출한 renderer가 방송 유실 없이 반영하도록
   * 최신 AppState를 직접 반환한다.
   */
  ipcMain.handle(
    IPC.rateLimitsRefresh,
    async (_event, agentId?: AgentBackendId): Promise<AppState> => {
      try {
        if (agentId) await ctx.sessions.refreshRateLimitsFor(agentId, true)
        else await ctx.sessions.refreshRateLimits(true)
      } catch (err) {
        log.error('rate limits: manual refresh failed:', err)
      }
      // 방송은 다른 창을 위한 push 경로로 유지하되, 요청한 renderer에는 최신 상태를 직접
      // 반환한다. 그래야 초기 구독 전 이벤트 유실이나 동시 갱신 순서와 무관하게 화면이 따라온다.
      return store.getState()
    }
  )

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
  // Codex 로그인은 PTY 가 필요 없다 — app-server 가 OAuth 콜백 서버까지 호스팅하므로,
  // 우리는 인증 URL 을 기본 브라우저로 열어 주고 완료 알림(evtCodexLogin)만 기다린다.
  ipcMain.handle(IPC.authCodexLoginStart, async (_e, method: CodexLoginMethod, apiKey?: string) => {
    const codex = ctx.sessions.accountFor('codex')
    if (!codex?.loginStart) throw new Error('Codex sign-in is not available.')
    await codex.loginStart(method, apiKey)
  })
  ipcMain.handle(IPC.authCodexLoginCancel, () => ctx.sessions.accountFor('codex')?.loginCancel?.())
  ipcMain.handle(IPC.authCodexLogout, async () => {
    const codex = ctx.sessions.accountFor('codex')
    if (!codex?.logout) return
    // Claude 와 같은 이유로 완료까지 await 한다 — 이어지는 refreshAuth()가 반영된 상태를 읽도록.
    await codex.logout()
    codex.abortAll()
    broadcastState()
  })
  ipcMain.handle(
    IPC.authCodexRateLimits,
    () => ctx.sessions.accountFor('codex')?.rateLimits?.() ?? null
  )

  // GitHub 로그인도 별도 Terminal 창 없이 앱 내부 PTY(디바이스 플로우)로 진행하고,
  // 진행 상황은 evtGithubLogin 으로 흘려보낸다.
  ipcMain.handle(IPC.authGithubLoginStart, () => githubLoginStart(dispatch))
  ipcMain.handle(IPC.authGithubLoginCancel, () => githubLoginCancel())
  ipcMain.handle(IPC.authGithubLogout, () => githubLogout())
}
