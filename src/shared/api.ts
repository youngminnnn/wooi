import type { RemoteStatus } from './remote'
import type {
  AdoptFanoutResult,
  AgentBackendId,
  AgentBackendMeta,
  AppNotice,
  AppState,
  AppSettings,
  AgentRateLimits,
  ArchiveScriptFailure,
  AuthStatus,
  CarryFailure,
  CommitEntry,
  CommitMovePreview,
  CommitMoveResult,
  CreateFanoutArgs,
  CreateFanoutResult,
  ChatItem,
  ChatEnvelope,
  ClaudeLoginEvent,
  CodexLoginEvent,
  CodexLoginMethod,
  CodexMcpServer,
  CodexPluginDetail,
  CodexPluginInventory,
  CodexPluginRef,
  CommandPanelKind,
  CommandResult,
  ComposerAttachEvent,
  CreateWorkspaceArgs,
  CreateWorkspaceResult,
  DirEntry,
  DiscardHunkResult,
  DropPosition,
  EffortSetting,
  FileContent,
  FileWriteResult,
  FileHit,
  GitStatus,
  GithubLoginEvent,
  ImageAttachment,
  McpAction,
  McpInventory,
  McpOauthLoginCompletedEvent,
  McpServerInfo,
  ModelOption,
  MemoryScope,
  NotificationSkip,
  PaneKind,
  PaneState,
  PermissionDecision,
  PeerInboundPolicy,
  PermissionMode,
  PermissionRequest,
  PrChecks,
  PrEditable,
  PreviewCaptureResult,
  PreviewIssueCountEvent,
  PreviewOpenEvent,
  PrMergeMethod,
  StackTrainPlan,
  StackTrainResult,
  PrStatus,
  Repo,
  RestackResult,
  ReviewBundle,
  ReviewEnvelope,
  PrCandidate,
  IssueCandidate,
  MigrationImportResult,
  MigrationImportSelection,
  MigrationScan,
  MigrationScanArgs,
  ReviewVerdict,
  RewindActionResult,
  RewindMode,
  StackCascadeResult,
  StackOpProgress,
  ScriptExitEvent,
  ScriptOutputEvent,
  ScriptStatus,
  SideQuestionEvent,
  SlashCommandInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalTabsState,
  TranscriptSearchResult,
  UpdateFromBaseResult,
  UpdateStatus,
  WorkspaceCompareBase,
  WorkspaceDiff
} from './types'
import type { PreviewIssue } from './previewIssues'

/**
 * preload 가 `window.api` 로 노출하는 표면. preload 구현과 renderer 소비가
 * 같은 타입을 보도록 shared 에 둔다(SSOT).
 */
export interface WooiApi {
  getState(): Promise<AppState>

  /**
   * 이미 있는 worktree 를 워크스페이스로 들여오기. 스캔은 읽기만 하고, 들여오기는 고른 키를
   * main 이 **다시 훑어 대조한** 뒤에만 등록한다(경로를 렌더러에서 받아 그대로 믿지 않는다).
   */
  migrate: {
    scan(args?: MigrationScanArgs): Promise<MigrationScan>
    run(selection: MigrationImportSelection): Promise<MigrationImportResult>
  }

  repo: {
    add(): Promise<{ repo?: Repo; error?: string }>
    /**
     * carryItems 는 파일시스템 작업에 그대로 들어가므로 main 이 저장 **직전에** 검증한다.
     * 하나라도 리포 밖을 가리키면 패치 전체가 거부되고 error 가 돌아온다(부분 저장 없음).
     */
    update(
      repoId: string,
      patch: Partial<
        Pick<
          Repo,
          'name' | 'setupScript' | 'runScripts' | 'archiveScript' | 'carryItems' | 'savedPrompts'
        >
      >
    ): Promise<{ error?: string }>
    /**
     * 전달 목록이 비어 있는 리포에, 지금 실제로 존재하는 흔한 파일들(.env·CLAUDE.local.md …)을
     * 한 번에 등록한다. workspaceId 를 주면 이미 만들어진 그 worktree 로도 즉시 전달한다
     * (구버전부터 쓰던 리포는 마이그레이션이 목록을 비워 둬서 이 경로로 구제된다).
     */
    adoptCarrySuggestions(
      repoId: string,
      workspaceId?: string
    ): Promise<{ error?: string; added: string[]; carryFailures?: CarryFailure[] }>
    /**
     * 전달 목록에 적힌 경로 중 **리포 루트에 실제로 없는 것**을 돌려준다(입력 순서·표기 그대로).
     *
     * 설정 모달이 저장 전에 "이 경로는 아무것도 전달하지 않는다" 를 그 자리에서 보여 주기 위한
     * 것이다 — 경로 형태만 맞으면 저장은 되지만, 원본이 없으면 전달은 영원히 일어나지 않는다.
     * 존재 확인은 main 만 할 수 있어 IPC 로 뺀다. 형태가 잘못된 경로는 여기서 제외된다
     * (그건 validateCarryPath 가 이미 오류로 띄운다).
     */
    missingCarryPaths(repoId: string, paths: string[]): Promise<string[]>
    remove(repoId: string): Promise<void>
    /**
     * 사이드바에서 리포를 끌어 놓아 표시 순서를 바꾼다. 저장된 배열 순서가 곧 표시 순서다.
     * 대상이 사라졌거나 자기 자신에 놓으면 조용히 무시된다.
     */
    reorder(repoId: string, targetRepoId: string, position: DropPosition): Promise<void>
    listBranches(repoId: string): Promise<string[]>
    listIssues(repoId: string): Promise<IssueCandidate[]>
    listPrs(repoId: string): Promise<PrCandidate[]>
    resolvePr(repoId: string, reference: string): Promise<PrCandidate | null>
    getIssueBody(repoId: string, number: number): Promise<string | null>
    getPrBody(repoId: string, number: number): Promise<string | null>
  }

