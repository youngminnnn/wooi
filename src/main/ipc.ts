import { app, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handle } from './commandRegistry'
import { compareBaseBranch, normalizeCompareBase } from '@shared/compareBase'
import { openInEditor } from './openInEditor'
import { memoryFile } from './claude/memory'
import { getStore } from './store'
import { getRemoteBridge } from './remote'
import { pendingPermissions } from './remote/permissions'
import { isStayingAlive } from './backgroundMode'
import { lastNotificationSkip, setViewingWorkspace } from './notifications'
import { rememberPrStatus } from './prStatusCache'
import { forgetContextUsage } from './contextUsageCache'
import { forgetWorkspaceUsage } from './usageLedger'
import { forgetRunningAgents } from './runningAgentsCache'
import { setSleepBlockerEnabled } from './sleepBlocker'
import { getTranscripts } from './transcripts'
import { buildHandoffPrompt, estimateHandoffTokens, formatHandoffTokens } from '@shared/handoff'
import { listDir, readFileInRoot, searchFiles, writeFileInRoot } from './fsbrowse'
import { importMigration, scanMigration } from './migrate'
import { formatIssues } from '@shared/previewIssues'
import { log } from './logger'
import {
  abortMerge,
  applyReversePatch,
  addWorktree,
  checkoutBranch,
  currentBranch,
  detectDefaultBranch,
  revParse,
  getDiff,
  getGithubOwner,
  getStatus,
  fetchRemoteForRepo,
  isGitRepo,
  isWorktreeClean,
  listCommits,
  listBranches,
  rebaseConflictState,
  removeWorktree,
  repoNameFromPath,
  restackOnto,
  updateFromBase
} from './git'
import { moveCommitDown, previewCommitMove } from './commitMove'
import {
  applyCarryExcludes,
  carryIntoWorktree,
  detectCarryItems,
  missingCarryPaths,
  validateCarryPath
} from './carry'
import { getWorkspacePrStatus, invalidateWorkspacePr } from './prCache'
import {
  buildStackFromGhStack,
  buildStackFromPrs,
  detectArchiveSuggestion,
  detectBaseMismatch
} from './stack'
import { getRepoStacks, getStackForPr } from './ghStack'
import type { GhStackInfo } from './ghStack'
import { findFreePort, waitForPortFree } from './net'
import {
  getPrStatus,
  getPrChecks,
  getCiFailureLogs,
  getPrMeta,
  getPrHeadSha,
  createPrWeb,
  mergePr,
  closePr,
  reopenPr,
  markPrReady,
  getPrEditable,
  editPr,
  retargetPr,
  listOpenPrs,
  listOpenPrCandidates,
  resolvePrCandidate,
  listOpenIssues,
  getIssueBody,
  getPrBody,
  annotatePrCandidates,
  getViewerLogin,
  getBaseRepoWritable,
  fetchOwnerAvatarDataUrl
} from './github'
import { planMergeTrain, runMergeTrain, type TrainLayer } from './mergeTrain'
import { buildCiFixPrompt, decideCiFix, CI_FIX_MAX_ATTEMPTS } from './ciFix'
import { ReviewManager } from './review/manager'
import { resolveStackForPr } from './review/stackResolve'
import type {
  FileWriteResult,
  MigrationImportResult,
  MigrationImportSelection,
  MigrationScan,
  MigrationScanArgs,
  ReviewVerdict,
  TranscriptSearchResult
} from '@shared/types'
import {
  cascadeRetarget,
  cascadeRestackBranchStack,
  detectRemoteDivergence,
  divergedMessage,
  divergedStep,
  isDiverged,
  stepFromRestack
} from './cascade'
import type { StackProgressSink } from './cascade'
import { buildConflictPrompt, pickAutoResolveStep } from './conflictResolve'
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
  agentSwitchNeedsHandoff,
  canSwitchAgentBackend,
  isBranchStack,
  normalizePermissionMode,
  reorderById,
  reorderWorkspaceStack,
  usableDefaultBackend,
  workspaceStackRootId,
  workspaceStack
} from '@shared/types'
import {
  adoptFanoutWinner,
  createFanout,
  forgetFanoutGroup,
  pruneFanoutGroups,
  type CreateFanoutDeps
} from './fanout'
import { resolveToolPermission } from './agent/tools/permission'
import { runAgentTool } from './agent/tools'
import { parseWooiCommandArgs, WOOI_COMMANDS } from '@shared/wooiCommands'
import { appendMemory } from './claude/memory'
import { claudeConfigPath, mcpInventory } from './claude/mcp'
import { externalClaudeMcpSetupCommand } from './paths'
import {
  archiveWorkspace,
  carryIntoNewWorktree,
  carrySuggestionsFor,
  createWorkspace,
  portEnvName,
  runArchiveScript,
  scriptEnvFor,
  syncPrBase,
  workspaceForkError,
  type ArchiveOutcome,
  type ArchiveWorkspaceDeps,
  type CreateWorkspaceDeps
} from './workspaces'
import type {
  AdoptFanoutResult,
  AgentBackendId,
  AppState,
  AppSettings,
  CarryFailure,
  CodexMcpServer,
  CodexPluginDetail,
  CodexPluginInventory,
  CodexPluginRef,
  CarryItem,
  ChatItem,
  CommitEntry,
  CommitMovePreview,
  CommitMoveResult,
  CreateFanoutArgs,
  CreateFanoutResult,
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
  PendingPeerMessage,
  PeerInboundPolicy,
  PermissionMode,
  PermissionRequest,
  PrMergeMethod,
  Repo,
  RestackResult,
  RewindActionResult,
  SavedPrompt,
  StackCascadeResult,
  StackCascadeStep,
  StackOpProgress,
  StackedBranch,
  StackSyncPlan,
  StackTrainPlan,
  StackTrainResult,
  UpdateFromBaseResult,
  DiscardHunkResult,
  Workspace
} from '@shared/types'
import type { AgentOrchestrator } from './agent/orchestrator'
import { deliverApprovedPeerMessage } from './agent/tools/peer'
import { resolvePeerMessage } from './agent/tools/peerLedger'
import { stackedWaits } from './stackedWait'
import type { PaneWindows } from './paneWindows'
import {
  cancelPreviewPick,
  capturePreview,
  forgetPreviewGuest,
  pickPreviewElement,
  previewIssues,
  watchPreviewIssues
} from './preview'
import type { ScriptRunner } from './scripts'
import type { TerminalManager } from './terminal'

/** 단방향 이벤트를 모든 창에 방송하는 함수. main 엔트리가 소유한 것 하나를 공유한다. */
type Dispatch = (channel: string, payload: unknown) => void

interface IpcContext {
  sessions: AgentOrchestrator
  scripts: ScriptRunner
  terminals: TerminalManager
  panes: PaneWindows
  /**
   * main 엔트리의 dispatch 를 그대로 받는다. registerIpc 가 자체 dispatch 를 갖고 있으면
   * 원격 미러가 이쪽 방송을 통째로 놓친다 — 이벤트 출구는 프로세스에 하나여야 한다.
   */
  dispatch: Dispatch
  getWindow: () => BrowserWindow | null
}

