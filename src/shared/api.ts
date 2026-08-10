import type {
  AgentBackendId,
  AgentBackendMeta,
  AppNotice,
  AppState,
  AppSettings,
  AgentRateLimits,
  AuthStatus,
  CarryFailure,
  ChatItem,
  ChatEnvelope,
  ClaudeLoginEvent,
  CodexLoginEvent,
  CodexLoginMethod,
  CommandPanelKind,
  CommandResult,
  CreateWorkspaceArgs,
  CreateWorkspaceResult,
  DirEntry,
  DropPosition,
  EffortSetting,
  FileContent,
  FileHit,
  GitStatus,
  GithubLoginEvent,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  ModelOption,
  MemoryScope,
  PaneKind,
  PaneState,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PrChecks,
  PrEditable,
  PrMergeMethod,
  PrStatus,
  Repo,
  RestackResult,
  ReviewBundle,
  ReviewEnvelope,
  ReviewPrCandidate,
  IssueCandidate,
  ReviewVerdict,
  RewindActionResult,
  StackCascadeResult,
  ScriptExitEvent,
  ScriptOutputEvent,
  ScriptStatus,
  SideQuestionEvent,
  SlashCommandInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateFromBaseResult,
  UpdateStatus,
  WorkspaceDiff
} from './types'

/**
 * preload 가 `window.api` 로 노출하는 표면. preload 구현과 renderer 소비가
 * 같은 타입을 보도록 shared 에 둔다(SSOT).
 */
export interface WooiApi {
  getState(): Promise<AppState>

  repo: {
    add(): Promise<{ repo?: Repo; error?: string }>
    /**
     * carryItems 는 파일시스템 작업에 그대로 들어가므로 main 이 저장 **직전에** 검증한다.
     * 하나라도 리포 밖을 가리키면 패치 전체가 거부되고 error 가 돌아온다(부분 저장 없음).
     */
    update(
      repoId: string,
      patch: Partial<
        Pick<Repo, 'name' | 'setupScript' | 'runScripts' | 'archiveScript' | 'carryItems'>
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
    remove(repoId: string): Promise<void>
    /**
     * 사이드바에서 리포를 끌어 놓아 표시 순서를 바꾼다. 저장된 배열 순서가 곧 표시 순서다.
     * 대상이 사라졌거나 자기 자신에 놓으면 조용히 무시된다.
     */
    reorder(repoId: string, targetRepoId: string, position: DropPosition): Promise<void>
    listBranches(repoId: string): Promise<string[]>
    listIssues(repoId: string): Promise<IssueCandidate[]>
    getIssueBody(repoId: string, number: number): Promise<string | null>
  }

  workspace: {
    create(args: CreateWorkspaceArgs): Promise<CreateWorkspaceResult>
    archive(workspaceId: string): Promise<void>
    /**
     * 병합된 PR 로 뜬 아카이브 제안을 해제한다(같은 병합으로는 다시 제안하지 않는다).
     * 아카이브 자체는 위 archive 를 그대로 쓴다 — 제안은 그 입구일 뿐이다.
     */
    dismissArchiveSuggest(workspaceId: string): Promise<void>
    unarchive(workspaceId: string): Promise<{
      error?: string
      carryFailures?: CarryFailure[]
      carrySuggestions?: string[]
    }>
    /** stacked 워크스페이스를 최신 base(부모 브랜치) 위로 rebase 하고 리모트에 force-push 한다. */
    restack(workspaceId: string): Promise<RestackResult>
    /** 모델 B: worktree 내부 스택의 다른 브랜치로 체크아웃 전환한다(clean 워킹트리 필요). */
    switchBranch(workspaceId: string, branch: string): Promise<{ error?: string }>
    remove(workspaceId: string, deleteBranch: boolean): Promise<void>
    /** 한 레포의 아카이브된 워크스페이스를 모두 영구 삭제한다(브랜치·기록 포함). 삭제된 개수를 반환. */
    removeArchived(repoId: string): Promise<{ count: number }>
    setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void>
    setModel(workspaceId: string, model: string | null): Promise<void>
    setEffort(workspaceId: string, effort: EffortSetting | null): Promise<void>
    /** fast mode(`/fast`) 오버라이드. null 이면 전역 설정(settings.fastMode)을 따른다. */
    setFastMode(workspaceId: string, fastMode: boolean | null): Promise<void>
    /** 워크스페이스별 알림 음소거를 설정한다. */
    setMuted(workspaceId: string, muted: boolean): Promise<void>
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
     * 사이드바 순서는 stack 트리의 DFS 결과이므로, 형제(같은 레포 · 같은 부모 · 같은 아카이브 상태)
     * 끼리만 자리를 바꿀 수 있다. 그 외 조합은 main 에서 조용히 무시된다.
     */
    reorder(workspaceId: string, targetWorkspaceId: string, position: DropPosition): Promise<void>
    revealInFinder(workspaceId: string): Promise<void>
    openInEditor(workspaceId: string): Promise<void>
    /** /memory — worktree 의 CLAUDE.md 를 에디터로 연다(없으면 worktree 디렉토리를 연다). */
    openMemory(workspaceId: string): Promise<{ error?: string }>
    /** `#` 단축키 — CLAUDE.md 에 기억 한 줄을 덧붙이고 쓴 파일 경로를 돌려준다. */
    addMemory(
      workspaceId: string,
      scope: MemoryScope,
      text: string
    ): Promise<{ path?: string; error?: string }>
    /** /add-dir — worktree 밖 디렉토리를 작업 루트로 더한다(다음 메시지부터 적용). */
    addDir(workspaceId: string, dir: string): Promise<{ error?: string }>
  }

  chat: {
    /** 텍스트(+선택적 붙여넣기 이미지)를 보낸다. 이미지는 base64 로 세션에 직접 전달된다. */
    send(workspaceId: string, text: string, images?: ImageAttachment[]): Promise<void>
    interrupt(workspaceId: string): Promise<void>
    getHistory(workspaceId: string): Promise<ChatItem[]>
    /**
     * 활성 워크스페이스별 누적 비용(USD). backend 가 보고한 값만 담는다.
     * 대화 기록 자체를 렌더러로 끌어오지 않기 위한 통로다 — 화면에는 숫자 하나만 필요하다.
     */
    getCosts(): Promise<Record<string, number>>
    /** /btw 사이드 질문을 띄운다. 답변은 onSideQuestion 으로 스트리밍되며 기록에 남지 않는다. */
    sideQuestion(workspaceId: string, question: string): Promise<void>
    /** /clear — 대화 기록을 비우고 세션을 새로 시작한다(맥락 초기화, 워크스페이스는 유지). */
    clear(workspaceId: string): Promise<void>
  }

  permission: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>
  }

