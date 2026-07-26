import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStore } from './store'
import { getTranscripts } from './transcripts'
import { listDir, readFileInRoot } from './fsbrowse'
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
import { generateWorkspaceName } from './names'
import { buildStackFromPrs } from './stack'
import { findFreePort, waitForPortFree } from './net'
import {
  getPrStatus,
  getPrChecks,
  createPrWeb,
  mergePr,
  retargetPr,
  closePr,
  reopenPr,
  markPrReady,
  listOpenPrs,
  fetchOwnerAvatarDataUrl
} from './github'
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
  StackedBranch,
  UpdateFromBaseResult
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
      patch: Partial<Pick<Repo, 'name' | 'setupScript' | 'devScript' | 'archiveScript'>>
    ) => {
      store.update((st) => {
        const repo = st.repos.find((r) => r.id === repoId)
        if (repo) Object.assign(repo, patch)
      })
      broadcastState()
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
    ): Promise<{ workspaceId?: string; name?: string; branch?: string; error?: string }> => {
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
          status: 'idle',
          lastModel: null,
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
      return { workspaceId: id, name: rawName, branch }
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
    async (_e, workspaceId: string): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      const repo = repoFor(ws.repoId)
      if (!repo) return { error: 'Repository not found.' }

      try {
        await addWorktree(repo.path, ws.branch, ws.baseBranch, ws.worktreePath)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
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
      return {}
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
    const prs = await listOpenPrs(ws.worktreePath).catch(() => [])
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

    let changed = false
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      // 실제 HEAD 로 현재 브랜치를 맞춘다(에이전트가 브랜치를 옮겼을 수 있다).
      if (head && w.branch !== head) {
        w.branch = head
        changed = true
      }
      if (detected) {
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

  // PR 라이프사이클 액션(merge/close/reopen/ready). 전부 worktree 현재 브랜치의 PR 대상.
  ipcMain.handle(
    IPC.prMerge,
    async (_e, workspaceId: string, method: PrMergeMethod): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      const result = await mergePr(ws.worktreePath, method).catch((err) => ({
        error: err instanceof Error ? err.message : String(err)
      }))
      if (result.error) return result

      // 병합 캐스케이드: 방금 병합된 워크스페이스를 부모로 삼던 자식들을 조부모(=이 워크스페이스의 base)로
      // 옮긴다. 각 자식 PR 의 base 를 조부모 브랜치로 retarget 하고, 로컬 링크(parent/base)를 갱신한 뒤,
      // 조부모 위로 rebase 해 방금 병합된 부모 커밋을 떨군다(--onto <조부모> <병합된 부모 브랜치>).
      const grandparentBranch = ws.baseBranch
      const grandparentId = ws.parentWorkspaceId
      const mergedBranch = ws.branch
      const children = store
        .getState()
        .workspaces.filter((w) => w.parentWorkspaceId === ws.id && !w.archived)
      for (const child of children) {
        await retargetPr(child.worktreePath, grandparentBranch).catch(() => {})
        store.update((st) => {
          const c = st.workspaces.find((x) => x.id === child.id)
          if (c) {
            c.parentWorkspaceId = grandparentId
            c.baseBranch = grandparentBranch
          }
        })
        // 새 base 위로 rebase(충돌하면 워킹트리에 남겨 두고 UI 가 안내). best-effort.
        await restackOnto(child.worktreePath, grandparentBranch, mergedBranch).catch(() => {})
      }
      if (children.length) broadcastState()

      // 모델 B 캐스케이드: 병합된 브랜치(ws.branch)가 worktree 내부 스택의 엔트리면, 그 위 엔트리들의
      // base 를 병합된 base 로 당겨 retarget + rebase(--onto 병합base, oldBase=병합브랜치)한 뒤,
      // 스택에서 병합 엔트리를 제거한다. clean 워킹트리에서만 시도(아니면 스택 링크만 갱신).
      const stack = ws.stack
      if (stack && stack.length > 1 && stack.some((e) => e.branch === mergedBranch)) {
        const idx = stack.findIndex((e) => e.branch === mergedBranch)
        const mergedBase = stack[idx].baseBranch
        // 병합된 브랜치를 직속 base 로 삼던 상위 PR 을 mergedBase 로 retarget(worktree 무관, 항상 시도).
        for (const e of stack.slice(idx + 1)) {
          if (e.baseBranch === mergedBranch) {
            await retargetPr(ws.worktreePath, mergedBase, e.branch).catch(() => {})
          }
        }
        // clean 워킹트리에서만 checkout-dance 로 상위 브랜치를 rebase 해 병합 커밋을 떨군다.
        const clean = await isWorktreeClean(ws.worktreePath).catch(() => false)
        if (clean) {
          const oldTip = new Map<string, string>()
          for (const e of stack) {
            const sha = await revParse(ws.worktreePath, e.branch)
            if (sha) oldTip.set(e.branch, sha)
          }
          for (const e of stack.slice(idx + 1)) {
            const directChild = e.baseBranch === mergedBranch
            const newBase = directChild ? mergedBase : e.baseBranch
            // oldBase: 직속 자식은 병합된 브랜치, 그 위는 자기 base 의 이전 tip.
            const oldBase = directChild ? mergedBranch : oldTip.get(e.baseBranch)
            const co = await checkoutBranch(ws.worktreePath, e.branch)
            if (co.error) break // dirty 등으로 전환 실패하면 남은 캐스케이드는 중단(수동 restack 유도).
            await restackOnto(ws.worktreePath, newBase, oldBase).catch(() => {})
          }
        }
        // 스택에서 병합 엔트리를 제거하고 링크를 갱신한다. 현재 체크아웃은 병합된 브랜치 아래(base)로 옮긴다.
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
      return result
    }
  )

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