export function registerIpc(ctx: IpcContext): void {
  const store = getStore()
  const { dispatch } = ctx
  const mergeTrainPlans = new Map<
    string,
    {
      branches: string[]
      headShas: Record<string, string | null>
      plannedAt: number
      mergeableCount: number
    }
  >()

  /**
   * 전체 상태 스냅샷을 방송한다.
   *
   * 반드시 ctx.dispatch 를 거친다 — 창에 직접 보내면 그 방송은 원격 미러를 통째로 우회한다
   * (미러는 dispatch 출구에만 붙어 있다). 이름 바꾸기·음소거·권한 모드처럼 IPC 핸들러가
   * 바꾸는 것들이 폰에 영영 반영되지 않던 원인이 이것이었다: 폰은 에이전트 매니저가 따로
   * dispatch 하는 다음 방송을 만날 때까지 옛 상태를 들고 있었다.
   */
  const broadcastState = (): void => {
    dispatch(IPC.evtState, store.getState())
  }

  /**
   * 충돌한 워크트리의 에이전트에게 해결을 맡긴다. 실제로 충돌이 있을 때만 보낸다.
   * 트리거 지점을 한 함수로 모아 두는 이유는 restack·캐스케이드·머지 트레인 셋이 같은 충돌을
   * 서로 다른 자리에서 만들기 때문이다. 토큰을 쓰기 직전의 검증과 대화 기록 정책이 세 경로에서
   * 갈리면, 어느 하나만 조용히 규칙을 벗어나도 알아채기 어렵다.
   */
  const startConflictResolve = async (
    workspaceId: string,
    opts: { auto: boolean }
  ): Promise<{ error?: string; started?: boolean }> => {
    const ws = store.getState().workspaces.find((workspace) => workspace.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }

    const { rebasing, branch, conflictedFiles } = await rebaseConflictState(ws.worktreePath)
    if (!rebasing || conflictedFiles.length === 0) {
      return { error: 'No rebase conflict is currently waiting in this workspace.' }
    }
    // 모델 B 스택은 엔트리마다 체크아웃한 뒤 rebase 하므로, 충돌한 브랜치가 워크스페이스에 기록된
    // ws.branch 와 다를 수 있다. git 이 알려 준 브랜치를 우선하고 base 도 그 엔트리에서 찾는다 —
    // 프롬프트가 엉뚱한 브랜치를 지목하면 에이전트가 자기가 어디에 서 있는지 모른 채 시작한다.
    const conflictedBranch = branch ?? ws.branch
    const entry = workspaceStack(ws).find((e) => e.branch === conflictedBranch)
    const prompt = buildConflictPrompt({
      branch: conflictedBranch,
      baseBranch: entry?.baseBranch ?? ws.baseBranch,
      conflictedFiles,
      auto: opts.auto
    })
    try {
      // 이 전송은 토큰을 쓰게 된 이유 그 자체라 transcript 에 남아야 한다. 그래서 silent 나 prefix 를
      // 쓰지 않는다. running 가드도 두지 않는다 — Claude 는 SDK 입력 큐에 enqueue 하고, Codex 는
      // 진행 중인 턴에 네이티브 steering 하므로 두 백엔드 모두 mid-turn 전송을 받아들인다.
      //
      // origin 은 화면에서 이 전문을 한 줄로 접기 위한 표식이다([[types]] ConflictResolveOrigin).
      // 감추는 것과는 다르다 — 본문은 그대로 기록되고 한 번 눌러 펼치면 전부 보인다.
      await ctx.sessions.sendMessage(workspaceId, prompt, undefined, {
        origin: {
          kind: 'conflictResolve',
          branch: conflictedBranch,
          fileCount: conflictedFiles.length,
          auto: opts.auto
        }
      })
      return { started: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * CI 실패를 에이전트에게 넘긴다. [[conflictResolve]] 의 `startConflictResolve` 와 같은 자리다 —
   * 토큰을 쓰기 직전의 검증과 대화 기록 정책을 한 함수에 모아 둔다.
   *
   * 부르는 쪽은 값싼 신호(PR 상태가 'ci_failed')만 보고 여기까지 온다. **비싼 확인은 여기서**
   * 한다 — 롤업을 다시 읽어 정말 끝난 실패인지 보고(다른 체크가 아직 돌고 있을 수 있다),
   * 시도 횟수 상한을 확인하고, 그 다음에야 로그를 가져온다.
   */
  const ciFixInFlight = new Set<string>()

  const maybeStartCiFix = async (workspaceId: string): Promise<void> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived || !ws.autoFixCi) return

    // 이 판정은 gh 를 두 번 왕복하는 동안 armed 를 읽고 쓴다. 폴링이 겹쳐 두 번 들어오면
    // 둘 다 잠기기 전의 armed 를 보고 턴을 두 번 열 수 있다 — 상한을 세는 기능에서 그건
    // 그냥 버그다. 워크스페이스당 한 번에 하나만 돌게 막는다.
    if (ciFixInFlight.has(workspaceId)) return
    ciFixInFlight.add(workspaceId)
    try {
      await evaluateCiFix(ws.id, ws.worktreePath)
    } finally {
      ciFixInFlight.delete(workspaceId)
    }
  }

  const evaluateCiFix = async (workspaceId: string, worktreePath: string): Promise<void> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return

    const checks = await getPrChecks(worktreePath).catch(() => null)
    const decision = decideCiFix({
      enabled: true,
      running: ws.status === 'running',
      checks,
      prev: ws.autoFixCiState ?? null
    })

    /**
     * 판정 결과를 워크스페이스에 적고, 렌더러가 보는 값이 바뀌었으면 방송한다.
     *
     * 값이 같으면 방송하지 않는다 — 이 함수는 폴링마다 도는데, 대부분의 폴링은 아무것도
     * 바꾸지 않는다. 그때마다 방송하면 토글을 켠 워크스페이스 수만큼, 아무것도 바꾸지 못하는
     * 상태 방송이 45 초마다 반복된다([[prStatusCache]] 가 같은 이유로 같은 일을 한다).
     */
    const persist = (): void => {
      const before = JSON.stringify(ws.autoFixCiState ?? null)
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        if (decision.state) w.autoFixCiState = decision.state
        else delete w.autoFixCiState
      })
      if (before !== JSON.stringify(decision.state ?? null)) broadcastState()
    }

    if (decision.kind === 'idle') {
      persist()
      return
    }

    if (decision.kind === 'stop') {
      persist()
      // 조용히 포기하지 않는다. 켜 두고 잊은 사람에게는 "왜 안 고쳐졌지" 보다 "여기서
      // 멈췄다" 가 필요하고, 멈춘 자리가 곧 사람이 이어받을 자리다.
      const item: ChatItem = {
        id: `system:ci-fix-stop:${Date.now()}`,
        type: 'system',
        text: `Checks are still failing after ${CI_FIX_MAX_ATTEMPTS} automatic attempts (${decision.failed
          .map((c) => c.name)
          .join(
            ', '
          )}). Wooi stopped retrying — take it from here, or push a change to start the count over.`,
        ts: Date.now()
      }
      getTranscripts().upsert(workspaceId, item)
      dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
      return
    }

    // 로그는 정말 보낼 때만 가져온다 — `gh run view --log-failed` 는 폴링마다 부를 것이 아니다.
    const logs = await getCiFailureLogs(ws.worktreePath, decision.failed).catch(() =>
      decision.failed.map((c) => ({ checkName: c.name }))
    )
    const prompt = buildCiFixPrompt({
      prNumber: checks?.prNumber ?? ws.prNumber ?? 0,
      prUrl: checks?.prUrl ?? '',
      failed: decision.failed,
      logs,
      attempt: decision.state.attempts,
      max: CI_FIX_MAX_ATTEMPTS
    })

    try {
      // 상태를 **보내기 전에** 적는다. 전송이 오래 걸리는 사이 다음 폴링이 같은 실패를 보고
      // 또 열면, 상한을 세는 의미가 없어진다.
      persist()
      // conflictResolve 와 같은 정책이다 — 이 전송은 토큰을 쓰게 된 이유 그 자체라 transcript 에
      // 남아야 하므로 silent 나 prefix 를 쓰지 않는다. origin 은 화면에서 한 줄로 접기 위한 표식이다.
      await ctx.sessions.sendMessage(workspaceId, prompt, undefined, {
        origin: {
          kind: 'ciFix',
          prNumber: checks?.prNumber ?? 0,
          failedChecks: decision.failed.map((c) => c.name),
          attempt: decision.state.attempts,
          max: CI_FIX_MAX_ATTEMPTS
        }
      })
    } catch {
      // 보내지 못했으면 이 시도는 없었던 것으로 되돌린다 — 실패한 전송으로 상한을 축내면
      // 정작 고칠 수 있었을 기회가 줄어든다.
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (w)
          w.autoFixCiState = {
            ...decision.state,
            attempts: decision.state.attempts - 1,
            armed: true
          }
      })
      broadcastState()
    }
  }

  const stackProgress = (
    workspaceId: string,
    kind: StackOpProgress['kind'],
    total: number | null
  ): { sink: StackProgressSink; finish: () => void } => {
    const state: StackOpProgress = {
      workspaceId,
      kind,
      total,
      done: [],
      current: null,
      finished: false,
      startedAt: Date.now()
    }
    // 단계 배열은 뒤에서 계속 자라므로 매 방송마다 복사한다. preload 경계를 건넌 사진이 다음
    // 단계 때문에 뒤늦게 바뀌는 일은 없어야 렌더러가 받은 순서를 그대로 믿을 수 있다.
    const emit = (): void => dispatch(IPC.evtStackProgress, { ...state, done: [...state.done] })
    emit()
    return {
      sink: {
        start: (branch, stepKind) => {
          state.current = { branch, kind: stepKind }
          emit()
        },
        step: (step) => {
          state.done.push(step)
          state.current = null
          emit()
        }
      },
      finish: () => {
        state.current = null
        state.finished = true
        emit()
      }
    }
  }

  const repoFor = (repoId: string): Repo | undefined =>
    store.getState().repos.find((r) => r.id === repoId)

  /** 워크스페이스 생성이 메인에서 필요로 하는 것들([[workspaces]] createWorkspace). */
  const workspaceDeps: CreateWorkspaceDeps = {
    scripts: ctx.scripts,
    broadcastState,
    forkAgentSession: (source) => ctx.sessions.forkSession(source)
  }
  /** fan-out 은 생성에 더해 만든 후보에게 첫 프롬프트까지 보낸다([[fanout]]). */
  const fanoutDeps: CreateFanoutDeps = {
    ...workspaceDeps,
    sendMessage: (workspaceId, text, opts) =>
      ctx.sessions.sendMessage(workspaceId, text, undefined, opts)
  }
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

  handle(IPC.repoAdd, async (): Promise<{ repo?: Repo; error?: string }> => {
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

  handle(
    IPC.repoUpdate,
    async (
      _e,
      repoId: string,
      patch: Partial<
        Pick<
          Repo,
          'name' | 'setupScript' | 'runScripts' | 'archiveScript' | 'carryItems' | 'savedPrompts'
        >
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

      // 저장된 프롬프트도 IPC 가 신뢰 경계라 여기서 다시 본다. 이름 없는 항목은 목록에서 고를
      // 수 없고, 본문 없는 항목은 골라도 컴포저에 아무것도 채우지 못한다 — 둘 다 저장할 이유가
      // 없으므로 거른다. 편집 중 잠깐 비워 둔 행이 그대로 남지 않게 하는 효과도 같다.
      let prompts: SavedPrompt[] | undefined
      if (patch.savedPrompts) {
        prompts = patch.savedPrompts
          .map((item) => ({ ...item, name: item.name.trim(), prompt: item.prompt.trim() }))
          .filter((item) => item.name && item.prompt)
        const names = new Set<string>()
        for (const item of prompts) {
          const key = item.name.toLowerCase()
          if (names.has(key)) return { error: `Saved prompt name “${item.name}” is duplicated.` }
          names.add(key)
        }
      }

      store.update((st) => {
        const repo = st.repos.find((r) => r.id === repoId)
        if (repo)
          Object.assign(
            repo,
            patch,
            normalized ? { carryItems: normalized } : {},
            prompts ? { savedPrompts: prompts } : {}
          )
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
  handle(
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

  /**
   * 설정 모달이 "이 경로는 리포 루트에 없다" 를 저장 전에 보여 주기 위한 존재 확인.
   * 렌더러는 파일시스템을 볼 수 없어 여기로 물어 온다(경로 형태 검증은 renderer 가 이미 한다).
   */
  handle(
    IPC.repoMissingCarryPaths,
    async (_e, repoId: string, paths: string[]): Promise<string[]> => {
      const repo = repoFor(repoId)
      if (!repo) return []
      return missingCarryPaths(repo.path, paths)
    }
  )

  handle(IPC.repoRemove, async (_e, repoId: string) => {
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
  handle(IPC.repoReorder, (_e, repoId: string, targetRepoId: string, position: DropPosition) => {
    store.update((st) => {
      st.repos = reorderById(st.repos, repoId, targetRepoId, position)
    })
    broadcastState()
  })

  handle(
    IPC.workspaceReorder,
    (_e, workspaceId: string, targetWorkspaceId: string, position: DropPosition) => {
      const { workspaces } = store.getState()
      const draggedRootId = workspaceStackRootId(workspaces, workspaceId)
      const targetRootId = workspaceStackRootId(workspaces, targetWorkspaceId)
      const dragged = workspaces.find((w) => w.id === draggedRootId)
      const target = workspaces.find((w) => w.id === targetRootId)
      if (!dragged || !target) return

      // 어느 행을 잡아도 그 stack 의 뿌리를 찾아 DFS 묶음 전체를 옮긴다. 부모를 바꾸는 것은
      // 베이스 브랜치를 갈아 끼우는 git 작업이라 드래그로 다루지 않는다. 렌더러도 같은 레포·
      // 아카이브·고정 영역 규칙으로 드롭을 막지만, IPC 는 신뢰 경계이므로 여기서 다시 확인한다.
      if (dragged.repoId !== target.repoId) return
      if (dragged.archived !== target.archived) return
      if (!!dragged.sidebarPinned !== !!target.sidebarPinned) return

      store.update((st) => {
        st.workspaces = reorderWorkspaceStack(
          st.workspaces,
          workspaceId,
          targetWorkspaceId,
          position
        )
      })
      broadcastState()
    }
  )

  handle(IPC.workspaceSetPinned, (_e, workspaceId: string, pinned: boolean) => {
    store.update((st) => {
      const rootId = workspaceStackRootId(st.workspaces, workspaceId)
      const root = st.workspaces.find((w) => w.id === rootId)
      if (!root || root.archived) return
      root.sidebarPinned = pinned
      if (!pinned) return
      const firstRoot = st.workspaces.find(
        (w) =>
          w.repoId === root.repoId &&
          !w.archived &&
          workspaceStackRootId(st.workspaces, w.id) === w.id
      )
      if (firstRoot && firstRoot.id !== root.id)
        st.workspaces = reorderWorkspaceStack(st.workspaces, root.id, firstRoot.id, 'before')
    })
    broadcastState()
  })

  handle(IPC.repoListBranches, async (_e, repoId: string): Promise<string[]> => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listBranches(repo.path).catch(() => [repo.defaultBranch])
  })

  handle(IPC.repoListIssues, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listOpenIssues(repo.path).catch(() => [])
  })

  handle(IPC.repoListPrs, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    if (!repo) return []
    try {
      const [candidates, viewerLogin, baseRepoWritable] = await Promise.all([
        listOpenPrCandidates(repo.path),
        getViewerLogin(repo.path),
        getBaseRepoWritable(repo.path)
      ])
      return annotatePrCandidates(candidates, viewerLogin, baseRepoWritable)
    } catch {
      return []
    }
  })

  handle(IPC.repoResolvePr, async (_e, repoId: string, reference: string) => {
    const repo = repoFor(repoId)
    if (!repo || typeof reference !== 'string') return null
    return resolvePrCandidate(repo.path, reference).catch(() => null)
  })

  handle(IPC.repoGetIssueBody, async (_e, repoId: string, number: number) => {
    const repo = repoFor(repoId)
    if (!repo) return null
    return getIssueBody(repo.path, number).catch(() => null)
  })

  handle(IPC.repoGetPrBody, async (_e, repoId: string, number: number) => {
    const repo = repoFor(repoId)
    if (!repo) return null
    return getPrBody(repo.path, number).catch(() => null)
  })

  // ── 다른 도구에서 옮겨오기 ────────────────────────────────────────────────

  /**
   * 스캔과 들여오기가 같은 deps 를 본다. 들여오기는 이 deps 로 **다시 스캔해** 키를 대조하므로,
   * 렌더러가 보낸 것 중 실제로 쓰이는 것은 키 문자열뿐이다(경로·이름은 전부 재확인된 값).
   */
  const migrationDeps = {
    env: { home: app.getPath('home'), appData: app.getPath('appData') },
    getState: () => store.getState(),
    update: (mutate: (state: Pick<AppState, 'repos' | 'workspaces'>) => void) =>
      store.update(mutate),
    onRepoAdded: (repoId: string) => void backfillRepoAvatar(repoId),
    // 이어받은 대화(안내 한 줄 + 다른 도구에서 옮겨 온 지난 메시지)를 트랜스크립트에 적재한다.
    noteImport: (workspaceId: string, items: ChatItem[]) =>
      getTranscripts().importItems(workspaceId, items)
  }

  handle(IPC.migrateScan, (_e, args?: MigrationScanArgs): Promise<MigrationScan> =>
    scanMigration({ repoId: typeof args?.repoId === 'string' ? args.repoId : null }, migrationDeps)
  )

  handle(
    IPC.migrateImport,
    async (_e, selection: MigrationImportSelection): Promise<MigrationImportResult> => {
      const keys = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
      const result = await importMigration(
        {
          repoKeys: keys(selection?.repoKeys),
          workspaceKeys: keys(selection?.workspaceKeys),
          sessionKeys: keys(selection?.sessionKeys)
        },
        migrationDeps
      )
      if (result.repos > 0 || result.workspaces > 0) broadcastState()
      return result
    }
  )

  // ── workspace ────────────────────────────────────────────────────────────

  handle(
    IPC.workspaceCreate,
    async (_e, args: CreateWorkspaceArgs): Promise<CreateWorkspaceResult> =>
      createWorkspace(workspaceDeps, args)
  )

  handle(
    IPC.workspaceFork,
    async (
      _e,
      workspaceId: string,
      opts?: { name?: string; showSemanticsNotice?: boolean }
    ): Promise<CreateWorkspaceResult> => {
      const source = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!source || source.archived) return { error: 'Workspace not found (or archived).' }
      const guardError = workspaceForkError(source)
      if (guardError) return { error: guardError }
      return createWorkspace(workspaceDeps, {
        repoId: source.repoId,
        forkFromWorkspaceId: source.id,
        forkSemanticsNotice: opts?.showSemanticsNotice === true,
        ...(opts?.name?.trim() ? { name: opts.name.trim() } : {})
      })
    }
  )

  // 아카이브 절차 자체는 [[workspaces]] 에 있다 — 에이전트 도구도 같은 일을 해야 하기 때문이다.
  // 아카이브 스크립트가 실패했으면 그 결과를 실어 보낸다(렌더러가 토스트로 알린다).
  handle(IPC.workspaceArchive, async (_e, workspaceId: string): Promise<ArchiveOutcome> => {
    stackedWaits.cancel(workspaceId)
    return archiveWorkspace(archiveDeps, workspaceId)
  })

  handle(IPC.workspaceCancelStackedWait, (_e, workspaceId: string) => {
    stackedWaits.cancel(workspaceId, true)
  })

  /**
   * 아카이브 제안을 해제한다. 어떤 병합을 해제했는지 기억해 두지 않으면 다음 재동기화가 같은
   * 병합을 다시 감지해 배너가 계속 뜬다("해제" = 이 워크스페이스는 아직 쓸 일이 있다는 뜻).
   */
  handle(IPC.workspaceArchiveSuggestDismiss, async (_e, workspaceId: string): Promise<void> => {
    let changed = false
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w?.archiveSuggest) return
      w.archiveSuggestDismissed = w.archiveSuggest.mergedBranch
      w.archiveSuggest = null
      changed = true
    })
    if (changed) broadcastState()
  })

  /**
   * 대기 중인 peer 메시지를 전달한다 — 여기가 **턴 비용을 승인하는 자리**다.
   *
   * 먼저 큐에서 꺼내고 나서 보낸다. 순서를 뒤집으면 전달은 됐는데 큐에서 안 빠진 창이 남아
   * 같은 메시지를 두 번 보낼 수 있다(창이 둘이면 실제로 그렇게 된다).
   *
   * 보관해 둔 `text` 를 그대로 보낸다 — 출처 문단은 받은 순간에 이미 씌워져 있고, 지금
   * 다시 만들면 발신 워크스페이스가 사라진 경우 근거가 없다([[types]] PendingPeerMessage).
   */
  handle(
    IPC.workspacePeerInboxDeliver,
    async (_e, workspaceId: string, messageId: string): Promise<void> => {
      let pendingMessage: PendingPeerMessage | null = null
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        const pending = w?.peerInbox?.find((m) => m.id === messageId)
        if (!w || !pending) return
        pendingMessage = pending
        w.peerInbox = w.peerInbox?.filter((m) => m.id !== messageId)
      })
      // 이미 다른 창이 처리했거나 워크스페이스가 사라졌으면 조용히 끝낸다.
      if (pendingMessage === null) return
      const pending = pendingMessage as PendingPeerMessage
      deliverApprovedPeerMessage(
        { sendMessage: (id, text, opts) => ctx.sessions.sendMessage(id, text, undefined, opts) },
        workspaceId,
        pending
      )
      broadcastState()
    }
  )

  /** 대기 중인 peer 메시지를 버린다. 발신 쪽에는 알리지 않는다 — 거절도 사용자의 사정이다. */
  handle(
    IPC.workspacePeerInboxDismiss,
    async (_e, workspaceId: string, messageId: string): Promise<void> => {
      let dismissed: PendingPeerMessage | null = null
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        const pending = w?.peerInbox?.find((m) => m.id === messageId)
        if (!w || !pending) return
        dismissed = pending
        w.peerInbox = w.peerInbox?.filter((m) => m.id !== messageId)
      })
      if (dismissed !== null) {
        const pending = dismissed as PendingPeerMessage
        resolvePeerMessage(pending.fromWorkspaceId, pending.id, 'declined-by-user')
        broadcastState()
      }
    }
  )

  /**
   * 수신 정책을 바꾼다. `accept` 로 열면 대기 중이던 것도 함께 흘려보낸다 — 정책을 열어 놓고
   * 이미 와 있던 메시지만 계속 대기 상태로 남기면 사용자가 "왜 안 오지" 를 겪는다.
   */
  handle(
    IPC.workspaceSetPeerInbound,
    async (_e, workspaceId: string, policy: PeerInboundPolicy): Promise<void> => {
      const release: PendingPeerMessage[] = []
      const declined: PendingPeerMessage[] = []
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        w.peerInbound = policy
        if (policy === 'accept') {
          for (const m of w.peerInbox ?? []) release.push(m)
          w.peerInbox = []
        }
        // 'refuse' 로 닫으면 대기 중이던 것도 버린다 — 받지 않겠다고 한 뒤에 남아 있는 승인
        // 카드는 그 선언과 모순이다.
        if (policy === 'refuse') {
          for (const m of w.peerInbox ?? []) declined.push(m)
          w.peerInbox = []
        }
      })
      for (const pending of declined) {
        resolvePeerMessage(pending.fromWorkspaceId, pending.id, 'declined-by-user')
      }
      for (const pending of release) {
        deliverApprovedPeerMessage(
          { sendMessage: (id, text, opts) => ctx.sessions.sendMessage(id, text, undefined, opts) },
          workspaceId,
          pending
        )
      }
      broadcastState()
    }
  )

  // 언아카이브: 브랜치로부터 worktree 를 복원한다.
  handle(
    IPC.workspaceUnarchive,
    async (
      _e,
      workspaceId: string
    ): Promise<{
      error?: string
      carryFailures?: CarryFailure[]
      carryMissing?: string[]
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
      const { failures: carryFailures, missing: carryMissing } = await carryIntoNewWorktree(
        repo,
        ws.worktreePath
      )
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
      return { carryFailures, carryMissing, carrySuggestions: carrySuggestionsFor(repo) }
    }
  )

  // 영구 삭제: 아카이브와 달리 되돌릴 수 없다 — worktree·대화 기록에 더해 (deleteBranch 면)
  // 브랜치까지 지우고 워크스페이스 레코드 자체를 목록에서 없앤다. 아카이브된 것뿐 아니라
  // 살아 있는 워크스페이스에도 쓰인다(사이드바 메뉴 · ⌥⌘⌫ · 생성 되돌리기).
  handle(
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
      // 지워진 후보가 fan-out 그룹에 남아 있으면 비교 화면이 없는 워크스페이스 칸을 그린다.
      pruneFanoutGroups([workspaceId])
      broadcastState()
      return archiveScriptFailure ? { archiveScriptFailure } : {}
    }
  )

  // 일괄 삭제: 한 레포의 아카이브된 워크스페이스를 모두 영구 제거한다.
  // 단건 remove 와 동일한 정리 절차(세션·스크립트·터미널·기록·worktree·브랜치)를 각 항목에
  // 적용하되, 상태 갱신·broadcast 는 마지막에 한 번만 수행한다.
  handle(IPC.workspaceRemoveArchived, async (_e, repoId: string): Promise<{ count: number }> => {
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
      pruneFanoutGroups(targets.map((w) => w.id))
      broadcastState()
    }
    return { count: targets.length }
  })

  // ── fan-out (같은 프롬프트를 후보 여럿에게) ─────────────────────────────

  handle(IPC.fanoutCreate, async (_e, args: CreateFanoutArgs): Promise<CreateFanoutResult> =>
    createFanout(fanoutDeps, args)
  )

  // 형제 아카이브는 되돌릴 수 있지만(브랜치·PR·대화는 남는다) 미커밋 변경은 사라진다.
  // 그래서 확인은 렌더러가 무엇을 잃는지 세어 먼저 받고, 여기서는 다시 묻지 않는다.
  handle(
    IPC.fanoutAdopt,
    async (_e, groupId: string, workspaceId: string): Promise<AdoptFanoutResult> =>
      adoptFanoutWinner(archiveDeps, groupId, workspaceId)
  )

  handle(IPC.fanoutForget, (_e, groupId: string) => {
    forgetFanoutGroup(broadcastState, groupId)
  })

  handle(IPC.workspaceSetPermissionMode, async (_e, workspaceId: string, mode: PermissionMode) => {
    await ctx.sessions.setPermissionMode(workspaceId, mode)
    broadcastState()
  })

  handle(IPC.workspaceSetModel, (_e, workspaceId: string, model: string | null) => {
    ctx.sessions.setModel(workspaceId, model)
    broadcastState()
  })

  handle(IPC.workspaceSetEffort, (_e, workspaceId: string, effort: EffortSetting | null) => {
    ctx.sessions.setEffort(workspaceId, effort)
    broadcastState()
  })

  handle(IPC.workspaceSetFastMode, (_e, workspaceId: string, fastMode: boolean | null) => {
    ctx.sessions.setFastMode(workspaceId, fastMode)
    broadcastState()
  })

  /**
   * 메인 에이전트 교체([[canSwitchAgentBackend]]). 대화 도중에도 되며, 그때는 지금까지의 대화를
   * 새 에이전트에게 넘겨 준다([[agentSwitchNeedsHandoff]]) — 그 인수인계 한 번이 통째로 입력
   * 토큰이라 사용량이 드는 일이므로, 렌더러가 사용자에게 확인받았다는 표시(`handoff`)를 함께
   * 보내야 한다.
   *
   * 규칙은 렌더러와 같은 함수를 쓰지만 판정 재료는 여기서 다시 읽는다 — 렌더러의 화면이 낡았거나
   * (경고를 띄우지 않던 사이에 첫 메시지가 나갔거나) 다른 창에서 이미 대화가 시작됐을 수 있고,
   * 그때 그대로 바꿔 주면 사용자가 비용을 승낙한 적 없는 턴이 돈다.
   */
  handle(
    IPC.workspaceSetAgentBackend,
    async (
      _e,
      workspaceId: string,
      agentBackend: AgentBackendId,
      opts?: { handoff?: boolean }
    ): Promise<{ error?: string }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }
      if (ws.agentBackend === agentBackend) return {}
      if (!canSwitchAgentBackend(ws)) {
        return {
          error: ws.archived
            ? 'This workspace is archived.'
            : 'Stop the current turn before switching agents.'
        }
      }

      const items = getTranscripts().load(workspaceId)
      const needsHandoff = agentSwitchNeedsHandoff(ws, items.length)
      if (needsHandoff && !opts?.handoff) {
        return {
          error:
            'This conversation has already started — switching agents sends a compact workspace checkpoint to the new agent. Confirm the switch to continue.'
        }
      }

      // 등록 여부·가용성(CLI 설치·버전)을 카탈로그에서 확인한다. 쓸 수 없는 에이전트로 갈아타면
      // 워크스페이스가 다음 메시지에서야 실패하므로, 그 전에 이유를 그대로 돌려준다.
      const backends = await ctx.sessions.listBackends()
      const target = backends.find((b) => b.id === agentBackend)
      if (!target) return { error: 'Unknown agent.' }
      if (!target.available) {
        return { error: target.unavailableReason ?? `${target.label} is not available.` }
      }
      const fromLabel = backends.find((b) => b.id === ws.agentBackend)?.label ?? ws.agentBackend

      // 넘길 대화가 실제로 있는지는 지금 만들어 봐야 안다(기록이 result·thinking 뿐일 수 있다).
      // 크기는 안내에만 쓰고, 실제로 보낼 프롬프트는 보낼 때 다시 만든다([[agent/orchestrator]]).
      const handoffPrompt = needsHandoff ? buildHandoffPrompt({ items, fromLabel }) : null

      // 살아 있는 세션은 **바꾸기 전에** 정리한다 — agentBackend 를 바꾸고 나면 라우팅이 새
      // 백엔드로 가서 옛 세션(과 그 CLI 프로세스)에 손이 닿지 않는다.
      ctx.sessions.dispose(workspaceId)
      // 새 백엔드는 새 세션이라 맥락도 처음부터다. 옛 에이전트의 사용량을 남겨 두면 인수인계
      // 턴이 값을 다시 보내 줄 때까지 폰의 게이지가 엉뚱한 양을 가리킨다.
      forgetContextUsage(workspaceId)
      // 토큰 장부도 같이 비운다 — 장부의 단위는 "지금 이 대화" 라, 옛 에이전트가 쓴 토큰이
      // 새 대화의 장부에 남아 있으면 읽는 사람을 속인다([[usageLedger]]).
      forgetWorkspaceUsage(workspaceId)
      forgetRunningAgents(workspaceId)

      const settings = store.getState().settings
      store.update((st) => {
        const w = st.workspaces.find((x) => x.id === workspaceId)
        if (!w) return
        w.agentBackend = agentBackend
        // sessionId 는 옛 백엔드의 것이라 새 백엔드에서는 의미가 없다. 그대로 두면 다음 메시지가
        // 남의 세션 id 로 resume 을 시도해 실패한다(claude/manager 의 resumeSessionId,
        // codex/manager 의 resumeThreadId). 비우면 새 세션이 열리고, 맥락은 아래 인수인계가 잇는다.
        w.sessionId = null
        // 인수인계는 여기서 보내지 않고 **다음 메시지에 얹어** 나간다. 여기서 한 턴을 돌리면
        // 사용자가 시작하지도 않은 그 턴에 곧바로 입력한 명령이 끼어들어(Codex 의 steering)
        // 엉뚱한 답이 돌아온다 — 실제로 겪은 증상이다([[shared/handoff]]).
        w.pendingHandoffFrom = handoffPrompt ? fromLabel : null
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

      // 무슨 일이 일어날지 기록에 남긴다. 넘기는 시점이 "지금" 이 아니라 "다음 메시지" 라서,
      // 이 줄이 없으면 확인까지 눌러 놓고 아무 일도 안 일어난 것처럼 보인다.
      if (handoffPrompt) {
        const item: ChatItem = {
          id: `system:agent-switch:${Date.now()}`,
          type: 'system',
          text: `Switched to ${target.label}. A compact workspace checkpoint goes with your next message (${formatHandoffTokens(estimateHandoffTokens(handoffPrompt))} tokens of input) — it can’t see any of it until then.`,
          ts: Date.now()
        }
        getTranscripts().upsert(workspaceId, item)
        dispatch(IPC.evtChat, { workspaceId, event: { type: 'item', item } })
      }

      return {}
    }
  )

  handle(IPC.workspaceSetMuted, (_e, workspaceId: string, muted: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.muted = muted
    })
    broadcastState()
  })

  handle(IPC.workspaceSetAutoFixCi, (_e, workspaceId: string, enabled: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (!w) return
      w.autoFixCi = enabled
      // 끄면 진행 상태도 버린다. 다시 켜는 것은 명시적인 사용자 동작이니, 그때는 남은 시도가
      // 0 인 채로 시작해 아무 일도 안 일어나는 대신 상한을 처음부터 받는 편이 맞다.
      if (!enabled) delete w.autoFixCiState
    })
    broadcastState()
  })

  /**
   * 멀티 에이전트 모드 전환(실험 기능).
   *
   * 위임 도구는 세션을 **열 때** 그 세션에 박히므로(claude/host.ts 의 ensure) 값만 바꾸면 도는
   * 세션에는 영영 반영되지 않는다. 그렇다고 여기서 끊으면 도는 중인 턴이 설정 변경만으로 죽는다
   * — 그래서 다음 전송 직전에 다시 열도록 예약한다([[agent/orchestrator]]). 배지가 약속하는
   * "다음 메시지부터" 가 그대로 참이 되고, 대화 맥락은 resume 으로 이어진다.
   */
  handle(IPC.workspaceSetMultiAgent, (_e, workspaceId: string, multiAgent: boolean) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.multiAgent = multiAgent
    })
    ctx.sessions.restartBeforeNextMessage(workspaceId)
    broadcastState()
  })

  // 표시 이름 수정: 사용자 override(displayName)만 바꾼다. worktree 이름(name)·브랜치는 그대로 둔다.
  // 빈 문자열을 넘기면 override 를 지워 기본 규칙(worktree 이름 → PR 제목)으로 되돌린다.
  handle(IPC.workspaceRename, (_e, workspaceId: string, name: string) => {
    const trimmed = name.trim()
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.displayName = trimmed || null
    })
    broadcastState()
  })

  handle(IPC.workspaceRevealInFinder, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (ws) shell.openPath(ws.worktreePath)
  })

  handle(IPC.workspaceOpenInEditor, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    openInEditor(ws.worktreePath)
  })

  // /memory 는 선택한 스코프의 파일을 먼저 만들어 언제나 바로 편집할 수 있게 한다. 에디터를 못
  // 띄워도 폴더를 Finder 로 여는 대신 파일 자체를 OS 기본 앱에 맡긴다 — 명령이 약속한 대상은
  // CLAUDE.md 이지 그 파일이 든 디렉토리가 아니다.
  handle(
    IPC.workspaceOpenMemory,
    (_e, workspaceId: string, scope: MemoryScope): { error?: string } => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return { error: 'Workspace not found.' }

      const file = memoryFile(scope, ws.worktreePath)
      try {
        if (!existsSync(file)) {
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, '')
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
      openInEditor(file)
      return {}
    }
  )

  // `#` 단축키 — 대화를 끊지 않고 CLAUDE.md 에 기억 한 줄을 덧붙인다.
  handle(
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
  handle(IPC.workspaceAddDir, (_e, workspaceId: string, dir: string) =>
    ctx.sessions.addDirectory(workspaceId, dir)
  )

  // ── 채팅 ───────────────────────────────────────────────────────────────

  handle(IPC.chatSend, (_e, workspaceId: string, text: string, images?: ImageAttachment[]) => {
    stackedWaits.resetUnproductive(workspaceId)
    ctx.sessions.sendMessage(workspaceId, text, images)
  })

  handle(IPC.chatInterrupt, (_e, workspaceId: string) => {
    stackedWaits.cancel(workspaceId, true)
    return ctx.sessions.interrupt(workspaceId)
  })

  handle(IPC.chatStopTask, (_e, workspaceId: string, taskId: string) => {
    return ctx.sessions.stopTask(workspaceId, taskId)
  })

  handle(IPC.chatSideQuestion, (_e, workspaceId: string, question: string) => {
    ctx.sessions.sideQuestion(workspaceId, question)
  })

  // /clear — 세션을 정리하고 대화 맥락(sessionId)·트랜스크립트를 비운다(워크스페이스는 유지).
  // 다음 메시지는 빈 맥락의 새 세션으로 시작한다. 렌더러는 호출 후 자기 트랜스크립트를 비운다.
  handle(IPC.chatClear, (_e, workspaceId: string) => {
    stackedWaits.cancel(workspaceId)
    ctx.sessions.clearSession(workspaceId)
    getTranscripts().remove(workspaceId)
    // 맥락이 빈 채로 다시 시작한다 — 게이지도 장부도 같이 비운다(렌더러도 resetTranscript 로
    // 그렇게 한다).
    forgetContextUsage(workspaceId)
    forgetWorkspaceUsage(workspaceId)
    forgetRunningAgents(workspaceId)
    // 넘기기로 예약해 둔 대화가 방금 사라졌다 — 예약도 함께 지운다.
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.pendingHandoffFrom = null
    })
    broadcastState()
  })

  handle(IPC.chatClearGoal, (_e, workspaceId: string) => {
    return ctx.sessions.clearGoal(workspaceId)
  })

  // 활성 워크스페이스의 누적 비용만 모아 돌려준다. 대화 기록을 렌더러로 옮기지 않기 위한
  // 통로다 — 화면에 필요한 건 숫자 하나인데, 예전에는 그것 때문에 전체 트랜스크립트가
  // 렌더러 힙에 올라간 채 매 토큰마다 다시 합산됐다.
  handle(IPC.chatGetCosts, (): Record<string, number> => {
    const costs: Record<string, number> = {}
    for (const w of store.getState().workspaces) {
      if (w.archived) continue
      costs[w.id] = getTranscripts().costOf(w.id)
    }
    return costs
  })

  handle(IPC.chatGetHistory, (_e, workspaceId: string, limit?: number) => {
    // limit 없이 부르면 예전처럼 전부 준다 — 부분 로딩된 창 밖으로 점프할 때 렌더러가 쓴다.
    if (typeof limit !== 'number') return getTranscripts().load(workspaceId)
    return getTranscripts().loadTail(workspaceId, limit)
  })

  // 워크스페이스를 가로지르는 대화 검색. 훑는 일은 전부 여기서 끝내고 렌더러에는 스니펫만
  // 넘긴다 — 워크스페이스가 수십 개일 때 원문을 넘기면 검색 한 번에 힙이 수백 MB 로 뛴다.
  // 아카이브된 워크스페이스도 기본 포함이다("그 결정 어디서 했더라" 의 답은 대개 거기 있다).
  handle(
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

  handle(IPC.permissionRespond, (_e, requestId: string, decision: PermissionDecision) => {
    ctx.sessions.respondPermission(requestId, decision)
    // Wooi 도구 승인은 백엔드가 아니라 메인이 띄운다([[agent/tools/permission]]). requestId 는
    // 어디서 나왔는지 구분되지 않으므로 양쪽에 흘리고, 자기 것이 아니면 무시한다.
    resolveToolPermission(requestId, decision)
    // 답한 요청은 더 이상 대기 중이 아니다 — 그 사실을 **방송**한다.
    //
    // 응답에는 전용 이벤트가 없어서 예전에는 원격 목록만 따로 지웠다. 그러면 폰에서 답했을 때
    // 데스크톱 렌더러는 아무 신호도 못 받아 답한 권한 카드가 화면에 그대로 남는다(실기기 확인).
    // 데스크톱에서 답할 때는 렌더러가 이미 낙관적으로 카드를 지우므로 이 방송이 무해한 no-op 이고,
    // 폰에서 답할 때는 이것이 유일한 신호다. dispatch 를 지나면 원격 미러도 같은 tap 에서
    // 대기 목록을 정리하므로(index.ts 의 mirrorToRemote), 정리 경로가 하나로 합쳐진다.
    dispatch(IPC.evtPermissionCancel, requestId)
  })

  /**
   * 지금 답을 기다리는 승인 요청 전부.
   *
   * 렌더러의 목록은 라이브 이벤트로만 차기 때문에(store.ts 의 onPermission), 창이 없던 동안
   * 올라온 요청은 창을 다시 열어도 보이지 않는다 — 그 사이 호스트는 아무도 답하지 않을
   * 프로미스에 매달린다. 목록은 폰이 쓰는 것을 그대로 재사용한다([[remote/permissions]]) —
   * 같은 질문에 두 개의 답을 두지 않는다.
   */
  handle(IPC.permissionPending, (): PermissionRequest[] => pendingPermissions.list())

  // ── 스크립트 ───────────────────────────────────────────────────────────

  handle(IPC.scriptRun, async (_e, workspaceId: string, scriptId: string) => {
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

  handle(IPC.scriptStop, (_e, workspaceId: string, scriptId: string) => {
    ctx.scripts.stop(workspaceId, scriptId)
  })

  handle(IPC.scriptGetStatus, (_e, workspaceId: string) => {
    return ctx.scripts.getStatus(workspaceId)
  })

  handle(IPC.scriptGetOutput, (_e, workspaceId: string, scriptId: string) => {
    return ctx.scripts.getOutput(workspaceId, scriptId)
  })

  // ── Preview 패널 ───────────────────────────────────────────────────────

  /** Preview 가 마지막으로 본 주소를 워크스페이스에 적어 둔다. 값이 그대로면 방송하지 않는다. */
  const rememberPreviewUrl = (workspaceId: string, url: string): boolean => {
    const current = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!current || current.previewUrl === url) return false
    store.update((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (ws) ws.previewUrl = url
    })
    broadcastState()
    return true
  }

  handle(IPC.previewSetUrl, (_e, workspaceId: string, url: string) => {
    rememberPreviewUrl(workspaceId, url)
  })

  // "Open in Preview" — 주소를 기억하고 모든 창에 방송한다. 스크립트 패널과 Preview 탭이 서로
  // 다른 창에 떠 있을 수 있어(둘 다 분리 가능) renderer 끼리 직접 이야기할 방법이 없다.
  handle(IPC.previewOpen, (_e, workspaceId: string, url: string) => {
    rememberPreviewUrl(workspaceId, url)
    dispatch(IPC.evtPreviewOpen, { workspaceId, url })
  })

  // 캡처는 main 이 한다(renderer 에는 webContents 가 없다). 찍은 이미지는 호출자에게 돌려주지
  // 않고 방송한다 — 컴포저는 메인 창에만 있고, 캡처를 누른 창은 분리된 work 창일 수 있다.
  handle(IPC.previewCapture, async (_e, workspaceId: string, webContentsId: number) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { error: 'That workspace is gone.' }
    const { image, error } = await capturePreview(ws.previewUrl ?? '', webContentsId)
    if (error || !image) return { error: error ?? 'Could not capture the preview.' }
    dispatch(IPC.evtComposerAttach, { workspaceId, image })
    return {}
  })

  // 요소 픽커. 사용자가 고를 때까지(또는 취소·타임아웃까지) 이 핸들러가 매달려 있는다 —
  // 렌더러는 그동안 "고르는 중" 을 보여 주고, 결과는 캡처와 같은 우편함으로 흘러간다.
  handle(IPC.previewPickElement, async (_e, workspaceId: string, webContentsId: number) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { error: 'That workspace is gone.' }
    const { attachment, error } = await pickPreviewElement(ws.previewUrl ?? '', webContentsId)
    if (error || !attachment) return { error: error ?? 'Could not read that element.' }
    dispatch(IPC.evtComposerAttach, { workspaceId, ...attachment })
    return {}
  })

  handle(IPC.previewCancelPick, (_e, webContentsId: number) => {
    cancelPreviewPick(webContentsId)
  })

  // 콘솔·네트워크 문제 수집. 목록은 여기서 당겨 가고, 개수만 evtPreviewIssues 로 방송된다
  // — 매 콘솔 줄을 IPC 로 밀면 폭주하는 dev 로그가 메인 힙을 밀어 올린다([[main/previewIssues]]).
  handle(IPC.previewWatchIssues, (_e, workspaceId: string, webContentsId: number) => {
    watchPreviewIssues(workspaceId, webContentsId)
  })

  handle(IPC.previewUnwatchIssues, (_e, webContentsId: number) => {
    previewIssues().unwatch(webContentsId)
    // 에이전트 도구가 이 워크스페이스의 게스트를 찾는 표도 같은 자리에서 지운다([[main/preview]]).
    forgetPreviewGuest(webContentsId)
  })

  handle(IPC.previewListIssues, (_e, workspaceId: string) => previewIssues().list(workspaceId))

  handle(IPC.previewClearIssues, (_e, workspaceId: string) => {
    previewIssues().clear(workspaceId)
  })

  handle(IPC.previewSendIssues, (_e, workspaceId: string, issueIds: string[]) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { error: 'That workspace is gone.' }
    const wanted = new Set(issueIds)
    const picked = previewIssues()
      .list(workspaceId)
      .filter((i) => wanted.has(i.id))
    if (!picked.length) return { error: 'Nothing to send.' }
    dispatch(IPC.evtComposerAttach, {
      workspaceId,
      text: formatIssues(picked, ws.previewUrl ?? '')
    })
    return {}
  })

  // ── 분리한 패널 창 ─────────────────────────────────────────────────────

  handle(IPC.paneOpen, (_e, kind: PaneKind, workspaceId: string | null) => {
    ctx.panes.open(kind, workspaceId)
  })

  handle(IPC.paneClose, (_e, kind: PaneKind) => {
    ctx.panes.close(kind)
  })

  handle(IPC.paneFocus, (_e, kind: PaneKind) => {
    ctx.panes.focus(kind)
  })

  handle(IPC.paneGetState, () => ctx.panes.state())

  handle(IPC.paneSetWorkspace, (_e, workspaceId: string | null) => {
    ctx.panes.setWorkspace(workspaceId)
  })

  // 분리한 창에는 리포 설정 모달이 없다(설정은 메인 창의 것이다). 요청을 메인 창으로 넘기고
  // 그 창을 앞으로 가져와, 보조 모니터에서 누른 버튼이 아무 일도 안 일어난 것처럼 보이지 않게 한다.
  handle(IPC.paneOpenRepoSettings, (_e, repoId: string) => {
    const win = ctx.getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC.evtOpenRepoSettings, repoId)
  })

  // 보조 모니터의 현황판에서 카드를 눌렀다. 현황판 창 자체는 계속 보드로 남아야 하므로
  // 선택은 메인 창에서 일어나야 한다 — 창을 앞으로 가져오고 그쪽에 선택을 넘긴다.
  handle(IPC.paneSelectWorkspace, (_e, workspaceId: string) => {
    const win = ctx.getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC.evtSelectWorkspace, workspaceId)
  })

  // ── git ────────────────────────────────────────────────────────────────

  handle(IPC.gitStatus, async (_e, workspaceId: string, force = true) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return getStatus(ws.worktreePath, ws.baseBranch, force).catch(() => null)
  })

  handle(IPC.gitFetch, async (_e, repoId: string) => {
    const repo = store.getState().repos.find((r) => r.id === repoId)
    if (!repo) return
    await fetchRemoteForRepo(repo.path, repo.id)
  })

  handle(IPC.gitDiff, async (_e, workspaceId: string) => {
    const st = store.getState()
    const ws = st.workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    // 비교 기준은 **여기서만** 읽는다. PR·rebase 대상은 계속 ws.baseBranch 가 소유한다
    // (경계의 근거는 [[compareBase]]). 리포를 못 찾으면 예전처럼 base 그대로 간다.
    const defaultBranch = st.repos.find((r) => r.id === ws.repoId)?.defaultBranch
    const base = defaultBranch
      ? compareBaseBranch({
          baseBranch: ws.baseBranch,
          defaultBranch,
          compareBase: ws.compareBase
        })
      : ws.baseBranch
    return getDiff(ws.worktreePath, base).catch(() => null)
  })

  /**
   * Changes 패널의 비교 기준을 바꾼다. **표시 전용** — 이 값은 IPC.gitDiff 말고 아무 데서도
   * 읽히지 않으며, PR 대상(ipc.ts 의 PR 생성)·rebase 대상(cascade)은 손대지 않는다.
   */
  handle(IPC.workspaceSetCompareBase, (_e, workspaceId: string, compareBase: unknown) => {
    store.update((st) => {
      const w = st.workspaces.find((x) => x.id === workspaceId)
      if (w) w.compareBase = normalizeCompareBase(compareBase)
    })
    broadcastState()
  })

  // base 브랜치를 현재 브랜치로 머지해 드리프트를 해소한다(충돌 시 워킹트리에 충돌이 남는다).
  handle(IPC.gitUpdateFromBase, async (_e, workspaceId: string): Promise<UpdateFromBaseResult> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) {
      return { status: 'error', baseBranch: '', message: 'Workspace not found.' }
    }
    return updateFromBase(ws.worktreePath, ws.baseBranch).catch((err) => ({
      status: 'error' as const,
      baseBranch: ws.baseBranch,
      message: err instanceof Error ? err.message : String(err)
    }))
  })

  handle(IPC.gitAbortMerge, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    await abortMerge(ws.worktreePath).catch(() => {})
  })

  /**
   * Changes 탭에서 고른 hunk 하나를 워킹 트리에서 버린다. 커밋도 스테이징도 하지 않는다.
   *
   * 턴이 도는 중이면 거절한다. 렌더러가 이미 버튼을 막아 두지만, 사용자가 버튼을 누른 뒤
   * git 이 파일을 여는 사이에 에이전트가 그 파일을 쓰기 시작할 수 있다 — 판정은 실제로
   * 되쓰기 직전인 여기서 한 번 더 해야 의미가 있다.
   */
  handle(
    IPC.gitDiscardHunk,
    async (_e, workspaceId: string, patch: string): Promise<DiscardHunkResult> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { status: 'error', message: 'Workspace not found.' }
      if (ws.status === 'running') {
        return {
          status: 'busy',
          message: 'The agent is working in this workspace. Wait for the turn to finish.'
        }
      }
      if (typeof patch !== 'string' || !patch.includes('@@')) {
        return { status: 'error', message: 'Nothing to discard.' }
      }
      return applyReversePatch(ws.worktreePath, patch).catch((err) => ({
        status: 'error' as const,
        message: err instanceof Error ? err.message : String(err)
      }))
    }
  )

  /**
   * 모델 B 스택(단일 worktree · N 브랜치)을 아래→위로 순차 rebase 한다. 각 상위 브랜치를 이전
   * tip 기준으로 `--onto` 재배치해(중복 커밋 없이) 정확히 옮긴다. 충돌/dirty 시 그 브랜치에 멈춰
   * worktree 를 남겨 두고 결과를 돌려준다. 성공하면 원래 체크아웃 브랜치로 되돌아온다.
   */
  const restackWholeStack = async (
    workspaceId: string,
    worktreePath: string,
    stack: StackedBranch[],
    returnTo: string,
    progress?: StackProgressSink
  ): Promise<RestackResult> => {
    const emitStep = (step: StackCascadeStep): void => progress?.step({ ...step, workspaceId })
    if (!(await isWorktreeClean(worktreePath))) {
      const result: RestackResult = {
        status: 'dirty',
        baseBranch: '',
        message: 'Commit or stash your changes before restacking the stack.'
      }
      progress?.start(returnTo, 'restack')
      emitStep(stepFromRestack(returnTo, null, result))
      return result
    }
    // rebase 시작 전, 각 스택 브랜치의 현재 tip 을 잡아 둔다(상위 브랜치의 --onto oldBase 로 쓴다).
    const oldTip = new Map<string, string>()
    for (const e of stack) {
      const sha = await revParse(worktreePath, e.branch)
      if (sha) oldTip.set(e.branch, sha)
    }
    let anyChanged = false
    for (const entry of stack) {
      progress?.start(entry.branch, 'restack')
      // 캐스케이드와 같은 가드. 여기도 상위 브랜치에는 oldBase 를 넘겨 무조건 rebase 하고,
      // restackOnto 가 push 직전에 fetch 해 lease 를 되살리므로 force-push 가 그대로 통한다
      // — 즉 이 버튼도 GitHub 의 서버측 rebase 를 덮어쓸 수 있다(cascade.ts 의 실측 기록 참고).
      const remote = await detectRemoteDivergence(worktreePath, entry.branch)
      if (isDiverged(remote)) {
        emitStep(divergedStep(entry.branch, entry.prNumber, remote))
        return {
          status: 'error',
          baseBranch: entry.baseBranch,
          message: `${entry.branch}: ${divergedMessage(entry.branch, remote)}`
        }
      }
      const co = await checkoutBranch(worktreePath, entry.branch)
      if (co.error) {
        emitStep({
          branch: entry.branch,
          prNumber: entry.prNumber,
          kind: 'restack',
          status: 'failed',
          message: co.error
        })
        return { status: 'error', baseBranch: entry.baseBranch, message: co.error }
      }
      // base 가 다른 스택 멤버면(=상위 브랜치) 그 base 의 이전 tip 을 oldBase 로 넘겨 정확히 재배치한다.
      const oldBase = oldTip.get(entry.baseBranch)
      const res = await restackOnto(worktreePath, entry.baseBranch, oldBase).catch((err) => ({
        status: 'error' as const,
        baseBranch: entry.baseBranch,
        message: err instanceof Error ? err.message : String(err)
      }))
      emitStep(stepFromRestack(entry.branch, entry.prNumber, res))
      if (res.status === 'conflict' || res.status === 'error' || res.status === 'dirty') return res
      // rebase 는 됐지만 push 가 거부됐다. 이 층의 리모트는 옛 커밋 그대로라 위를 계속 쌓으면
      // 스택이 절반만 옮겨진다 — 여기서 멈추고 사유를 그대로 올려 보낸다(삼키지 않는다).
      if (res.pushError) return res
      if (res.status === 'restacked') anyChanged = true
    }
    await checkoutBranch(worktreePath, returnTo).catch(() => {})
    return { status: anyChanged ? 'restacked' : 'up-to-date', baseBranch: '' }
  }

  // stacked 브랜치를 최신 base 위로 rebase·force-push 한다. 모델 B 스택이면 전체를 아래→위로 순차 처리.
  handle(IPC.workspaceRestack, async (_e, workspaceId: string): Promise<RestackResult> => {
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
    const operation = stackProgress(workspaceId, 'restack', ws.stack?.length ?? null)
    const steps: StackCascadeStep[] = []
    const progress: StackProgressSink = {
      start: operation.sink.start,
      step: (step) => {
        steps.push(step)
        operation.sink.step(step)
      }
    }
    try {
      let result: RestackResult
      if (ws.stack && ws.stack.length > 1) {
        result = await restackWholeStack(
          workspaceId,
          ws.worktreePath,
          ws.stack,
          ws.branch,
          progress
        )
      } else {
        // 단일 브랜치도 안전하지 않다. oldBase 를 넘기지 않아 "뒤처졌을 때만" rebase 하지만, base 가
        // 앞서간 상황이 바로 아래층이 병합된 직후 — GitHub 이 이 브랜치를 이미 서버에서 rebase 해 둔
        // 그 순간이다. 그대로 두면 옛 커밋을 재생해 그 결과를 덮어쓴다.
        progress.start(ws.branch, 'restack')
        const remote = await detectRemoteDivergence(ws.worktreePath, ws.branch)
        if (isDiverged(remote)) {
          progress.step({ ...divergedStep(ws.branch, ws.prNumber, remote), workspaceId })
          return {
            status: 'error',
            baseBranch: ws.baseBranch,
            message: divergedMessage(ws.branch, remote)
          }
        }
        result = await restackOnto(ws.worktreePath, ws.baseBranch).catch((err) => ({
          status: 'error' as const,
          baseBranch: ws.baseBranch,
          message: err instanceof Error ? err.message : String(err)
        }))
        progress.step({ ...stepFromRestack(ws.branch, ws.prNumber, result), workspaceId })
      }
      // 설정이 꺼져 있으면 순수 함수가 즉시 null 을 돌려 git/session 호출이 전혀 없다. diverged 는
      // 사람이 어느 쪽을 버릴지 정할 상태라 제외하고, 한 작업의 첫 conflict 하나만 한 번 보낸다.
      // 실패해도 자동 재시도하지 않는다 — 충돌 하나가 무제한 턴으로 번지는 길을 만들지 않는다.
      const autoStep = pickAutoResolveStep(store.getState().settings.autoResolveConflicts, steps)
      if (autoStep) await startConflictResolve(autoStep.workspaceId, { auto: true })
      return result
    } finally {
      operation.finish()
    }
  })

  // 커밋 목록은 현재 레이어의 경계(baseBranch..HEAD)를 main 에서만 해석한다. 렌더러가 ref 조합을
  // 만들기 시작하면 모델 A/B와 checkout 상태에 따라 같은 화면이 서로 다른 범위를 보여 주게 된다.
  handle(IPC.stackCommitsList, async (_e, workspaceId: string): Promise<CommitEntry[]> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    return listCommits(ws.worktreePath, ws.baseBranch)
  })

  handle(
    IPC.stackCommitMovePreview,
    async (
      _e,
      workspaceId: string,
      sha: string
    ): Promise<CommitMovePreview | { error: string }> => {
      const upper = store.getState().workspaces.find((w) => w.id === workspaceId)
      const workspaces = upper
        ? store.getState().workspaces.filter((w) => w.repoId === upper.repoId && !w.archived)
        : []
      try {
        return await previewCommitMove({ workspaces, upperWorkspaceId: workspaceId, sha })
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle(
    IPC.stackCommitMoveApply,
    async (_e, workspaceId: string, sha: string): Promise<CommitMoveResult> => {
      const upper = store.getState().workspaces.find((w) => w.id === workspaceId)
      const workspaces = upper
        ? store.getState().workspaces.filter((w) => w.repoId === upper.repoId && !w.archived)
        : []
      // 코어가 apply 직전에 blocker 전체를 다시 읽는다. preview 때의 깨끗함이나 원격 tip을 여기서
      // 신뢰하면 확인 화면과 클릭 사이의 짧은 틈으로도 다른 작업을 덮어쓸 수 있다.
      const lowerId = upper?.parentWorkspaceId ?? null
      const affected = lowerId
        ? workspaces.filter((candidate) => {
            if (candidate.id === lowerId || candidate.id === workspaceId) return true
            let parentId = candidate.parentWorkspaceId
            while (parentId) {
              if (parentId === lowerId) return true
              parentId = workspaces.find((w) => w.id === parentId)?.parentWorkspaceId ?? null
            }
            return false
          }).length
        : null
      const operation = stackProgress(workspaceId, 'commit-move', affected)
      try {
        const result = await moveCommitDown({
          workspaces,
          upperWorkspaceId: workspaceId,
          sha,
          progress: operation.sink
        })
        if (result.status === 'moved') broadcastState()
        return result
      } finally {
        operation.finish()
      }
    }
  )

  // 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요).
  handle(
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
   * 계획에 담을 갈라짐 표시. 캐스케이드가 실행 직전에 다시 판정하므로 이 값은 표시 전용이다 —
   * 승인 버튼을 누르기 **전에** 무엇이 안 될지 보여 주는 것이 목적이다.
   *
   * 계획이 만들어지는 순간에만 도는 것도 요점이다(이미 계획이 있으면 detectStackSync 가 곧바로
   * 반환한다). 그래서 `ls-remote` 는 대상 브랜치당 한 번이고, 상시 폴링 비용에 얹히지 않는다.
   */
  const divergedFromRemote = async (worktreePath: string, branch: string): Promise<boolean> =>
    isDiverged(await detectRemoteDivergence(worktreePath, branch).catch(() => 'unknown' as const))

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
            prClosed: am?.state === 'CLOSED',
            remoteDiverged: await divergedFromRemote(ws.worktreePath, a.branch)
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
            prClosed: cm?.state === 'CLOSED',
            remoteDiverged: await divergedFromRemote(c.worktreePath, c.branch)
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
   * 이 워크스페이스의 브랜치가 **GitHub 스택**에 속하는지 보고, 속하면 그 스택 객체를 읽어 온다.
   *
   * 리포 단위로 캐시되는 목록으로 먼저 거르는 것이 요점이다 — 스택이 하나도 없는 리포(오늘의
   * 대부분이 그렇다. base 로 연결된 PR 을 여는 것만으로는 스택 객체가 생기지 않는다)에서는
   * 여기서 끝나고, 워크스페이스마다 GraphQL 을 띄우지 않는다.
   */
  const readGhStack = async (
    ws: Workspace,
    branches: string[]
  ): Promise<{ info: GhStackInfo; position: number | null } | null> => {
    const stacks = await getRepoStacks(ws.worktreePath, ws.repoId).catch(() => [])
    if (!stacks.length) return null
    const mine = (n: number, head: string): boolean =>
      branches.includes(head) || (ws.prNumber != null && ws.prNumber === n)
    const hit = stacks.flatMap((s) => s.pullRequests).find((p) => mine(p.number, p.headRef))
    if (!hit) return null
    const info = await getStackForPr(ws.worktreePath, hit.number).catch(() => null)
    if (!info) return null
    const here = info.entries.find((e) => mine(e.prNumber, e.headRef))
    return { info, position: here?.position ?? null }
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
    const anchors = [head, ws.branch].filter(Boolean)
    let detected: StackedBranch[] | null = null

    // GitHub 이 스택 객체를 들고 있으면 그 순서가 이긴다 — 위치가 명시적이라 리타겟이 밀려
    // base 체인이 잠시 끊겨도 살아남는다. 없으면(= 오늘 Wooi 가 연 PR 들은 전부 여기 해당)
    // 아래의 base 링크 복원이 그대로 돈다. 기능 감지가 없는 것은 의도된 것이다: 스택이 없는
    // 리포·PR 은 오류가 아니라 빈 값을 돌려주므로 빈 값이 곧 폴백 신호다.
    const gh = await readGhStack(ws, anchors).catch(() => null)
    if (gh) {
      for (const anchor of anchors) {
        detected = buildStackFromGhStack(anchor, gh.info, exclude)
        if (detected) break
      }
    }

    if (!detected) {
      for (const anchor of anchors) {
        detected = buildStackFromPrs(anchor, prs, exclude)
        if (detected) break
      }
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
      // GitHub 스택 메타데이터. 모델 B 로 흡수됐는지와 무관하게 기록한다 — 계층마다 worktree 를
      // 따로 둔 모델 A 스택에서는 흡수가 (일부러) 일어나지 않지만, 스택 번호·위치는 그때도
      // 보여 줄 값이다. 스택에서 빠지면 지운다: 남겨 두면 없어진 스택을 계속 가리킨다.
      const ghNumber = gh?.info.number ?? null
      const ghPosition = gh?.position ?? null
      if ((w.ghStackNumber ?? null) !== ghNumber || (w.ghStackPosition ?? null) !== ghPosition) {
        w.ghStackNumber = ghNumber
        w.ghStackPosition = ghPosition
        changed = true
      }
      if (gh) w.ghStackSyncedAt = Date.now()
      else if (w.ghStackSyncedAt != null) w.ghStackSyncedAt = null
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

  handle(IPC.prStatus, async (_e, workspaceId: string) => {
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
    // 원격 미러는 동기라 gh 를 부를 수 없다. 렌더러가 이미 시킨 이 조회의 답을 적어 두면
    // 추가 비용 없이 폰도 같은 PR 색과 이름을 쓸 수 있다.
    //
    // 값이 바뀌었을 때만 방송한다. 미러는 이 캐시를 방송 시점에 읽으므로, 방송이 없으면
    // 새 PR 제목·라벨이 다음 무관한 상태 변화까지 폰에 올라가지 않는다 — 제목은 표시
    // 이름이라 그동안 폰의 워크스페이스 이름이 낡은 채로 남는다. 폴링마다 방송하지
    // 않으므로 값이 그대로인 동안에는 비용이 없다.
    if (rememberPrStatus(workspaceId, status)) broadcastState()

    // CI auto-fix 는 여기에 붙는다. main 에는 CI 타이머가 없고, 렌더러의 PR 폴링이 이미
    // 45 초마다 돌면서 체크 결과까지 받아 오므로(stateFor 가 롤업을 읽는다) 새 폴링을
    // 만들지 않고 이 폴링의 결과에 얹는다.
    //
    // 여기서 보는 것은 값싼 신호(이미 받아 둔 상태값)뿐이다. 롤업을 다시 읽고 로그를
    // 가져오는 비싼 일은 maybeStartCiFix 안에서, 토글이 켜진 워크스페이스에 한해서만 한다.
    if (status && (status.state === 'ci_failed' || status.state === 'ci_pending')) {
      void maybeStartCiFix(workspaceId).catch(() => {})
    }
    return status
  })

  // 모델 B 스택 조망: 현재 체크아웃되지 않은 브랜치의 PR 상태도 조회한다.
  handle(IPC.prStatusForBranch, async (_e, workspaceId: string, branch: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    const entry = workspaceStack(ws).find((item) => item.branch === branch)
    const prNumber = branch === ws.branch ? ws.prNumber : entry?.prNumber
    const status = await getPrStatus(ws.worktreePath, prNumber ?? branch).catch(() => null)
    if (status) persistPrNumber(workspaceId, branch, status.number)
    return status
  })

  handle(
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
    newBase: string,
    progress?: StackProgressSink
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
          workspaceId: child.id,
          mergedBranch,
          newBase: grandparentBranch,
          entries: [{ branch: child.branch, baseBranch: mergedBranch, prNumber: child.prNumber }],
          progress
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
      // 리모트가 우리 모르게 움직였으면 rebase 하지 않는다(모델 B 와 같은 판정·같은 이유).
      // 위의 retarget 은 PR 쪽만 건드리므로 이미 끝났고, 여기서 멈추는 것은 히스토리 리라이트뿐이다.
      const remote = await detectRemoteDivergence(child.worktreePath, child.branch).catch(
        () => 'unknown' as const
      )
      if (isDiverged(remote)) {
        const step = {
          ...divergedStep(child.branch, child.prNumber, remote),
          workspaceId: child.id
        }
        progress?.start(child.branch, 'restack')
        steps.push(step)
        progress?.step(step)
        continue
      }
      progress?.start(child.branch, 'restack')
      const r = await restackOnto(child.worktreePath, grandparentBranch, mergedBranch).catch(
        (err): RestackResult => ({
          status: 'error',
          baseBranch: grandparentBranch,
          message: err instanceof Error ? err.message : String(err)
        })
      )
      const step = { ...stepFromRestack(child.branch, child.prNumber, r), workspaceId: child.id }
      steps.push(step)
      progress?.step(step)
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
          workspaceId,
          mergedBranch,
          newBase: mergedBase,
          entries: above,
          progress
        }))
      )
      // git 히스토리 쪽(rebase + force-push).
      steps.push(
        ...(await cascadeRestackBranchStack({
          worktreePath: ws.worktreePath,
          workspaceId,
          mergedBranch,
          newBase: mergedBase,
          entries: above,
          allEntries: stack,
          progress
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
   * 트레인은 뿌리부터 현재 워크스페이스까지의 선형 경로만 훑는다. 위층까지 삼키면 사용자가
   * 보고 있지 않은 PR 이 머지된다. 모델 A 의 DFS 트리 목록은 형제까지 섞으므로 여기서는 쓰지 않는다.
   */
  const resolveMergeTrainLayers = (workspaceId: string): TrainLayer[] => {
    const all = store.getState().workspaces
    const ws = all.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    if (isBranchStack(ws)) {
      const stack = workspaceStack(ws)
      const current = stack.findIndex((entry) => entry.branch === ws.branch)
      if (current < 0) return []
      return stack.slice(0, current + 1).map((entry) => ({
        workspaceId: ws.id,
        worktreePath: ws.worktreePath,
        branch: entry.branch,
        prNumber: entry.prNumber
      }))
    }

    const byId = new Map(all.map((item) => [item.id, item]))
    const chain: Workspace[] = []
    const seen = new Set<string>()
    let cursor: Workspace | undefined = ws
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      chain.push(cursor)
      cursor = cursor.parentWorkspaceId ? byId.get(cursor.parentWorkspaceId) : undefined
    }
    return chain.reverse().map((item) => ({
      workspaceId: item.id,
      worktreePath: item.worktreePath,
      branch: item.branch,
      prNumber: item.prNumber
    }))
  }

  const trainDeps = {
    getPrStatus,
    getPrMeta,
    getPrHeadSha,
    isWorktreeClean,
    detectRemoteDivergence,
    mergePr,
    runCascade: runMergeCascade,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  const forcePushesForPlan = (
    workspaceId: string,
    layers: TrainLayer[],
    plan: StackTrainPlan
  ): string[] => {
    const ws = store.getState().workspaces.find((item) => item.id === workspaceId)
    if (!ws || plan.mergeableCount === 0) return []
    const blockedIndex = plan.layers.findIndex((layer) => layer.blockedReason !== null)
    const prefixLength = blockedIndex < 0 ? plan.layers.length : blockedIndex
    const merging = new Set(
      plan.layers
        .slice(0, prefixLength)
        .filter((layer) => layer.state !== 'merged')
        .map((layer) => layer.branch)
    )
    if (isBranchStack(ws)) {
      const stack = workspaceStack(ws)
      const bottom = stack.findIndex((entry) => merging.has(entry.branch))
      return bottom < 0 ? [] : stack.slice(bottom + 1).map((entry) => entry.branch)
    }
    const all = store.getState().workspaces
    const branches: string[] = []
    for (const layer of layers) {
      if (!merging.has(layer.branch)) continue
      for (const child of all.filter(
        (item) => item.parentWorkspaceId === layer.workspaceId && !item.archived
      )) {
        if (!branches.includes(child.branch)) branches.push(child.branch)
      }
    }
    return branches
  }

  handle(IPC.stackTrainPlan, async (_e, workspaceId: string): Promise<StackTrainPlan> => {
    const ws = store.getState().workspaces.find((item) => item.id === workspaceId)
    const layers = resolveMergeTrainLayers(workspaceId)
    if (!ws || ws.archived) {
      return {
        layers: [],
        mergeableCount: 0,
        forcePushCount: 0,
        forcePushBranches: [],
        error: 'Workspace not found.'
      }
    }
    if (layers.length < 2) {
      return {
        layers: [],
        mergeableCount: 0,
        forcePushCount: 0,
        forcePushBranches: [],
        error: 'A merge train needs at least two layers.'
      }
    }
    const first = await planMergeTrain({ layers, forcePushBranches: [] }, trainDeps)
    const forcePushBranches = forcePushesForPlan(workspaceId, layers, first)
    const plan = { ...first, forcePushBranches, forcePushCount: forcePushBranches.length }
    mergeTrainPlans.set(workspaceId, {
      branches: layers.map((layer) => layer.branch),
      headShas: plan.headShas,
      plannedAt: Date.now(),
      mergeableCount: plan.mergeableCount
    })
    const { headShas: _headShas, ...publicPlan } = plan
    return publicPlan
  })

  handle(
    IPC.stackTrainRun,
    async (_e, workspaceId: string, method: PrMergeMethod): Promise<StackTrainResult> => {
      const remembered = mergeTrainPlans.get(workspaceId)
      const layers = resolveMergeTrainLayers(workspaceId)
      if (
        !remembered ||
        remembered.branches.join('\0') !== layers.map((layer) => layer.branch).join('\0')
      ) {
        return {
          mergedPrs: [],
          steps: [],
          stoppedAt: null,
          error: 'Plan the merge train before running it.'
        }
      }
      const operation = stackProgress(workspaceId, 'train', remembered.mergeableCount)
      try {
        const result = await runMergeTrain(
          { layers, method, expectedHeadShas: remembered.headShas },
          trainDeps,
          operation.sink
        )
        clearStackSync(workspaceId, true)
        for (const layer of layers) await reconcileWorkspaceStack(layer.workspaceId)
        broadcastState()
        // 트레인은 캐스케이드를 자기가 만들지 않고 runMergeCascade 를 그대로 꽂아 쓰므로
        // (trainDeps.runCascade) 단계마다 workspaceId 가 이미 실려 있다. 대상은 트레인을 시작한
        // 워크스페이스가 아니라 충돌이 난 층의 워크트리다. 트레인은 첫 문제에서 멈추고 돌아오니
        // 여기서도 한 번 실행 = 최대 한 턴이고, 실패해도 다시 태우지 않는다.
        const autoStep = pickAutoResolveStep(
          store.getState().settings.autoResolveConflicts,
          result.steps
        )
        if (autoStep) await startConflictResolve(autoStep.workspaceId, { auto: true })
        return result
      } finally {
        mergeTrainPlans.delete(workspaceId)
        operation.finish()
      }
    }
  )

  /**
   * PR 을 병합한다. 병합만 한다 — 스택 캐스케이드(리타겟·rebase·force-push)는 여기 딸려 오지 않는다.
   *
   * 병합은 wooi 말고도 `gh pr merge`·GitHub 웹에서 얼마든지 일어난다. 캐스케이드를 병합 핸들러에
   * 묶으면 "어디서 병합했느냐"에 따라 동작이 갈리고(= 원래 버그), 무엇보다 병합 승인 한 번으로
   * 자식 브랜치의 리모트 히스토리를 되쓰는 force-push 까지 나가 버린다.
   * 그래서 병합 후에는 재동기화만 돌려 캐스케이드 계획을 띄우고, 실행은 사용자 승인에 맡긴다.
   */
  handle(
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
  handle(
    IPC.stackSyncApply,
    async (_e, workspaceId: string): Promise<{ error?: string; cascade?: StackCascadeResult }> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return { error: 'Workspace not found.' }
      const plan = ws.stackSync
      if (!plan) return { error: 'Nothing to sync.' }
      const operation = stackProgress(workspaceId, 'sync', plan.affected.length)
      try {
        const cascade = await runMergeCascade(
          workspaceId,
          plan.mergedBranch,
          plan.newBase,
          operation.sink
        ).catch((err): StackCascadeResult => {
          const step: StackCascadeStep = {
            branch: plan.mergedBranch,
            prNumber: null,
            kind: 'retarget',
            status: 'failed',
            message: err instanceof Error ? err.message : String(err)
          }
          operation.sink.start(step.branch, step.kind)
          operation.sink.step(step)
          return { steps: [step] }
        })
        clearStackSync(workspaceId, true)
        // 꺼져 있으면 여기서 즉시 null 이라 git/session 호출이 0회다. diverged 는 충돌이 아니라
        // 사람의 선택이고, 모델 A 가 여러 conflict 를 내도 첫 하나만 골라 작업당 턴을 최대 하나로
        // 제한한다. 해결 실패에도 자동 재시도는 없다 — 재시도 루프는 토큰을 무제한 태울 수 있다.
        const autoStep = pickAutoResolveStep(
          store.getState().settings.autoResolveConflicts,
          cascade.steps
        )
        if (autoStep) await startConflictResolve(autoStep.workspaceId, { auto: true })
        return { cascade }
      } finally {
        operation.finish()
      }
    }
  )

  /**
   * 계획을 무시한다. 어떤 병합을 무시했는지 기억해 두지 않으면 다음 재동기화가 같은 병합을 다시
   * 감지해 배너가 계속 뜬다("무시" = 이 병합은 내가 알아서 한다는 뜻).
   */
  handle(IPC.stackSyncDismiss, async (_e, workspaceId: string): Promise<void> => {
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
  handle(IPC.stackBaseRetarget, async (_e, workspaceId: string): Promise<{ error?: string }> => {
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
  })

  /**
   * 어긋난 base 를 사용자가 의도한 것으로 받아들인다 — 그 base 를 기록상의 base 로 채택하고,
   * 같은 base 로는 다시 묻지 않는다. 부모 링크는 그대로 둔다(사이드바의 스택 묶음은 유지).
   */
  handle(IPC.stackBaseKeep, async (_e, workspaceId: string): Promise<void> => {
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

  handle(
    IPC.stackResolveConflict,
    async (_e, workspaceId: string): Promise<{ error?: string; started?: boolean }> =>
      startConflictResolve(workspaceId, { auto: false })
  )

  handle(IPC.prClose, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return closePr(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  handle(IPC.prReopen, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return reopenPr(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  handle(IPC.prReady, async (_e, workspaceId: string): Promise<{ error?: string }> => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return { error: 'Workspace not found.' }
    return markPrReady(ws.worktreePath).catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  // 편집 모달을 열 때만 제목·본문 원문을 읽는다(상태 폴링에 본문을 싣지 않기 위해).
  handle(IPC.prEditable, async (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return getPrEditable(ws.worktreePath).catch(() => null)
  })

  handle(
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
  handle(IPC.prChecks, async (_e, workspaceId: string) => {
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

  // 지난 실행에서 돌던 채로 끝난 리뷰를 멈춤으로 내려 둔다 — 그러지 않으면 영원히 "Reviewing…"
  // 인 채로 남아 이어서 돌릴 수도, 멈출 수도 없다.
  reviewManager.restore()

  // 앱을 닫을 때는 **워크트리만** 정리한다. 리뷰 레코드·ref·사이드카를 지우면 다음 실행에
  // 리뷰가 통째로 사라져 영속화가 무의미해진다(ref 를 남겨야 오프라인에서도 복원된다).
  app.on('before-quit', () => {
    // 종료가 막혔으면(백그라운드 모드) 리뷰는 계속 돌아야 한다. Electron 은 preventDefault 와
    // 무관하게 모든 before-quit 리스너를 실행하므로, 여기서 직접 물어보지 않으면 살아 있어야 할
    // 워크트리를 지운다([[main/backgroundMode]]).
    if (isStayingAlive()) return
    void reviewManager.disposeWorktreesOnQuit()
  })

  handle(IPC.reviewListOpenPrs, async (_e, repoId: string) => {
    const repo = repoFor(repoId)
    if (!repo) return []
    return listOpenPrCandidates(repo.path).catch(() => [])
  })

  // 스택 멤버십은 review/stackResolve 만 읽는다 — 여기서는 그 결과를 넘겨주기만 한다.
  handle(IPC.reviewResolveStack, async (_e, repoId: string, prNumber: number) => {
    const repo = repoFor(repoId)
    if (!repo) return { prNumbers: [prNumber] }
    // GitHub 스택을 먼저 묻는다 — 워크스페이스 흡수 경로와 같은 우선순위다. 스택이 없는
    // 리포·PR 은 오류가 아니라 빈 값을 돌려주므로, 빈 값이 그대로 폴백 신호가 된다.
    const [openPrs, ghStack] = await Promise.all([
      listOpenPrs(repo.path, repo.id).catch(() => []),
      getStackForPr(repo.path, prNumber).catch(() => null)
    ])
    return { prNumbers: resolveStackForPr(prNumber, openPrs, ghStack).prNumbers }
  })

  handle(
    IPC.reviewStart,
    async (
      _e,
      args: {
        repoId: string
        prNumbers: number[]
        prompt: string
        agentBackend?: AgentBackendId
        model?: string | null
        effort?: EffortSetting | null
      }
    ) => {
      const repo = repoFor(args.repoId)
      if (!repo) return { error: '리포를 찾을 수 없습니다.' }
      const settings = store.getState().settings
      // 인자로 이미 정해졌으면 listBackends() 를 부르지 않는다 — 감지는 셸을 거쳐 CLI 를
      // 하나씩 찔러 보는 왕복이라(`shell.ts`), 전역 기본값으로 떨어질 때만 치른다.
      const agentBackend = args.agentBackend
        ? args.agentBackend
        : usableDefaultBackend(
            settings.defaultAgentBackend,
            (await ctx.sessions.listBackends()).filter((b) => b.available).map((b) => b.id)
          )
      // 모델·effort 는 고른 에이전트의 전역 기본값을 따른다(백엔드마다 모델 ID 가 다르므로
      // 다른 백엔드의 값을 흘리면 CLI 가 거부한다).
      const defaults = agentSettingsFor(settings, agentBackend)
      return reviewManager.start({
        repo,
        prNumbers: args.prNumbers,
        prompt: args.prompt,
        agentBackend,
        // 워크스페이스처럼 개별 오버라이드가 없으므로 전역 설정을 따른다.
        model: args.model === undefined ? defaults.model : args.model,
        effort: args.effort === undefined ? defaults.effort : args.effort
      })
    }
  )

  handle(IPC.reviewCancel, (_e, reviewId: string) => {
    reviewManager.cancel(reviewId)
  })

  handle(IPC.reviewResume, async (_e, reviewId: string) => reviewManager.resume(reviewId))

  handle(IPC.reviewPost, async (_e, reviewId: string, findingId: string, body: string) =>
    reviewManager.post(reviewId, findingId, body)
  )

  handle(IPC.reviewDismiss, (_e, reviewId: string, findingId: string) =>
    reviewManager.dismissFinding(reviewId, findingId)
  )

  handle(IPC.reviewClose, async (_e, reviewId: string) => {
    await reviewManager.remove(reviewId)
  })

  handle(IPC.reviewRemoveArchived, () => reviewManager.removeArchived())

  handle(IPC.reviewLoad, (_e, reviewId: string) => reviewManager.loadBundle(reviewId))

  handle(
    IPC.reviewSetFileViewed,
    (_e, reviewId: string, path: string, viewed: boolean, prNumber?: number) =>
      reviewManager.setFileViewed(reviewId, path, viewed, prNumber)
  )

  handle(IPC.reviewArchive, async (_e, reviewId: string) => {
    await reviewManager.archive(reviewId)
  })

  handle(IPC.reviewUnarchive, async (_e, reviewId: string) => reviewManager.unarchive(reviewId))

  handle(
    IPC.reviewSubmit,
    async (
      _e,
      reviewId: string,
      entries: Array<{ prNumber: number; verdict: ReviewVerdict; body: string }>
    ) => reviewManager.submitReview(reviewId, entries)
  )

  handle(IPC.reviewPoll, async (_e, reviewId: string) => {
    await reviewManager.pollActivity(reviewId)
  })

  handle(IPC.reviewMarkSeen, (_e, reviewId: string) => {
    reviewManager.markSeen(reviewId)
  })

  handle(IPC.reviewReply, async (_e, reviewId: string, commentId: number, body: string) =>
    reviewManager.replyToThread(reviewId, commentId, body)
  )

  handle(IPC.reviewFollowUp, async (_e, reviewId: string, text: string) => {
    const state = store.getState()
    // 후속 턴은 리뷰를 시작한 그 에이전트로 이어진다 — 세션 id 가 그 백엔드에서만 유효하다.
    const review = state.reviews.find((r) => r.id === reviewId)
    // 옛 리뷰라 agentBackend 기록이 없을 때만 listBackends() 를 부른다 — 있으면 그대로 쓴다.
    const backend = review?.agentBackend
      ? review.agentBackend
      : usableDefaultBackend(
          state.settings.defaultAgentBackend,
          (await ctx.sessions.listBackends()).filter((b) => b.available).map((b) => b.id)
        )
    const defaults = agentSettingsFor(state.settings, backend)
    // 모델·강도도 시작할 때 고른 것으로 이어 간다. 옛 레코드에는 없으므로 그때는 전역 기본값
    // (지금까지의 동작)으로 떨어진다.
    return reviewManager.followUp(reviewId, text, {
      model: review?.model ?? defaults.model,
      effort: review?.effort ?? defaults.effort
    })
  })

  handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // ── 파일 브라우저 (All files 탭) ─────────────────────────────────────────

  handle(IPC.fsList, (_e, workspaceId: string, relPath: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    return listDir(ws.worktreePath, relPath ?? '').catch(() => [])
  })

  handle(IPC.fsRead, (_e, workspaceId: string, relPath: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return null
    return readFileInRoot(ws.worktreePath, relPath).catch(() => null)
  })

  handle(
    IPC.fsWrite,
    (
      _e,
      workspaceId: string,
      relPath: string,
      text: string,
      baselineSha: string | null,
      force?: boolean
    ): Promise<FileWriteResult> => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      // 아카이브된 워크스페이스는 읽기 전용이다(읽기와 같은 규칙).
      if (!ws || ws.archived) return Promise.resolve({ ok: false, reason: 'denied' })
      return writeFileInRoot(ws.worktreePath, relPath, text, baselineSha, { force }).catch((e) => ({
        ok: false as const,
        reason: 'error' as const,
        message: e instanceof Error ? e.message : String(e)
      }))
    }
  )

  handle(IPC.fsSearch, (_e, workspaceId: string, query: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return []
    return searchFiles(ws.worktreePath, query ?? '').catch(() => [])
  })

  // ── 에이전트 카탈로그 (렌더러의 선택지 UI 근거) ──────────────────────────

  // 백엔드 메타 + 가용성. 렌더러는 이 값으로 권한 모드·effort 선택지와 에이전트 피커를 그린다.
  handle(IPC.agentListBackends, () => ctx.sessions.listBackends())

  // 백엔드별 모델 목록. Claude 는 정적, Codex 는 app-server 의 model/list 조회라 비동기·동적이다.
  handle(IPC.agentListModels, (_e, backendId: AgentBackendId) => ctx.sessions.listModels(backendId))

  // ── 슬래시 명령 목록 (입력창 자동완성) ───────────────────────────────────

  handle(IPC.commandsList, (_e, workspaceId: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return []
    return ctx.sessions
      .listCommands(ws.id, ws.worktreePath)
      .then((commands) => [
        {
          name: 'fork',
          description: 'Fork this conversation into a new workspace',
          argumentHint: '[name]'
        },
        ...commands.filter((command) => command.name !== 'fork')
      ])
      .catch(() => [
        {
          name: 'fork',
          description: 'Fork this conversation into a new workspace',
          argumentHint: '[name]'
        }
      ])
  })

  // 인터랙티브 명령(/mcp·/context·/reload-plugins 등) — 결과 카드용 데이터를 조회한다.
  handle(
    IPC.commandRun,
    async (
      _e,
      workspaceId: string,
      kind: CommandPanelKind
    ): Promise<{ result?: CommandResult; error?: string }> => {
      try {
        const result = await ctx.sessions.runCommand(workspaceId, kind)
        // /plan은 commandRun 안에서 권한 모드를 바꾼다. 일반 workspaceSetPermissionMode handler와
        // 달리 이 경로에는 자동 방송이 없으므로, 성공한 뒤 renderer AppState도 함께 갱신한다.
        if (kind === 'plan') broadcastState()
        return { result }
      } catch (err) {
        // 명령 실행 실패는 렌더러 카드로만 전달돼 진단이 어렵다. 영속 로그에도 남긴다.
        log.error(`command '${kind}' failed:`, err)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // /mcp 패널의 서버별 동작(재연결·활성/비활성) — 적용 후 갱신된 서버 목록을 돌려준다.
  handle(
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

  /**
   * `/wooi:*` 즉시 실행 명령 — 에이전트를 거치지 않고 도구를 그대로 돌린다.
   *
   * 승인 카드를 띄우지 않는다. 승인은 "모델이 하려는 일을 사람이 확인한다" 는 장치인데 여기서는
   * 사람이 직접 이름을 쳐서 부른 것이라 물을 것이 없다 — `/diff`·`/add-dir` 이 묻지 않는 것과 같다.
   * 대신 실행할 수 있는 것은 [[shared/wooiCommands]] 의 `direct` 목록으로 닫혀 있고, 인자도
   * 그 파서를 통과한 것만 도구에 닿는다. 렌더러가 임의의 도구 이름을 흘려보낼 수 없다.
   */
  handle(
    IPC.wooiCommandRun,
    async (
      _e,
      workspaceId: string,
      name: string,
      rest: string
    ): Promise<{ result?: unknown; error?: string }> => {
      const spec = WOOI_COMMANDS.find((c) => c.name === name && c.mode === 'direct')
      if (!spec) return { error: `Unknown Wooi command: /wooi:${name}` }

      const parsed = parseWooiCommandArgs(spec.name, rest ?? '')
      if ('error' in parsed) return { error: parsed.error }

      try {
        return { result: await runAgentTool(workspaceId, spec.tool, parsed.args) }
      } catch (err) {
        // 도구가 던지는 문장은 사람이 읽도록 쓰여 있다(예: "커밋하고 다시 호출하라").
        // 모델에게 갈 때와 같은 문장을 카드에 그대로 보여 준다.
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // /rewind 패널 — 고른 체크포인트(사용자 메시지 UUID)로 추적된 파일을 되돌린다.
  handle(
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
  handle(IPC.rateLimitsRefresh, async (_event, agentId?: AgentBackendId): Promise<AppState> => {
    try {
      if (agentId) await ctx.sessions.refreshRateLimitsFor(agentId, true)
      else await ctx.sessions.refreshRateLimits(true)
    } catch (err) {
      log.error('rate limits: manual refresh failed:', err)
    }
    // 방송은 다른 창을 위한 push 경로로 유지하되, 요청한 renderer에는 최신 상태를 직접
    // 반환한다. 그래야 초기 구독 전 이벤트 유실이나 동시 갱신 순서와 무관하게 화면이 따라온다.
    return store.getState()
  })

  // ── 인터랙티브 터미널 (worktree PTY) ─────────────────────────────────────

  handle(
    IPC.terminalStart,
    (_e, workspaceId: string, terminalId: string, cols: number, rows: number) => {
      const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.archived) return
      ctx.terminals.start(workspaceId, terminalId, ws.worktreePath, cols, rows)
    }
  )

  handle(IPC.terminalInput, (_e, workspaceId: string, terminalId: string, data: string) => {
    ctx.terminals.write(workspaceId, terminalId, data)
  })

  handle(IPC.terminalRunCommand, (_e, workspaceId: string, command: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    ctx.terminals.runCommand(workspaceId, ws.worktreePath, command)
  })

  handle(IPC.terminalExec, (_e, workspaceId: string, command: string) => {
    const ws = store.getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.archived) return
    ctx.terminals.execInline(workspaceId, ws.worktreePath, command)
  })

  handle(IPC.terminalKillInline, (_e, workspaceId: string, itemId: string) => {
    ctx.terminals.killInline(workspaceId, itemId)
  })

  handle(
    IPC.terminalResize,
    (_e, workspaceId: string, terminalId: string, cols: number, rows: number) => {
      ctx.terminals.resize(workspaceId, terminalId, cols, rows)
    }
  )

  handle(IPC.terminalKill, (_e, workspaceId: string) => {
    ctx.terminals.disposeWorkspace(workspaceId)
  })

  // 탭 구성 — 변경은 메인이 소유하고(단일 진실 원천) 결과를 모든 창에 방송한다.
  // 요청한 창에는 방송과 별개로 최신 구성을 곧바로 돌려줘, 왕복 순서와 무관하게 화면이 따라온다.

  handle(IPC.terminalTabs, (_e, workspaceId: string) => ctx.terminals.tabs(workspaceId))

  handle(IPC.terminalTabCreate, (_e, workspaceId: string) => ctx.terminals.createTab(workspaceId))

  handle(IPC.terminalTabClose, (_e, workspaceId: string, terminalId: string) =>
    ctx.terminals.closeTab(workspaceId, terminalId)
  )

  handle(IPC.terminalTabRename, (_e, workspaceId: string, terminalId: string, title: string) =>
    ctx.terminals.renameTab(workspaceId, terminalId, title)
  )

  handle(IPC.terminalTabSelect, (_e, workspaceId: string, terminalId: string) =>
    ctx.terminals.selectTab(workspaceId, terminalId)
  )

  // ── Dock 미확인 배지 ─────────────────────────────────────────────────────

  handle(IPC.appSetBadge, (_e, count: number) => {
    // 설치 빌드에서 app.setBadgeCount 는 Dock 배지를 그리지 않는 것으로 확인돼(실험: 같은
    // 시점에 app.dock.setBadge 는 보이고 setBadgeCount 는 안 보임), NSDockTile 라벨을 직접
    // 세팅한다. 0 이면 빈 문자열로 지운다. dock 은 macOS 전용이라 다른 OS 는 no-op.
    const n = Math.max(0, Math.floor(count))
    app.dock?.setBadge(n > 0 ? String(n) : '')
  })

  // ── 설정 ───────────────────────────────────────────────────────────────

  handle(IPC.appGetState, () => store.getState())

  handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => {
    store.update((st) => Object.assign(st.settings, patch))
    if (patch.autoResumeAfterRateLimit === false) ctx.sessions.cancelAllRateLimitResumes()
    if (patch.resumeUnfinishedTurnsOnLaunch === false) ctx.sessions.cancelAllShutdownResumes()
    // 껐으면 지금 붙잡고 있는 것을 바로 놓아야 한다 — 다음 방송까지 기다리면 도는 턴이 끝날
    // 때까지 맥이 계속 깨어 있다.
    if (patch.keepAwakeWhileRunning !== undefined)
      setSleepBlockerEnabled(patch.keepAwakeWhileRunning)
    broadcastState()
  })

  // ── MCP 서버 설정 ───────────────────────────────────────────────────────

  // 승계 목록(~/.claude.json)은 앱 상태가 아니라 남의 파일이라 방송에 실을 수 없다 — 설정 화면이
  // 열릴 때마다 읽는다. project 항목은 등록된 리포 경로로 걸러야 우리가 실제로 주입하는 것만 남는다.
  handle(IPC.mcpInventory, () => mcpInventory(store.getState().repos.map((r) => r.path)))
  handle(IPC.mcpExternalSetupCommand, () => externalClaudeMcpSetupCommand())

  // 승계 항목의 편집 경로는 "그 파일을 여세요" 하나뿐이다(우리는 쓰지 않는다).
  handle(IPC.mcpOpenConfig, async () => {
    const path = claudeConfigPath()
    // 파일이 없으면 열 것도 없으므로 담긴 디렉터리를 연다 — 사용자가 거기서 새로 만들 수 있다.
    await shell.openPath(existsSync(path) ? path : join(path, '..'))
  })

  // Codex 는 자기 설정 파일(~/.codex/config.toml)을 스스로 읽으므로 목록도 app-server 에
  // 물어본다(TOML 파서를 들이지 않는 이유이기도 하다). 설치되지 않았으면 빈 목록으로 끊는다.
  handle(IPC.mcpCodexList, async (): Promise<{ servers?: CodexMcpServer[]; error?: string }> => {
    try {
      return { servers: await ctx.sessions.configuredMcpServers('codex') }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 이 토글만은 사용자 파일에 직접 쓴다 — codex 에는 "우리 쪽에서 빼기" 에 해당하는 경로가 없다.
  handle(
    IPC.mcpCodexSetEnabled,
    async (
      _e,
      serverName: string,
      enabled: boolean
    ): Promise<{ servers?: CodexMcpServer[]; error?: string }> => {
      try {
        return { servers: await ctx.sessions.setMcpServerEnabled('codex', serverName, enabled) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle(
    IPC.mcpCodexOauthLogin,
    async (_e, serverName: string): Promise<{ authorizationUrl?: string; error?: string }> => {
      try {
        return { authorizationUrl: await ctx.sessions.loginMcpServer('codex', serverName) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ── Codex Agent Plugins ────────────────────────────────────────────────

  // 읽기 전용이다. 설치·마켓플레이스 추가는 사용자의 codex 설치본 전체를 바꾸는 바깥 방향 동작이라
  // 목록을 보는 김에 곁다리로 하면 안 된다 — 이 화면은 "무엇이 깔려 있는가" 까지만 답한다.
  // cwds 로 등록된 리포 경로를 넘겨 리포 안에 든 마켓플레이스까지 찾게 한다(MCP 승계 목록과 같다).
  handle(
    IPC.pluginCodexList,
    async (): Promise<{ inventory?: CodexPluginInventory; error?: string }> => {
      try {
        const cwds = store.getState().repos.map((repo) => repo.path)
        return { inventory: await ctx.sessions.plugins('codex', cwds) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle(
    IPC.pluginCodexRead,
    async (_e, ref: CodexPluginRef): Promise<{ detail?: CodexPluginDetail; error?: string }> => {
      try {
        return { detail: await ctx.sessions.readPlugin('codex', ref) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ── 외부 연동 인증 ──────────────────────────────────────────────────────

  handle(IPC.authGetStatus, () => getAuthStatus())
  // 별도 Terminal 창 없이 앱 내부 PTY 에서 로그인하고, 진행 상황은 evtClaudeLogin 으로 흘려보낸다.
  // 로그인이 성공하면(= 계정이 바뀔 수 있으면) 세션 프로세스를 재활용한다 — 옛 자격증명을 들고
  // 있는 CLI 를 남기지 않으면서 대화 맥락(sessionId)은 유지해, 다음 메시지가 새 계정으로 같은
  // 대화를 이어간다(터미널에서 CLI 를 재시작하고 `claude --resume` 하는 것과 같은 결과).
  handle(IPC.authClaudeLoginStart, () =>
    claudeLoginStart(dispatch, () => ctx.sessions.recycleAll())
  )
  handle(IPC.authClaudeLoginSubmitCode, (_e, code: string) => claudeLoginSubmitCode(code))
  handle(IPC.authClaudeLoginCancel, () => claudeLoginCancel())
  handle(IPC.authClaudeLogout, async () => {
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
  handle(IPC.authCodexLoginStart, async (_e, method: CodexLoginMethod, apiKey?: string) => {
    const codex = ctx.sessions.accountFor('codex')
    if (!codex?.loginStart) throw new Error('Codex sign-in is not available.')
    await codex.loginStart(method, apiKey)
  })
  handle(IPC.authCodexLoginCancel, () => ctx.sessions.accountFor('codex')?.loginCancel?.())
  handle(IPC.authCodexLogout, async () => {
    const codex = ctx.sessions.accountFor('codex')
    if (!codex?.logout) return
    // Claude 와 같은 이유로 완료까지 await 한다 — 이어지는 refreshAuth()가 반영된 상태를 읽도록.
    await codex.logout()
    codex.abortAll()
    broadcastState()
  })
  handle(IPC.authCodexRateLimits, () => ctx.sessions.accountFor('codex')?.rateLimits?.() ?? null)

  // GitHub 로그인도 별도 Terminal 창 없이 앱 내부 PTY(디바이스 플로우)로 진행하고,
  // 진행 상황은 evtGithubLogin 으로 흘려보낸다.
  handle(IPC.authGithubLoginStart, () => githubLoginStart(dispatch))
  handle(IPC.authGithubLoginCancel, () => githubLoginCancel())
  handle(IPC.authGithubLogout, () => githubLogout())

  // ── 원격 접근(모바일 컴패니언) ────────────────────────────────────────
  // 전부 데스크톱 전용이다. allowlist.test.ts 가 이 채널들이 원격에 열리지 않도록 잠근다.
  handle(IPC.remoteGetStatus, () => getRemoteBridge().status())
  handle(IPC.remoteSetEnabled, async (_e, enabled: boolean) => {
    const status = await getRemoteBridge().setEnabled(enabled === true)
    // 설정에도 남겨 다음 실행에서 그대로 복원한다.
    store.update((st) => {
      st.settings.remoteEnabled = status.enabled
    })
    broadcastState()
    return status
  })
  handle(IPC.remotePairStart, () => getRemoteBridge().startPairing())
  handle(IPC.remotePairConfirm, () => getRemoteBridge().confirmPairing())
  handle(IPC.remotePairCancel, () => getRemoteBridge().cancelPairing())
  handle(IPC.remoteRevokeDevice, (_e, deviceId: string) =>
    getRemoteBridge().revokeDevice(String(deviceId))
  )
  // 렌더러가 판정한 미확인 목록을 영속하고 원격에도 투영한다. 반대 방향은 evt:remoteRead 다.
  handle(IPC.remoteSetUnread, (_e, workspaceIds: unknown) => {
    const live = new Set(store.getState().workspaces.map((workspace) => workspace.id))
    const ids = Array.isArray(workspaceIds)
      ? [
          ...new Set(
            workspaceIds.filter((id): id is string => typeof id === 'string' && live.has(id))
          )
        ]
      : []
    const previous = store.getState().unreadWorkspaceIds ?? []
    if (previous.length !== ids.length || previous.some((id, index) => id !== ids[index])) {
      store.update((state) => {
        state.unreadWorkspaceIds = ids
      })
    }
    getRemoteBridge().setUnread(ids)
  })

  // 지금 보고 있는 워크스페이스를 기억한다. 알림을 띄울지 판정할 때 "앱은 보고 있지만 다른
  // 워크스페이스를 보고 있는" 경우를 가르는 유일한 근거다([[main/notifications]]).
  handle(IPC.notifySetViewing, (_e, workspaceId: unknown) => {
    setViewingWorkspace(typeof workspaceId === 'string' ? workspaceId : null)
  })
  // 설정 화면의 진단 줄. 값은 메인 메모리에만 있으므로(디스크에 남기지 않는다) 열 때마다 읽는다.
  handle(IPC.notifyLastSkip, () => lastNotificationSkip())

  handle(IPC.remoteClearData, async () => {
    const status = await getRemoteBridge().clearData()
    store.update((st) => {
      st.settings.remoteEnabled = false
    })
    broadcastState()
    return status
  })
}
