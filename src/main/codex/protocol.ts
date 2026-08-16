import type {
  AgentBackendId,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  EffortSetting,
  ImageAttachment,
  McpAction,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SendMessageOptions
} from '@shared/types'

/**
 * main ↔ codex-host(유틸리티 프로세스) 메시지 프로토콜.
 *
 * Claude 쪽(claude/protocol.ts)과 같은 이유로 별도 프로세스를 쓴다 — app-server 자식 프로세스와
 * 스트림 파싱이 메인에서 돌면, 그 경로의 치명적 오류가 앱 전체를 끌고 내려간다. 호스트가 죽어도
 * 메인은 살아남아 진행 중이던 워크스페이스를 idle 로 되돌리고 다음 사용 시 다시 띄운다.
 *
 * store·트랜스크립트·렌더러 IPC·권한 UI 라우팅은 메인이 계속 소유하므로, 호스트는 영속/표시가
 * 필요한 모든 것을 이 프로토콜로 메인에 위임한다.
 */

/** 스레드를 만들거나 이어갈 때 필요한 설정. 메인이 store 에서 계산해 명령과 함께 보낸다. */
export interface CodexConfig {
  /** worktree 절대 경로. 쓰기 허용 루트이자 실행 디렉터리다. */
  cwd: string
  model: string | null
  effort: EffortSetting | null
  /** Codex Fast service tier. */
  fastMode: boolean
  autoResumeAfterRateLimit?: boolean
  permissionMode: PermissionMode
  /** 이어갈 codex thread id(= workspace.sessionId). 없으면 새 스레드. */
  resumeThreadId: string | null
  /**
   * 이 스레드에 붙일 위임 MCP 서버. 멀티 에이전트 워크스페이스가 아니면 null 이고, 그러면
   * `thread/start` 에 아무것도 실리지 않는다.
   *
   * **스레드 단위**인 것이 요점이다. app-server 프로세스는 모든 Codex 워크스페이스가 공유하므로,
   * 프로세스 인자(`-c`)로 넣으면 단일 에이전트 워크스페이스에까지 도구가 붙는다. `thread/start`
   * 의 `config` 는 그 스레드에만 적용된다(codex/probe.e2e.test.ts 로 실측 확인).
   */
  /**
   * 이 스레드가 띄울 수 있는 서브에이전트 종류. 비어 있으면 위임 도구가 붙지 않는다.
   *
   * 서버 실행 설정이 아니라 **목록**을 넘긴다 — shim 실행 파일은 Wooi 도구와 같은 것을 쓰고,
   * 이 값은 그 shim 이 무엇을 노출할지 정하는 스위치일 뿐이다([[codex/thread]] delegateMcpConfig).
   */
  delegateBackends: AgentBackendId[]
  /**
   * 멀티 에이전트일 때 스레드에 실을 개발자 지침. 위임 도구가 **존재한다는 사실**을 여기서
   * 알린다 — codex 는 MCP 도구를 모델의 도구 목록에 눈에 띄게 올려 주지 않아서, 서버만 붙여
   * 두면 모델이 그 도구를 아예 고려하지 않는다(subagent/catalog.ts 에 측정 결과가 있다).
   */
  delegateInstructions: string | null
}