  script: {
    run(workspaceId: string, scriptId: string): Promise<void>
    stop(workspaceId: string, scriptId: string): Promise<void>
    getStatus(workspaceId: string): Promise<ScriptStatus[]>
    /** 지금까지의 누적 출력(꼬리 버퍼). 나중에 뜬 창이 이전 로그를 채우는 데 쓴다. */
    getOutput(workspaceId: string, scriptId: string): Promise<string>
  }

  git: {
    status(workspaceId: string): Promise<GitStatus | null>
    diff(workspaceId: string): Promise<WorkspaceDiff | null>
    /** 최신 base 브랜치를 현재 브랜치로 머지한다(드리프트 해소). 충돌 시 워킹트리에 충돌이 남는다. */
    updateFromBase(workspaceId: string): Promise<UpdateFromBaseResult>
    /** 진행 중인 머지를 취소한다(충돌 포기). */
    abortMerge(workspaceId: string): Promise<void>
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
    listOpenPrs(repoId: string): Promise<ReviewPrCandidate[]>
    /**
     * 리뷰를 시작한다. PR 조회까지만 기다렸다가 reviewId 를 돌려주고, 워크트리 준비·에이전트
     * 실행·결과는 onReview 스트림으로 흘린다.
     */
    start(args: {
      repoId: string
      prNumber: number
      prompt: string
      /** 생략하면 전역 기본 에이전트로 돈다. */
      agentBackend?: AgentBackendId
      model?: string | null
      effort?: EffortSetting | null
    }): Promise<{ reviewId?: string; error?: string }>
    /** 실행 중인 리뷰를 중단한다. */
    cancel(reviewId: string): Promise<void>
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
    /** 리뷰 화면 진입 시 diff·지적·활동을 한 번에 읽어온다. */
    load(reviewId: string): Promise<ReviewBundle>
    /**
     * 파일 1건을 "봤음" 으로 표시하거나 표시를 끈다. 켤 때는 그 시점 내용의 지문을 함께
     * 남기고 그 지문을 돌려준다 — 파일이 바뀌면 표시가 저절로 풀린다.
     */
    setFileViewed(
      reviewId: string,
      path: string,
      viewed: boolean
    ): Promise<{ hash?: string; error?: string }>
    /** 워크트리만 지우고 결과·ref 는 남긴다(되살리기 가능). */
    archive(reviewId: string): Promise<void>
    /** 아카이브된 리뷰의 워크트리를 다시 만든다. */
    unarchive(reviewId: string): Promise<{ error?: string }>
    /**
     * PR 리뷰를 제출한다. 개별 코멘트와 별개의 행위로, PR 전체에 대한 판정을 남긴다.
     * request-changes·comment 는 본문이 필수다.
     */
    submit(reviewId: string, verdict: ReviewVerdict, body: string): Promise<{ error?: string }>
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
  }

  fs: {
    /** worktree 내 디렉토리 항목 나열 (relPath 가 '' 이면 루트). */
    list(workspaceId: string, relPath: string): Promise<DirEntry[]>
    /** worktree 내 파일 1개 읽기. 바이너리/과대 파일은 본문 없이 표시 정보만. */
    read(workspaceId: string, relPath: string): Promise<FileContent | null>
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
     * /rewind 패널에서 고른 체크포인트(사용자 메시지 UUID)로 추적된 파일을 되돌린다.
     * 파일 체크포인팅이 켜진 살아 있는 세션 위에서만 의미가 있다(세션이 없으면 canRewind=false).
     */
    rewindAction(
      workspaceId: string,
      userMessageId: string
    ): Promise<{ result?: RewindActionResult; error?: string }>
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
    /** workspace PTY 를 보장하고 현재 화면 버퍼를 재생한다. */
    start(workspaceId: string, cols: number, rows: number): Promise<void>
    input(workspaceId: string, data: string): Promise<void>
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
    resize(workspaceId: string, cols: number, rows: number): Promise<void>
    kill(workspaceId: string): Promise<void>
    onData(cb: (e: TerminalDataEvent) => void): () => void
    onExit(cb: (e: TerminalExitEvent) => void): () => void
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
  onScriptOutput(cb: (e: ScriptOutputEvent) => void): () => void
  onScriptExit(cb: (e: ScriptExitEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
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