  workspace: {
    create(args: CreateWorkspaceArgs): Promise<CreateWorkspaceResult>
    fork(
      workspaceId: string,
      opts?: { name?: string; showSemanticsNotice?: boolean }
    ): Promise<CreateWorkspaceResult>
    /**
     * 아카이브는 스크립트가 실패해도 끝까지 진행된다 — worktree 가 사라진 뒤라 되돌릴 것이
     * 없기 때문이다. 실패는 여기 실려 오고, 렌더러가 토스트로 알린다(전문은 main 로그).
     */
    archive(workspaceId: string): Promise<{ archiveScriptFailure?: ArchiveScriptFailure }>
    /**
     * 병합된 PR 로 뜬 아카이브 제안을 해제한다(같은 병합으로는 다시 제안하지 않는다).
     * 아카이브 자체는 위 archive 를 그대로 쓴다 — 제안은 그 입구일 뿐이다.
     */
    dismissArchiveSuggest(workspaceId: string): Promise<void>
    unarchive(workspaceId: string): Promise<{
      error?: string
      carryFailures?: CarryFailure[]
      carryMissing?: string[]
      carrySuggestions?: string[]
    }>
    /** stacked 워크스페이스를 최신 base(부모 브랜치) 위로 rebase 하고 리모트에 force-push 한다. */
    restack(workspaceId: string): Promise<RestackResult>
    /** 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요). */
    switchBranch(workspaceId: string, branch: string): Promise<{ error?: string }>
    /** 아직 아카이브되지 않은 워크스페이스를 지울 때는 아카이브 스크립트도 돈다 — archive 와 같다. */
    remove(
      workspaceId: string,
      deleteBranch: boolean
    ): Promise<{ archiveScriptFailure?: ArchiveScriptFailure }>
    /** 한 레포의 아카이브된 워크스페이스를 모두 영구 삭제한다(브랜치·기록 포함). 삭제된 개수를 반환. */
    removeArchived(repoId: string): Promise<{ count: number }>
    /**
     * 대기 중인 peer 메시지를 전달한다 — **그 워크스페이스에서 턴이 시작된다.**
     * 이미 사라진 메시지(다른 창에서 처리했거나 워크스페이스가 지워졌으면) 는 조용히 무시된다.
     */
    deliverPeerMessage(workspaceId: string, messageId: string): Promise<void>
    /** 대기 중인 peer 메시지를 버린다. 전달되지 않고, 발신 워크스페이스는 답을 받지 못한다. */
    dismissPeerMessage(workspaceId: string, messageId: string): Promise<void>
    /** `await_stacked_work` 가 예약한 자동 깨움을 취소한다. */
    cancelStackedWait(workspaceId: string): Promise<void>
    /** 다른 워크스페이스에서 오는 메시지를 받는 방식. 기본은 'hold'(승인 후 전달). */
    setPeerInbound(workspaceId: string, policy: PeerInboundPolicy): Promise<void>
    setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void>
    setModel(workspaceId: string, model: string | null): Promise<void>
    setEffort(workspaceId: string, effort: EffortSetting | null): Promise<void>
    /** fast mode(`/fast`) 오버라이드. null 이면 전역 설정(settings.fastMode)을 따른다. */
    setFastMode(workspaceId: string, fastMode: boolean | null): Promise<void>
    /**
     * 메인 에이전트를 바꾼다([[canSwitchAgentBackend]]) — 턴이 도는 중이거나 그 에이전트를 쓸 수
     * 없으면 이유를 담은 error 로 돌아온다. 성공하면 모델·effort·fast mode 오버라이드는 새 백엔드
     * 기준으로 초기화된다(백엔드마다 값 자체가 다르다).
     *
     * 대화가 이미 시작된 워크스페이스라면 지금까지의 대화를 새 에이전트에게 넘기는 턴이 한 번
     * 돈다([[agentSwitchNeedsHandoff]]). 사용량이 드는 일이므로 `handoff: true` 로 확인 사실을
     * 함께 보내야 하고, 없이 부르면 main 이 거절한다 — 화면이 낡아 경고 없이 눌린 교체가 그대로
     * 청구되지 않게 한다.
     */
    setAgentBackend(
      workspaceId: string,
      agentBackend: AgentBackendId,
      opts?: { handoff?: boolean }
    ): Promise<{ error?: string }>
    /** 워크스페이스별 알림 음소거를 설정한다. */
    setMuted(workspaceId: string, muted: boolean): Promise<void>
    /**
     * CI 실패를 에이전트에게 넘기는 토글. 켜면 체크가 실패로 확정됐을 때 Wooi 가 턴을 연다.
     * 끄면 진행 상태(시도 횟수)도 함께 지워져, 다시 켜면 상한을 처음부터 받는다.
     */
    setAutoFixCi(workspaceId: string, enabled: boolean): Promise<void>
    /**
     * 멀티 에이전트 모드를 켜고 끈다(실험 기능).
     *
     * 세션이 이미 열려 있으면 다음 세션부터 반영된다 — 위임 도구는 query 를 열 때 options 에
     * 실리는 값이라, 도는 중에 더하거나 뺄 수 없다(`/add-dir` 과 같은 성질).
     */
    setMultiAgent(workspaceId: string, multiAgent: boolean): Promise<void>
    /** 표시 이름 override 를 지정한다. 빈 문자열이면 override 를 지워 기본 규칙으로 되돌린다. */
    rename(workspaceId: string, name: string): Promise<void>
    /**
     * 사이드바에서 워크스페이스를 끌어 놓아 표시 순서를 바꾼다.
     * 어느 행을 잡아도 그 stack 뿌리와 자손을 함께 옮긴다. 같은 레포·아카이브·고정 영역 안에서만
     * 자리를 바꿀 수 있고, 그 외 조합은 main 에서 조용히 무시된다.
     */
    reorder(workspaceId: string, targetWorkspaceId: string, position: DropPosition): Promise<void>
    setPinned(workspaceId: string, pinned: boolean): Promise<void>
    revealInFinder(workspaceId: string): Promise<void>
    openInEditor(workspaceId: string): Promise<void>
    /** /memory — 선택한 스코프의 CLAUDE.md 를 에디터로 연다. */
    openMemory(workspaceId: string, scope: MemoryScope): Promise<{ error?: string }>
    /** `#` 단축키 — CLAUDE.md 에 기억 한 줄을 덧붙이고 쓴 파일 경로를 돌려준다. */
    addMemory(
      workspaceId: string,
      scope: MemoryScope,
      text: string
    ): Promise<{ path?: string; error?: string }>
    /** /add-dir — worktree 밖 디렉토리를 작업 루트로 더한다(다음 메시지부터 적용). */
    addDir(workspaceId: string, dir: string): Promise<{ error?: string }>
  }