/** 메인 → 호스트 명령. */
export type CodexCommand =
  | { type: 'prewarm' }
  | {
      type: 'send'
      workspaceId: string
      config: CodexConfig
      text: string
      images?: ImageAttachment[]
      /** 모델에게만 보낼 앞맥락([[claude/protocol]] 의 같은 필드와 같은 뜻). */
      prefix?: string
      /** 이 전송을 기록에서 지운다([[claude/protocol]] 의 같은 필드와 같은 뜻). */
      silent?: boolean
      /** 화면에 일반 사용자 말풍선 대신 출처가 있는 자동 메시지로 남긴다. */
      origin?: SendMessageOptions['origin']
      skill?: { name: string; path: string; prompt: string }
    }
  | { type: 'interrupt'; workspaceId: string }
  | { type: 'setPermissionMode'; workspaceId: string; mode: PermissionMode }
  | { type: 'dispose'; workspaceId: string }
  | { type: 'disposeAll' }
  | { type: 'permissionResponse'; requestId: string; decision: PermissionDecision }
  | { type: 'listModels'; reqId: string }
  | { type: 'listSkills'; reqId: string; cwd: string }
  /** /context·/usage·/permissions 카드용 데이터 조회. */
  | { type: 'runCommand'; reqId: string; workspaceId: string; kind: CommandPanelKind }
  | { type: 'mcpAction'; reqId: string; serverName: string; action: McpAction }
  // 설정 화면용 — 워크스페이스와 무관한 계정/설치 단위 조회라 workspaceId 를 싣지 않는다.
  | { type: 'mcpConfigList'; reqId: string }
  | { type: 'mcpSetEnabled'; reqId: string; serverName: string; enabled: boolean }
  | { type: 'mcpOauthLogin'; reqId: string; serverName: string }
  /** /compact — 대화 압축을 시작한다(진행 상황은 일반 턴 알림으로 흐른다). */
  | { type: 'compact'; workspaceId: string; config: CodexConfig }
  | { type: 'review'; workspaceId: string; config: CodexConfig }
  | { type: 'shell'; workspaceId: string; config: CodexConfig; command: string }
  | { type: 'fork'; workspaceId: string; config: CodexConfig }
  // ── 계정 (app-server 의 account/* 를 호스트 경유로 호출) ──────────────────
  // app-server 프로세스를 하나로 유지하기 위해 계정 조회도 같은 호스트를 지난다 —
  // 별도 연결을 두면 로그인 상태의 출처가 둘로 갈라진다.
  | { type: 'accountStatus'; reqId: string }
  | { type: 'rateLimits'; reqId: string }
  | { type: 'loginStart'; reqId: string; method: CodexLoginMethod; apiKey?: string }
  | { type: 'loginCancel' }
  | { type: 'logout'; reqId: string }

/** Codex 로그인 방식. ChatGPT 는 브라우저 OAuth, apiKey 는 직접 입력이다. */
export type CodexLoginMethod = 'chatgpt' | 'apiKey'

/** 호스트 → 메인 이벤트. Claude 쪽과 의도적으로 같은 모양을 쓴다(메인의 처리 경로를 공유). */
export type CodexEvent =
  | { type: 'event'; workspaceId: string; event: ChatEvent }
  | { type: 'persist'; workspaceId: string; item: ChatItem }
  /** 확정된 thread id — 메인이 workspace.sessionId 에 저장해 다음 실행에서 resume 한다. */
  | { type: 'sessionId'; workspaceId: string; sessionId: string }
  | { type: 'rateLimit'; workspaceId: string }
  /** 턴이 정상 종료 없이 끝났을 때 'running' 에 갇히지 않도록 idle 로 확정한다. */
  | { type: 'settleIdle'; workspaceId: string }
  | { type: 'permissionRequest'; request: PermissionRequest }
  /** 서버가 승인 요청을 스스로 거둬들였을 때(턴 종료·인터럽트 등) 렌더러의 프롬프트도 닫는다. */
  | { type: 'permissionCancel'; requestId: string }
  /** 로그인 진행 상황(브라우저 URL 노출 / 완료). 렌더러 모달이 이 이벤트로 흐른다. */
  | { type: 'login'; update: CodexLoginEvent }
  /** 계정 상태가 바뀌었다(app-server 의 account/updated). auth 상태를 다시 읽으라는 신호. */
  | { type: 'accountChanged' }
  | { type: 'mcpOauthLoginCompleted'; name: string; success: boolean; error?: string }
  | { type: 'skillsChanged' }
  | { type: 'response'; reqId: string; ok: true; data: unknown }
  | { type: 'response'; reqId: string; ok: false; error: string }

/** 앱 내부 Codex 로그인 진행 이벤트. */
export type CodexLoginEvent =
  /** 브라우저에서 인증을 마쳐야 한다. url 은 사용자가 직접 열 수 있도록 모달에도 노출한다. */
  { phase: 'awaiting-browser'; url: string } | { phase: 'done'; success: boolean; error?: string }
