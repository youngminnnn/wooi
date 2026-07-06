import type {
  AppState,
  AppSettings,
  AuthStatus,
  ChatItem,
  ChatEnvelope,
  ClaudeLoginEvent,
  CommandPanelKind,
  CommandResult,
  CreateWorkspaceArgs,
  DirEntry,
  EffortSetting,
  FileContent,
  GitStatus,
  GithubLoginEvent,
  ImageAttachment,
  McpAction,
  McpServerInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PrChecks,
  PrStatus,
  Repo,
  RewindActionResult,
  ScriptExitEvent,
  ScriptKind,
  ScriptOutputEvent,
  ScriptStatus,
  SideQuestionEvent,
  SlashCommandInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateFromBaseResult,
  WorkspaceDiff
} from './types'

/**
 * preload 가 `window.api` 로 노출하는 표면. preload 구현과 renderer 소비가
 * 같은 타입을 보도록 shared 에 둔다(SSOT).
 */
export interface DittoApi {
  getState(): Promise<AppState>

  repo: {
    add(): Promise<{ repo?: Repo; error?: string }>
    update(
      repoId: string,
      patch: Partial<Pick<Repo, 'name' | 'setupScript' | 'devScript' | 'archiveScript'>>
    ): Promise<void>
    remove(repoId: string): Promise<void>
    listBranches(repoId: string): Promise<string[]>
  }

  workspace: {
    create(
      args: CreateWorkspaceArgs
    ): Promise<{ workspaceId?: string; name?: string; branch?: string; error?: string }>
    archive(workspaceId: string): Promise<void>
    unarchive(workspaceId: string): Promise<{ error?: string }>
    remove(workspaceId: string, deleteBranch: boolean): Promise<void>
    /** 한 레포의 아카이브된 워크스페이스를 모두 영구 삭제한다(브랜치·기록 포함). 삭제된 개수를 반환. */
    removeArchived(repoId: string): Promise<{ count: number }>
    setPermissionMode(workspaceId: string, mode: PermissionMode): Promise<void>
    setModel(workspaceId: string, model: string | null): Promise<void>
    setEffort(workspaceId: string, effort: EffortSetting | null): Promise<void>
    /** 표시 이름 override 를 지정한다. 빈 문자열이면 override 를 지워 기본 규칙으로 되돌린다. */
    rename(workspaceId: string, name: string): Promise<void>
    revealInFinder(workspaceId: string): Promise<void>
    openInEditor(workspaceId: string): Promise<void>
    /** /memory — worktree 의 CLAUDE.md 를 에디터로 연다(없으면 worktree 디렉토리를 연다). */
    openMemory(workspaceId: string): Promise<{ error?: string }>
  }

  chat: {
    /** 텍스트(+선택적 붙여넣기 이미지)를 보낸다. 이미지는 base64 로 세션에 직접 전달된다. */
    send(workspaceId: string, text: string, images?: ImageAttachment[]): Promise<void>
    interrupt(workspaceId: string): Promise<void>
    getHistory(workspaceId: string): Promise<ChatItem[]>
    /** /btw 사이드 질문을 띄운다. 답변은 onSideQuestion 으로 스트리밍되며 기록에 남지 않는다. */
    sideQuestion(workspaceId: string, question: string): Promise<void>
    /** /clear — 대화 기록을 비우고 세션을 새로 시작한다(맥락 초기화, 워크스페이스는 유지). */
    clear(workspaceId: string): Promise<void>
  }

  permission: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>
  }

  script: {
    run(workspaceId: string, kind: ScriptKind): Promise<void>
    stop(workspaceId: string, kind: ScriptKind): Promise<void>
    getStatus(workspaceId: string): Promise<ScriptStatus[]>
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
    /** GitHub PR 작성 화면을 브라우저로 연다(`gh pr create --web`). 에러 시 문자열 반환. */
    create(workspaceId: string): Promise<{ error?: string }>
    /** PR 의 CI 체크 롤업(Check 탭). PR 이 없으면 null. */
    checks(workspaceId: string): Promise<PrChecks | null>
  }

  fs: {
    /** worktree 내 디렉토리 항목 나열 (relPath 가 '' 이면 루트). */
    list(workspaceId: string, relPath: string): Promise<DirEntry[]>
    /** worktree 내 파일 1개 읽기. 바이너리/과대 파일은 본문 없이 표시 정보만. */
    read(workspaceId: string, relPath: string): Promise<FileContent | null>
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

  app: {
    /** macOS Dock 의 미확인 빨간 배지 개수. 0 이면 지운다. */
    setBadgeCount(count: number): Promise<void>
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
    /** 앱 내부 PTY 에서 `gh auth login --web` 을 시작한다(별도 Terminal 창 없이). 진행은 onGithubLogin 으로. */
    githubLoginStart(): Promise<void>
    /** 진행 중인 GitHub 로그인 PTY 를 취소·종료한다(모달 닫기). */
    githubLoginCancel(): Promise<void>
    githubLogout(): Promise<void>
  }

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
  /** OS 알림 클릭 시 main 이 보내는 workspace 선택 요청. */
  onSelectWorkspace(cb: (workspaceId: string) => void): () => void
  /** main 창이 포커스를 얻었을 때의 알림(미확인 표시 해제 트리거). */
  onWindowFocus(cb: () => void): () => void
  /** main 창이 포커스를 잃었을 때의 알림(이후 완료를 미확인으로 잡는 신뢰 신호). */
  onWindowBlur(cb: () => void): () => void
  /** 앱 내부 Claude 로그인 진행 이벤트(인증 URL / 코드 입력 요청 / 완료) 구독. */
  onClaudeLogin(cb: (e: ClaudeLoginEvent) => void): () => void
  /** 앱 내부 GitHub 로그인 진행 이벤트(one-time 코드·디바이스 URL / 완료) 구독. */
  onGithubLogin(cb: (e: GithubLoginEvent) => void): () => void
}
