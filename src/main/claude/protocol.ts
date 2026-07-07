import type {
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  EffortSetting,
  ImageAttachment,
  McpAction,
  PermissionDecision,
  PermissionMode,
  PermissionRequest
} from '@shared/types'

/**
 * main ↔ agent-host(유틸리티 프로세스) 메시지 프로토콜.
 *
 * Claude Agent SDK 의 query() 실행(자식 CLI 의 스트림 파싱·고용량 처리)은 메인 프로세스가
 * 아니라 별도 유틸리티 프로세스(host.ts)에서 돈다. 그래야 SDK/스트리밍 경로에서 네이티브
 * fatal 이 나도 메인(=앱 + 다른 모든 세션)이 함께 죽지 않고, 메인은 호스트의 종료를 감지해
 * 영향받은 세션만 idle 로 되돌리고 호스트를 다시 띄울 수 있다.
 *
 * store·트랜스크립트·렌더러 IPC·권한 UI 라우팅은 메인이 계속 소유하므로, 호스트는 영속/표시가
 * 필요한 모든 것을 이 프로토콜로 메인에 위임한다(persist·event·sessionId·permissionRequest).
 */

/** 세션을 만들 때 필요한 설정. 메인이 store 에서 계산해 명령과 함께 호스트로 보낸다. */
export interface SessionConfig {
  cwd: string
  repoPath: string | null
  model: string | null
  /** reasoning effort 선택값(ultracode 포함). null 이면 지정하지 않는다(모델 기본 동작). */
  effort: EffortSetting | null
  permissionMode: PermissionMode
  autoCompact: boolean
  resumeSessionId: string | null
}

/** /btw 사이드 질문 진행 상황(호스트 → 메인 → 렌더러). 'start' 는 메인이 직접 보낸다. */
export type SideQuestionUpdate =
  | { workspaceId: string; id: string; phase: 'delta'; text: string }
  | { workspaceId: string; id: string; phase: 'done' }
  | { workspaceId: string; id: string; phase: 'error'; message: string }

/** 메인 → 호스트 명령. */
export type HostCommand =
  | {
      type: 'send'
      workspaceId: string
      config: SessionConfig
      text: string
      images?: ImageAttachment[]
    }
  | { type: 'interrupt'; workspaceId: string }
  | { type: 'setPermissionMode'; workspaceId: string; mode: PermissionMode }
  | { type: 'dispose'; workspaceId: string }
  | { type: 'disposeAll' }
  | {
      type: 'runCommand'
      reqId: string
      workspaceId: string
      config: SessionConfig
      kind: CommandPanelKind
    }
  | {
      type: 'mcpAction'
      reqId: string
      workspaceId: string
      config: SessionConfig
      serverName: string
      action: McpAction
    }
  | {
      type: 'rewindAction'
      reqId: string
      workspaceId: string
      config: SessionConfig
      userMessageId: string
    }
  | { type: 'listCommands'; reqId: string; cwd: string }
  | {
      type: 'sideQuestion'
      workspaceId: string
      id: string
      cwd: string
      resumeSessionId: string | null
      model: string | null
      effort: EffortSetting | null
      question: string
    }
  | { type: 'permissionResponse'; requestId: string; decision: PermissionDecision }

/** 호스트 → 메인 이벤트. */
export type HostEvent =
  | { type: 'event'; workspaceId: string; event: ChatEvent }
  | { type: 'persist'; workspaceId: string; item: ChatItem }
  | { type: 'sessionId'; workspaceId: string; sessionId: string }
  // 턴이 정상 result 없이 끝나(예: CLI 가 턴 도중 죽음) 'running' 에 갇혔을 때, 완료 알림 없이
  // workspace 를 idle 로 확정하도록 메인에 요청한다(메인의 forceIdle 로 연결).
  | { type: 'settleIdle'; workspaceId: string }
  | { type: 'permissionRequest'; request: PermissionRequest }
  | { type: 'response'; reqId: string; ok: true; data: unknown }
  | { type: 'response'; reqId: string; ok: false; error: string }
  | { type: 'sideQuestion'; update: SideQuestionUpdate }