  /**
   * fan-out — 같은 프롬프트로 후보 워크스페이스 여럿을 동시에 굴리고, 하나를 채택한다.
   * 워크스페이스 생성 자체는 workspace.create 와 같은 경로를 쓴다(main 의 createWorkspace).
   */
  fanout: {
    /**
     * 후보들을 만들고 한 그룹으로 묶은 뒤, 같은 프롬프트를 전부에게 보낸다.
     * 일부 후보가 실패해도 나머지는 만들어지고, 실패 사유는 failures 로 돌아온다.
     */
    create(args: CreateFanoutArgs): Promise<CreateFanoutResult>
    /**
     * 승자를 채택하고 나머지 형제를 아카이브한다. **확인은 호출 측이 먼저 받는다** —
     * 형제의 미커밋 변경은 아카이브와 함께 사라진다.
     */
    adopt(groupId: string, workspaceId: string): Promise<AdoptFanoutResult>
    /** 그룹 기록만 지운다(워크스페이스는 그대로 남는다). */
    forget(groupId: string): Promise<void>
  }

  chat: {
    /** 텍스트(+선택적 붙여넣기 이미지)를 보낸다. 이미지는 base64 로 세션에 직접 전달된다. */
    send(workspaceId: string, text: string, images?: ImageAttachment[]): Promise<void>
    interrupt(workspaceId: string): Promise<void>
    stopTask(workspaceId: string, taskId: string): Promise<void>
    /**
     * 대화 기록. `limit` 을 주면 **최근 limit 개**만 온다 — 돌아온 개수가 limit 보다 적으면
     * 그보다 오래된 것은 없다는 뜻이다. 생략하면 전부 온다.
     */
    getHistory(workspaceId: string, limit?: number): Promise<ChatItem[]>
    /**
     * 활성 워크스페이스별 누적 비용(USD). backend 가 보고한 값만 담는다.
     * 대화 기록 자체를 렌더러로 끌어오지 않기 위한 통로다 — 화면에는 숫자 하나만 필요하다.
     */
    getCosts(): Promise<Record<string, number>>
    /** /btw 사이드 질문을 띄운다. 답변은 onSideQuestion 으로 스트리밍되며 기록에 남지 않는다. */
    sideQuestion(workspaceId: string, question: string): Promise<void>
    /** /clear — 대화 기록을 비우고 세션을 새로 시작한다(맥락 초기화, 워크스페이스는 유지). */
    clear(workspaceId: string): Promise<void>
    /** 현재 세션의 목표를 지운다. 직접 clear RPC가 있는 백엔드에서만 UI가 노출한다. */
    clearGoal(workspaceId: string): Promise<void>
    /**
     * 워크스페이스를 가로질러 대화 내용을 검색한다(⇧⌘K). 대소문자를 가리지 않는 부분 문자열
     * 검색이고, main 이 트랜스크립트 파일을 흘려 읽어 **매치 스니펫만** 돌려준다 — 원문은
     * 렌더러로 넘어오지 않는다.
     *
     * 아카이브된 워크스페이스도 기본 포함이다(옛 결정을 찾는 게 이 검색의 목적이라서).
     * 결과 수에는 상한이 있고, 걸리면 truncated 로 알린다.
     */
    search(query: string, opts?: { includeArchived?: boolean }): Promise<TranscriptSearchResult>
  }

