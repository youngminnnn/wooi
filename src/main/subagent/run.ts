import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentBackendId, EffortSetting, PermissionMode } from '@shared/types'
import { runAntigravitySubAgent } from './runAntigravity'
import { runClaudeSubAgent } from './runClaude'
import { runCodexSubAgent } from './runCodex'

/**
 * 위임 실행(서브런)의 백엔드 분배기.
 *
 * 메인 에이전트가 **다른 종류의** 에이전트에게 일을 넘길 때 실제로 도는 것이 이것이다. 리뷰의
 * `review/run.ts` 와 같은 모양의 계약을 쓴다 — 같은 프롬프트를 받고, 같은 결과를 돌려주며,
 * 백엔드를 늘려도 여기 한 줄만 는다.
 *
 * ## 왜 워크스페이스를 만들지 않나
 *
 * 지금 Wooi 에서 서브에이전트는 **사용자가 조작하는 대상이 아니다** — 메인 에이전트가 띄우고
 * 끝날 때까지 기다리는 일회성 작업이고, 부모 턴의 도구 카드로만 트랜스크립트에 남는다. 위임도
 * 그 경험을 그대로 따르므로 worktree·브랜치·세션 UI 를 새로 만들지 않는다. 그래서 여기서 필요한
 * 것은 "한 번 돌리고 결과 텍스트를 돌려주는" 최소 계약뿐이다.
 *
 * ## 그래서 도구 호출은 블로킹이다
 *
 * 완료 신호를 따로 설계하지 않는다. 서브런이 끝나는 것이 곧 도구 호출의 반환이고, 그 결과가
 * 도구 결과가 된다 — Claude 의 Task 도구와 완전히 같은 모양이라 모델이 새로 배울 것이 없다.
 */

/** 서브런이 지금 무엇을 하고 있는지 알리는 최소 신호. 사이드바 패널 갱신에만 쓴다. */
export interface SubAgentActivity {
  kind: 'text' | 'tool' | 'error'
  /** 사람이 읽는 한 줄(도구 호출 요약 또는 어시스턴트 텍스트). */
  text: string
  /**
   * 도구 이름(알 수 있으면). Claude 는 SDK 블록에서 그대로 얻지만, Codex 의 JSONL 은 이름 대신
   * 이미 요약된 한 줄(`$ npm test`)을 주므로 비어 있다 — 그때는 호출부가 `text` 를 대신 쓴다.
   */
  toolName?: string
}

export interface SubAgentRunDeps {
  /** 이 작업을 돌릴 백엔드. 부모와 달라도 된다(그게 이 기능의 요점이다). */
  backend: AgentBackendId
  /** 부모 워크스페이스의 worktree. 서브런은 같은 체크아웃에서 돈다. */
  cwd: string
  /** MCP 서버 해석 기준이 되는 원본 repo 경로. */
  repoPath: string | null
  model: string | null
  effort: EffortSetting | null
  /**
   * 부모 워크스페이스의 권한 모드. 서브런의 승인·샌드박스 정책을 여기서 도출한다 —
   * 위임했다고 해서 부모보다 넓은 권한을 갖게 되면 안 된다.
   */
  permissionMode: PermissionMode
  prompt: string
  abort: AbortController
  onActivity: (activity: SubAgentActivity) => void
  /**
   * 도구 승인 콜백. 호출부는 부모 세션의 규칙을 재사용하지 않고 위임 전용 권한 카드를 매번 띄운다.
   * 부모 워크스페이스가 fullAccess 면 즉시 허용하지만, 저장된 always-allow 규칙과 auto 모드
   * 분류기는 적용하지 않는다.
   *
   * 주지 않으면 막지 않고 통과시킨다. 비대화형 실행에 승인 채널이 없는 Codex 와 Antigravity
   * 경로는 이 값을 사용하지 않는다.
   */
  canUseTool?: SubAgentPermission
}

/** 위임 실행용 승인 콜백. Claude 경로만 사용하며 Codex 와 Antigravity 는 승인 채널이 없다. */
export type SubAgentPermission = (
  toolName: string,
  input: Record<string, unknown>,
  options: { title?: string; displayName?: string; decisionReason?: string }
) => Promise<PermissionResult>

export interface SubAgentResult {
  /** 서브에이전트의 최종 답변. 이것이 그대로 도구 결과가 된다. */
  text: string
  /** 이어 붙일 세션 id(Claude session, Codex thread, Antigravity conversation). 지금은 진단용. */
  sessionId: string | null
  error: string | null
}

export function runSubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  switch (deps.backend) {
    case 'codex':
      return runCodexSubAgent(deps)
    case 'antigravity':
      return runAntigravitySubAgent(deps)
    case 'claude':
    default:
      return runClaudeSubAgent(deps)
  }
}