  permission: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>
    /** 지금 답을 기다리는 승인 요청 전부(창이 없던 동안 올라온 것 포함). */
    pending(): Promise<PermissionRequest[]>
  }

  script: {
    run(workspaceId: string, scriptId: string): Promise<void>
    stop(workspaceId: string, scriptId: string): Promise<void>
    getStatus(workspaceId: string): Promise<ScriptStatus[]>
    /** 지금까지의 누적 출력(꼬리 버퍼). 나중에 뜬 창이 이전 로그를 채우는 데 쓴다. */
    getOutput(workspaceId: string, scriptId: string): Promise<string>
  }

  /**
   * Preview 탭(워크트리의 dev 서버를 앱 안에서 보는 화면). 범용 브라우저가 아니라
   * "이 워크스페이스가 띄운 로컬 서버를 보는 창" 이라 API 도 그만큼만 있다.
   */
  preview: {
    /** 마지막으로 본 주소를 워크스페이스에 영속한다(다음에 열면 여기서 시작한다). */
    setUrl(workspaceId: string, url: string): Promise<void>
    /**
     * Preview 를 이 주소로 연다. 주소를 영속하고 모든 창에 방송하므로, 스크립트 패널이
     * 분리된 창에 있어도 메인 창(또는 분리된 work 창)의 Preview 탭이 받아 움직인다.
     */
    open(workspaceId: string, url: string): Promise<void>
    /**
     * Preview 화면을 캡처해 컴포저 첨부로 보낸다. 성공하면 이미지는 onComposerAttach 로 온다.
     * webContentsId 는 `<webview>.getWebContentsId()` — main 이 그 게스트가 정말 Preview 인지 확인한다.
     */
    capture(workspaceId: string, webContentsId: number): Promise<PreviewCaptureResult>
    /**
     * 요소 픽커를 켜고 사용자가 고를 때까지 기다린다. 고르면 결과는 onComposerAttach 로 오고,
     * 여기서는 끝났다는 것(또는 실패 사유)만 돌려준다. 취소·타임아웃도 error 로 온다.
     */
    pickElement(workspaceId: string, webContentsId: number): Promise<PreviewCaptureResult>
    /** 진행 중인 픽을 취소한다. 켜져 있지 않으면 아무 일도 하지 않는다. */
    cancelPick(webContentsId: number): Promise<void>
    /** 이 게스트의 콘솔·네트워크 문제를 이 워크스페이스 것으로 모으기 시작한다. */
    watchIssues(workspaceId: string, webContentsId: number): Promise<void>
    /** 수집을 멈춘다(패널이 사라질 때). */
    unwatchIssues(webContentsId: number): Promise<void>
    /** 모아 둔 문제 목록. 개수만 방송되므로 패널을 열 때 이걸로 채운다. */
    listIssues(workspaceId: string): Promise<PreviewIssue[]>
    clearIssues(workspaceId: string): Promise<void>
    /** 고른 문제들을 컴포저에 넣는다(결과는 onComposerAttach 로 온다). */
    sendIssues(workspaceId: string, issueIds: string[]): Promise<PreviewCaptureResult>
    onOpen(cb: (e: PreviewOpenEvent) => void): () => void
    onIssues(cb: (e: PreviewIssueCountEvent) => void): () => void
  }

  git: {
    /** force=false 는 짧은 전체 폴링용: 비싼 base 대비 커밋 계산을 캐시해 재사용한다. */
    status(workspaceId: string, force?: boolean): Promise<GitStatus | null>
    diff(workspaceId: string): Promise<WorkspaceDiff | null>
    /**
     * Changes 탭이 무엇과 견줄지 바꾼다. **표시 전용** — PR 대상도 rebase 대상도 바뀌지 않는다
     * ([[compareBase]]).
     */
    setCompareBase(workspaceId: string, compareBase: WorkspaceCompareBase): Promise<void>
    /** 리포당 합류된 fetch 로 origin tracking ref 를 갱신한다. */
    fetch(repoId: string): Promise<void>
    /** 최신 base 브랜치를 현재 브랜치로 머지한다(드리프트 해소). 충돌 시 워킹트리에 충돌이 남는다. */
    updateFromBase(workspaceId: string): Promise<UpdateFromBaseResult>
    /** 진행 중인 머지를 취소한다(충돌 포기). */
    abortMerge(workspaceId: string): Promise<void>
    /**
     * Changes 탭에서 고른 hunk 하나를 워킹 트리에서 되돌린다. `patch` 는 그 hunk 만 담은
     * 완결된 patch 다([[hunkPatch]]). 스테이징·커밋은 하지 않는다.
     */
    discardHunk(workspaceId: string, patch: string): Promise<DiscardHunkResult>
  }

  pr: {
    status(workspaceId: string): Promise<PrStatus | null>
    /** 지정 브랜치(현재 체크아웃 아님 포함)의 PR 상태. 모델 B 스택 조망용. */
    statusForBranch(workspaceId: string, branch: string): Promise<PrStatus | null>
    /**
     * GitHub PR 작성 화면을 브라우저로 연다(`gh pr create --web`). branch 를 주면 그 스택 브랜치로(--head),
     * 없으면 현재 브랜치로 연다. 에러 시 문자열 반환.
     */
    create(workspaceId: string, branch?: string): Promise<{ error?: string }>
    /**
     * 현재 브랜치의 PR 을 병합한다(squash/merge/rebase). 병합만 한다 — 스택 캐스케이드는
     * 여기 딸려 오지 않고, 병합 후 감지된 계획을 stack.syncApply 로 따로 승인받는다.
     */
    merge(workspaceId: string, method: PrMergeMethod): Promise<{ error?: string }>
    /** 현재 브랜치의 PR 을 병합 없이 닫는다. */
    close(workspaceId: string): Promise<{ error?: string }>
    /** 닫힌 PR 을 다시 연다. */
    reopen(workspaceId: string): Promise<{ error?: string }>
    /** Draft PR 을 리뷰 가능 상태로 전환한다. */
    ready(workspaceId: string): Promise<{ error?: string }>
    /** 편집 모달이 채울 제목·본문 원문. PR 이 없거나 못 읽으면 null. */
    editable(workspaceId: string): Promise<PrEditable | null>
    /**
     * PR 제목·본문을 고친다. 준 필드만 바꾼다 — 빈 문자열은 "비우기" 라는 정당한 편집이라
     * 미지정과 구분해 그대로 반영한다.
     */
    edit(workspaceId: string, edits: { title?: string; body?: string }): Promise<{ error?: string }>
    /** PR 의 CI 체크 롤업(Check 탭). PR 이 없으면 null. */
    checks(workspaceId: string): Promise<PrChecks | null>
  }

  /**
   * PR 리뷰 모드. 다른 네임스페이스와 달리 workspaceId 가 아니라 repoId + PR 번호로 동작한다 —
   * 리뷰 대상은 내가 만든 PR 이 아니라 임의의 PR 이기 때문이다.
   */
  review: {
    /** 시작 모달의 열린 PR 드롭다운. */
    listOpenPrs(repoId: string): Promise<PrCandidate[]>
    /**
     * 이 PR 이 속한 스택(아래→위). 스택이 아니면 그 PR 하나만 담아 돌려준다.
     * 시작 모달이 "스택 전체를 리뷰" 선택지를 띄울지 정하는 근거다.
     */
    resolveStack(repoId: string, prNumber: number): Promise<{ prNumbers: number[] }>
    /**
     * 리뷰를 시작한다. PR 조회까지만 기다렸다가 reviewId 를 돌려주고, 워크트리 준비·에이전트
     * 실행·결과는 onReview 스트림으로 흘린다.
     */
    start(args: {
      repoId: string
      /** 리뷰할 PR 들, 아래(base 쪽)부터. 원소가 하나면 지금까지의 단일 PR 리뷰다. */
      prNumbers: number[]
      prompt: string
      /** 생략하면 전역 기본 에이전트로 돈다. */
      agentBackend?: AgentBackendId
      model?: string | null
      effort?: EffortSetting | null
    }): Promise<{ reviewId?: string; error?: string }>
    /** 실행 중인 리뷰를 중단한다. */
    cancel(reviewId: string): Promise<void>
    /**
     * 실패하거나 중단된 리뷰를 이어서 다시 돌린다. 이어받을 에이전트 세션이 있으면 그 대화를
     * 이어 끊긴 턴을 마저 끝내고, 없으면 같은 프롬프트로 처음부터 다시 돌린다.
     */
    resume(reviewId: string): Promise<{ error?: string }>
    /**
     * 지적 1건을 실제 PR 에 게시한다. body 는 사용자가 인라인 편집한 최종 본문이다.
     * 앵커가 있으면 해당 줄의 인라인 코멘트로, 없으면 PR 일반 코멘트로 간다.
     */
    post(
      reviewId: string,
      findingId: string,
      body: string
    ): Promise<{ url?: string; error?: string }>
    /**
     * 안 달기로 한 지적을 목록에서 버린다. 이미 게시한 것은 거부한다
     * (GitHub 에 남은 코멘트를 우리만 잊는 상태가 되기 때문).
     */
    dismiss(reviewId: string, findingId: string): Promise<{ error?: string }>
    /** 리뷰를 완전히 삭제한다(워크트리·ref·결과 기록 모두). */
    close(reviewId: string): Promise<void>
    /** 아카이브된 리뷰를 모두 완전히 삭제한다. */
    removeArchived(): Promise<{ count: number }>
    /** 리뷰 화면 진입 시 diff·지적·활동을 한 번에 읽어온다. */
    load(reviewId: string): Promise<ReviewBundle>
    /**
     * 파일 1건을 "봤음" 으로 표시하거나 표시를 끈다. 켤 때는 그 시점 내용의 지문을 함께
     * 남기고 그 지문을 돌려준다 — 파일이 바뀌면 표시가 저절로 풀린다.
     */
    setFileViewed(
      reviewId: string,
      path: string,
      viewed: boolean,
      /** 어느 레이어의 파일인지. 스택에서는 같은 경로가 여러 레이어에 있어 구분해야 한다. */
      prNumber?: number
    ): Promise<{ key?: string; hash?: string; error?: string }>
    /** 워크트리만 지우고 결과·ref 는 남긴다(되살리기 가능). */
    archive(reviewId: string): Promise<void>
    /** 아카이브된 리뷰의 워크트리를 다시 만든다. */
    unarchive(reviewId: string): Promise<{ error?: string }>
    /**
     * 판정을 제출한다. 개별 코멘트와 별개의 행위로, PR 전체에 대한 판정을 남긴다.
     * request-changes·comment 는 본문이 필수다.
     *
     * GitHub 에는 스택을 한 번에 승인하는 API 가 없으므로 **레이어마다 한 건씩** 낸다.
     * 성공한 레이어는 그 자리에서 기록되므로, 일부가 실패해도 나머지를 다시 낼 필요는 없다.
     */
    submit(
      reviewId: string,
      entries: Array<{ prNumber: number; verdict: ReviewVerdict; body: string }>
    ): Promise<{ submitted: number; errors: Array<{ prNumber: number; error: string }> }>
    /** 답글·새 커밋을 한 번 확인한다. 새 활동은 onReview 로 흘러온다. */
    poll(reviewId: string): Promise<void>
    /** 사용자가 리뷰를 확인했다 — 미확인 표시를 끈다. */
    markSeen(reviewId: string): Promise<void>
    /** 인라인 스레드에 답장한다(새 코멘트가 아니라 기존 대화에 붙는다). */
    reply(
      reviewId: string,
      commentId: number,
      body: string
    ): Promise<{ url?: string; error?: string }>
    /** 앞선 리뷰 맥락 위에서 추가 지시를 보낸다. */
    followUp(reviewId: string, text: string): Promise<{ error?: string }>
  }

  stack: {
    /** 스택을 아래에서 위로 훑는 머지 트레인의 사전 점검. 아무것도 실행하지 않는다. */
    trainPlan(workspaceId: string): Promise<StackTrainPlan>
    /**
     * 사전 점검한 트레인을 실행한다 — 머지 N 번과 force-push M 번이 이 호출 하나에 들어 있다.
     * 반드시 사용자가 계획을 보고 승인한 뒤에만 호출한다.
     */
    trainRun(workspaceId: string, method: PrMergeMethod): Promise<StackTrainResult>
    /** 현재 레이어(baseBranch..HEAD)의 커밋을 최신순으로 읽는다. */
    commitsList(workspaceId: string): Promise<CommitEntry[]>
    /** 히스토리를 바꾸기 전에 blocker·force-push 대상·복구용 tip을 한 번에 계산한다. */
    commitMovePreview(
      workspaceId: string,
      sha: string
    ): Promise<CommitMovePreview | { error: string }>
    /** preview 뒤 사용자가 승인한 이동을 실행한다. 실행 시점의 안전 조건은 main이 다시 검사한다. */
    commitMoveApply(workspaceId: string, sha: string): Promise<CommitMoveResult>
    /**
     * 부모 PR 병합으로 대기 중인 캐스케이드를 실행한다(어디서 병합했든 같은 경로).
     * 자식 브랜치를 rebase 후 force-push 하므로 반드시 사용자 승인 뒤에만 호출한다.
     */
    syncApply(workspaceId: string): Promise<{ error?: string; cascade?: StackCascadeResult }>
    /** 대기 중인 캐스케이드 계획을 무시한다(같은 병합은 다시 알리지 않는다). */
    syncDismiss(workspaceId: string): Promise<void>
    /**
     * 스택과 어긋난 PR 의 base 를 부모 브랜치로 되돌린다(에이전트가 `--base` 없이 PR 을 연 경우).
     * GitHub 쪽 base 만 바꾸고 커밋은 건드리지 않는다.
     */
    baseRetarget(workspaceId: string): Promise<{ error?: string }>
    /** 어긋난 base 를 의도한 것으로 받아들인다(그 base 를 채택하고 다시 묻지 않는다). */
    baseKeep(workspaceId: string): Promise<void>
    /** 에이전트 한 턴을 쓰므로 명시적인 사용자 동작에서만 호출한다. */
    resolveConflict(workspaceId: string): Promise<{ error?: string }>
  }

  fs: {
    /** worktree 내 디렉토리 항목 나열 (relPath 가 '' 이면 루트). */
    list(workspaceId: string, relPath: string): Promise<DirEntry[]>
    /** worktree 내 파일 1개 읽기. 바이너리/과대 파일은 본문 없이 표시 정보만. */
    read(workspaceId: string, relPath: string): Promise<FileContent | null>
    /**
     * 뷰어에서 고친 파일 저장. `baselineSha` 는 `read` 로 받은 `FileContent.sha` 를 그대로
     * 넘긴다 — 그 사이 디스크가 바뀌었으면 쓰지 않고 conflict 를 돌려준다. `force` 는
     * 사용자가 경고를 보고 덮어쓰기를 고른 경우에만 true 로 준다.
     */
    write(
      workspaceId: string,
      relPath: string,
      text: string,
      baselineSha: string | null,
      force?: boolean
    ): Promise<FileWriteResult>
    /**
     * 입력창 `@` 자동완성용 후보 검색. 부분 경로(파일명 조각 또는 `src/co` 같은 경로 조각)를
     * 받아 점수순 후보를 돌려준다. 상위 결과에는 파일 크기가 붙는다.
     */
    search(workspaceId: string, query: string): Promise<FileHit[]>
  }

  agent: {
    /**
     * 등록된 에이전트 백엔드의 메타(라벨·권한 모드·effort 선택지·capabilities·가용성).
     * 렌더러는 이 목록으로 에이전트 피커와 모드/effort UI 를 그린다.
     */
    listBackends(): Promise<AgentBackendMeta[]>
    /** 백엔드의 모델 선택지. 조회 불가(미설치·오류)면 빈 배열. */
    listModels(backendId: AgentBackendId): Promise<ModelOption[]>
  }

  commands: {
    /** 입력창 자동완성용 슬래시 명령/스킬 목록(/btw, /insights, 사용자 스킬 등). */
    list(workspaceId: string): Promise<SlashCommandInfo[]>
    /**
     * 인터랙티브 명령(/mcp·/context·/reload-plugins 등)을 실행해 카드용 데이터를 받는다.
     * 일반 프롬프트로 보내면 동작하지 않는 TUI 전용 명령을 SDK 제어 메서드로 재현한다.
     */
    run(
      workspaceId: string,
      kind: CommandPanelKind
    ): Promise<{ result?: CommandResult; error?: string }>
    /**
     * /mcp 패널에서 서버 1개에 대해 재연결·활성/비활성을 수행하고, 갱신된 서버 목록을 받는다.
     * Claude Code CLI 의 /mcp 처럼 동작이 살아 있는 세션 제어 채널 위에서 일어나도록,
     * 세션이 없으면 main 이 메시지 없이 query 를 띄워(warm up) 동작을 적용한다.
     */
    mcpAction(
      workspaceId: string,
      serverName: string,
      action: McpAction
    ): Promise<{ servers?: McpServerInfo[]; error?: string }>
    /**
     * /rewind 패널에서 고른 체크포인트(사용자 메시지 UUID)로 되돌린다. `mode` 가 파일·대화·둘 다를
     * 가른다. 파일 되돌리기는 파일 체크포인팅이 켜진 살아 있는 세션 위에서만 의미가 있다
     * (세션이 없으면 canRewind=false). 대화 되돌리기는 세션 객체만 살아 있으면 된다.
     */
    rewindAction(
      workspaceId: string,
      userMessageId: string,
      mode: RewindMode
    ): Promise<{ result?: RewindActionResult; error?: string }>
    /**
     * `/wooi:*` 즉시 실행 명령을 에이전트 없이 바로 돌린다([[shared/wooiCommands]]).
     * `rest` 는 명령 뒤에 적은 나머지 텍스트 그대로 — 인자 파싱은 메인이 한다.
     * 결과는 도구가 돌려준 값을 그대로 담은 JSON 이다(카드가 요약해 보여 준다).
     */
    wooiRun(
      workspaceId: string,
      name: string,
      rest: string
    ): Promise<{ result?: unknown; error?: string }>
  }

  rateLimits: {
    /**
     * 계정 레이트리밋 스냅샷을 즉시 다시 조회한다. agentId를 주면 해당 backend만 갱신한다.
     * 최신 AppState를 직접 반환하고, 다른 창에는 evtState 방송도 함께 흘려보낸다.
     *
     * 평소 갱신(턴 종료·주기 폴링)은 main 이 알아서 하므로, 이건 stale 표시를 본 사용자가
     * 누르는 수동 탈출구다. 라이브 세션이 없으면 단명 쿼리를 띄우므로 수 초 걸릴 수 있다.
     */
    refresh(agentId?: AgentBackendId): Promise<AppState>
  }

  terminal: {
    /** 탭(terminalId)의 PTY 를 보장하고 현재 화면 버퍼를 재생한다. */
    start(workspaceId: string, terminalId: string, cols: number, rows: number): Promise<void>
    input(workspaceId: string, terminalId: string, data: string): Promise<void>
    /**
     * 입력창의 `!명령` 을 PTY 에서 실행한다(Claude Code CLI 의 bash 모드).
     * 터미널이 아직 안 떠 있으면 기본 크기로 띄운 뒤 명령을 보낸다.
     */
    runCommand(workspaceId: string, command: string): Promise<void>
    /**
     * 입력창의 `!명령` 을 1회 실행하고 출력을 대화 흐름에 인라인으로 보여 준다
     * (Claude Code CLI 의 bash 모드 — 우측 터미널 패널이 아니라 메시지 영역에 표시).
     */
    exec(workspaceId: string, command: string): Promise<void>
    /** 진행 중인 인라인 `!명령`(exec)을 중단한다. itemId 는 해당 bash 아이템의 id. */
    killInline(workspaceId: string, itemId: string): Promise<void>
    resize(workspaceId: string, terminalId: string, cols: number, rows: number): Promise<void>
    /** workspace 의 모든 터미널 PTY 를 끊는다(탭 구성은 남는다). */
    kill(workspaceId: string): Promise<void>
    /** 탭 구성을 읽는다. 탭이 하나도 없으면 메인이 하나 만들어 돌려준다. */
    tabs(workspaceId: string): Promise<TerminalTabsState>
    /** 새 탭을 만들고 그 탭으로 옮겨 간다. 갱신된 구성을 돌려준다. */
    createTab(workspaceId: string): Promise<TerminalTabsState>
    /** 탭을 닫고 그 PTY 를 종료한다. 마지막 탭을 닫으면 빈 탭이 새로 생긴다. */
    closeTab(workspaceId: string, terminalId: string): Promise<TerminalTabsState>
    /** 탭 이름을 바꾼다(빈 문자열이면 기본 이름으로 되돌린다). */
    renameTab(workspaceId: string, terminalId: string, title: string): Promise<TerminalTabsState>
    selectTab(workspaceId: string, terminalId: string): Promise<TerminalTabsState>
    onData(cb: (e: TerminalDataEvent) => void): () => void
    onExit(cb: (e: TerminalExitEvent) => void): () => void
    /** 탭 구성 변경 방송 — 다른 창(분리한 작업 패널)에서 바꾼 것도 여기로 들어온다. */
    onTabs(cb: (e: TerminalTabsState) => void): () => void
  }

  /**
   * 패널을 별도 창으로 분리한다(듀얼 모니터에서 보조 화면에 띄우기 위한 것).
   * 분리한 창은 메인 창의 선택 워크스페이스를 따라가고, 닫으면 패널이 메인 창으로 되돌아온다.
   */
  pane: {
    open(kind: PaneKind, workspaceId: string | null): Promise<void>
    close(kind: PaneKind): Promise<void>
    focus(kind: PaneKind): Promise<void>
    getState(): Promise<PaneState>
    /** 메인 창 전용 — 선택이 바뀌었음을 분리한 창들에 전달한다. */
    setWorkspace(workspaceId: string | null): Promise<void>
    /** 분리한 창 전용 — 메인 창을 앞으로 가져와 해당 리포 설정을 연다. */
    openRepoSettings(repoId: string): Promise<void>
    /** 분리한 창 전용 — 메인 창을 앞으로 가져와 그 워크스페이스를 연다(현황판 카드 클릭). */
    selectWorkspace(workspaceId: string): Promise<void>
    onState(cb: (state: PaneState) => void): () => void
    onWorkspace(cb: (workspaceId: string | null) => void): () => void
  }

  app: {
    /** macOS Dock 의 미확인 빨간 배지 개수. 0 이면 지운다. */
    setBadgeCount(count: number): Promise<void>
    /** 현재 앱 버전(package.json version). */
    getVersion(): Promise<string>
  }

  update: {
    /** 수동 업데이트 확인. 최신 상태를 반환하고 진행은 onUpdate 로 방송된다. */
    check(): Promise<UpdateStatus>
    /** 마지막으로 방송된 업데이트 상태(확인을 새로 트리거하지 않는다). */
    getStatus(): Promise<UpdateStatus>
    /** 다운로드 완료된 업데이트를 설치하기 위해 앱을 재시작한다. */
    quitAndInstall(): Promise<void>
    /**
     * 지금 말고 "모든 워크스페이스 작업(에이전트 턴·리뷰)이 끝나면" 재시작하도록 예약한다.
     * `false` 로 부르면 예약을 해제한다. 예약 상태는 UpdateStatus 로 되돌아온다.
     */
    setRestartWhenIdle(armed: boolean): Promise<UpdateStatus>
  }

  /** 앱 재배포 없이 표시하는 원격 상단 공지. */
  notice: {
    getActive(): Promise<AppNotice[]>
    refresh(): Promise<AppNotice[]>
  }

  openExternal(url: string): Promise<void>

  settings: {
    update(patch: Partial<AppSettings>): Promise<void>
  }

  /** 데스크톱 알림의 상태 보고. 폰에서 호출할 수는 없다(allowlist.test.ts 가 잠근다). */
  notify: {
    /**
     * 지금 화면에 떠 있는 워크스페이스. 창이 흐려졌거나 아무것도 열지 않았으면 null 이다.
     *
     * 선택 상태는 렌더러 메모리에만 있는데, 알림을 띄우는 것은 main 이다 — 올려 주지 않으면
     * main 은 "앱은 보고 있지만 다른 워크스페이스를 보고 있는" 경우를 가릴 수 없다.
     */
    setViewing(workspaceId: string | null): Promise<void>
    /** 마지막으로 건너뛴 알림의 사유. 아직 없으면 null. */
    lastSkip(): Promise<NotificationSkip | null>
  }

  /**
   * 모바일 컴패니언의 원격 접근 관리. 전부 설정 패널 전용이며,
   * 어느 것도 폰에서 호출할 수 없다(allowlist.test.ts 가 잠근다).
   */
  remote: {
    getStatus(): Promise<RemoteStatus>
    /** 마스터 스위치. 끄면 소켓·타이머가 전부 정리된다. */
    setEnabled(enabled: boolean): Promise<RemoteStatus>
    pairStart(): Promise<RemoteStatus>
    /** 사용자가 SAS 6자리를 확인했다. 여기서 처음으로 세션키가 만들어진다. */
    pairConfirm(): Promise<RemoteStatus>
    pairCancel(): Promise<RemoteStatus>
    revokeDevice(deviceId: string): Promise<RemoteStatus>
    /** 되돌릴 수 없다 — 모든 폰이 재페어링해야 한다. */
    clearData(): Promise<RemoteStatus>
    /**
     * 지금 미확인인 워크스페이스 id 전량. 폰의 미확인 점·앱 배지가 이걸로 그려진다.
     *
     * 미확인은 렌더러 메모리에만 살아서 원격 투영이 볼 수 없다 — 렌더러가 바뀔 때마다
     * 올려 줘야 한다. 폰에서 호출할 수는 없다(allowlist.test.ts 가 잠근다).
     */
    setUnread(workspaceIds: string[]): Promise<void>
  }

  /**
   * MCP 서버 설정 화면용. Wooi 스코프 목록 자체는 AppSettings.mcp 에 있어 `settings.update` 로
   * 고치고, 여기서는 우리가 소유하지 않는 ~/.claude.json 쪽만 다룬다.
   */
  mcp: {
    /** ~/.claude.json 에서 승계되는 서버 목록(표시 전용). */
    inventory(): Promise<McpInventory>
    /** ~/.claude.json 을 기본 편집기로 연다(없으면 담긴 폴더를 연다). */
    openConfig(): Promise<void>
    /** 현재 실행본의 shim/socket 절대 경로가 들어간 복사용 한 줄 명령. */
    externalSetupCommand(): Promise<string>
    /**
     * `~/.codex/config.toml` 에 설정된 MCP 서버 목록. Codex 가 설치돼 있지 않으면 빈 목록이다.
     * 호출하면 codex app-server 가 뜨므로, 렌더러는 Codex 로그인 상태일 때만 부른다.
     */
    codexServers(): Promise<{ servers?: CodexMcpServer[]; error?: string }>
    /** 그 서버의 `enabled` 를 사용자 파일에 쓰고 갱신된 목록을 돌려준다. */
    setCodexServerEnabled(
      name: string,
      enabled: boolean
    ): Promise<{ servers?: CodexMcpServer[]; error?: string }>
    /** OAuth 흐름을 시작하고 브라우저에서 열 authorization URL 을 돌려준다. */
    codexOauthLogin(name: string): Promise<{ authorizationUrl?: string; error?: string }>
    onCodexOauthLoginCompleted(cb: (event: McpOauthLoginCompletedEvent) => void): () => void
  }

  /**
   * Codex Agent Plugins 설정 화면용. **읽기 전용이다** — 설치·삭제·마켓플레이스 추가는 사용자의
   * codex 설치본 전체를 바꾸므로 목록 화면에 곁다리로 달지 않는다.
   */
  plugins: {
    /**
     * 이 Codex 설치본에 깔린 플러그인(마켓플레이스별). MCP 목록과 마찬가지로 호출하면
     * app-server 가 뜨므로, 렌더러는 Codex 로그인 상태일 때만 부른다.
     */
    codexPlugins(): Promise<{ inventory?: CodexPluginInventory; error?: string }>
    /** 그중 하나가 싣고 있는 스킬·MCP 서버·훅. 행을 펼칠 때만 부른다. */
    codexPluginDetail(ref: CodexPluginRef): Promise<{ detail?: CodexPluginDetail; error?: string }>
  }

  auth: {
    getStatus(): Promise<AuthStatus>
    /** 앱 내부 PTY 에서 `claude auth login` 을 시작한다(별도 Terminal 창 없이). 진행은 onClaudeLogin 으로. */
    claudeLoginStart(): Promise<void>
    /** 모달에서 붙여넣은 OAuth 코드를 진행 중인 로그인 PTY 로 제출한다. */
    claudeLoginSubmitCode(code: string): Promise<void>
    /** 진행 중인 로그인 PTY 를 취소·종료한다(모달 닫기). */
    claudeLoginCancel(): Promise<void>
    claudeLogout(): Promise<void>
    /**
     * Codex 로그인을 시작한다. PTY 가 필요 없다 — app-server 가 OAuth 콜백까지 호스팅하므로
     * 'chatgpt' 는 브라우저를 열고 완료를 기다리고(진행은 onCodexLogin 으로), 'apiKey' 는
     * 넘긴 키를 저장하고 즉시 끝난다.
     */
    codexLoginStart(method: CodexLoginMethod, apiKey?: string): Promise<void>
    /** 진행 중인 Codex 브라우저 로그인을 취소한다(모달 닫기). */
    codexLoginCancel(): Promise<void>
    codexLogout(): Promise<void>
    /** Codex 플랜 사용량. API 키 인증이거나 조회 불가면 null. */
    codexRateLimits(): Promise<AgentRateLimits | null>
    /** 앱 내부 PTY 에서 `gh auth login --web` 을 시작한다(별도 Terminal 창 없이). 진행은 onGithubLogin 으로. */
    githubLoginStart(): Promise<void>
    /** 진행 중인 GitHub 로그인 PTY 를 취소·종료한다(모달 닫기). */
    githubLoginCancel(): Promise<void>
    githubLogout(): Promise<void>
  }

  /**
   * 드롭된 File 의 실제 경로. Electron 32+ 에서 `File.path` 가 사라져 webUtils 로만 얻을 수 있다.
   * 얻지 못하면 빈 문자열(드롭 처리 쪽에서 이미지 첨부로 폴백한다).
   */
  pathForFile(file: File): string

  // 단방향 이벤트 구독. 반환값은 구독 해제 함수.
  onChat(cb: (e: ChatEnvelope) => void): () => void
  /** /btw 사이드 질문의 시작/타이핑/완료/오류 스트림. */
  onSideQuestion(cb: (e: SideQuestionEvent) => void): () => void
  onPermission(cb: (e: PermissionRequest) => void): () => void
  /** 응답받지 못한 채 무효가 된 권한 요청의 requestId — 해당 프롬프트를 화면에서 제거. */
  onPermissionCancel(cb: (requestId: string) => void): () => void
  /** 폰이 이 워크스페이스를 열어 읽고 있다 — 미확인 표시를 해제한다. */
  onRemoteRead(cb: (workspaceId: string) => void): () => void
  onScriptOutput(cb: (e: ScriptOutputEvent) => void): () => void
  onScriptExit(cb: (e: ScriptExitEvent) => void): () => void
  /** 컴포저에 붙일 이미지가 도착했다(Preview 스크린샷). 컴포저가 있는 창만 반응한다. */
  onComposerAttach(cb: (e: ComposerAttachEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
  /** restack·stack sync 의 브랜치별 진행 스트림. */
  onStackProgress(cb: (progress: StackOpProgress) => void): () => void
  /** 원격 접근 상태 변화(연결·페어링 진행·기기 목록). */
  onRemote(cb: (status: RemoteStatus) => void): () => void
  /** PR 리뷰 진행 상황·결과 스트림. */
  onReview(cb: (e: ReviewEnvelope) => void): () => void
  /** OS 알림 클릭 시 main 이 보내는 workspace 선택 요청. */
  onSelectWorkspace(cb: (workspaceId: string) => void): () => void
  /** 분리한 패널 창이 요청한 리포 설정 열기(메인 창이 모달을 띄운다). */
  onOpenRepoSettings(cb: (repoId: string) => void): () => void
  /** main 창이 포커스를 얻었을 때의 알림(미확인 표시 해제 트리거). */
  onWindowFocus(cb: () => void): () => void
  /** main 창이 포커스를 잃었을 때의 알림(이후 완료를 미확인으로 잡는 신뢰 신호). */
  onWindowBlur(cb: () => void): () => void
  /** 앱 내부 Claude 로그인 진행 이벤트(인증 URL / 코드 입력 요청 / 완료) 구독. */
  onClaudeLogin(cb: (e: ClaudeLoginEvent) => void): () => void
  /** 앱 내부 Codex 로그인 진행 이벤트(브라우저 인증 URL / 완료) 구독. */
  onCodexLogin(cb: (e: CodexLoginEvent) => void): () => void
  /** 앱 내부 GitHub 로그인 진행 이벤트(one-time 코드·디바이스 URL / 완료) 구독. */
  onGithubLogin(cb: (e: GithubLoginEvent) => void): () => void
  /** 에이전트 계정이 앱 밖에서 바뀌었다는 신호 — 인증 상태를 다시 읽어야 한다. */
  onAuthChanged(cb: () => void): () => void
  /** 자동 업데이트 상태 변화(확인 중/발견/다운로드/준비됨/오류) 구독. */
  onUpdate(cb: (status: UpdateStatus) => void): () => void
  onNotice(cb: (notices: AppNotice[]) => void): () => void
}
