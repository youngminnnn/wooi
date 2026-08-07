import { randomUUID } from 'node:crypto'
import type { PermissionDecision, PermissionRequest, Workspace } from '@shared/types'
import { isReadOnlyToolName } from './catalog'
import { resolvePrBase } from './pullRequest'

/**
 * 소켓으로 들어온 Wooi 도구 호출에 사용자 승인을 받는다.
 *
 * Claude 는 SDK 의 canUseTool 이 이 자리를 맡지만(session.ts), **Codex 에는 MCP 도구 승인
 * 요청이 아예 없다** — app-server 는 명령·파일 변경·권한 상승만 물어보고 MCP 도구는 그냥
 * 실행한다(SERVER_REQUEST 목록에 해당 항목이 없다). 그러면 워크스페이스 생성처럼 브랜치를
 * 만들고 리포의 셋업 스크립트를 실행하는 동작이 아무 확인 없이 나간다.
 *
 * 그래서 우리 쪽 창구(소켓)에서 직접 묻는다. 카드는 기존 권한 UI 를 그대로 쓴다 — 앱을
 * 조작하는 통로에 별도의 승인 화면을 만들지 않는다.
 */

export interface ToolPermissionDeps {
  /** 렌더러에 권한 카드를 띄운다(IPC.evtPermission). */
  dispatch: (request: PermissionRequest) => void
}

let deps: ToolPermissionDeps | null = null
const pending = new Map<string, (decision: PermissionDecision) => void>()

export function initToolPermission(injected: ToolPermissionDeps): void {
  deps = injected
}

/**
 * 렌더러의 응답을 흘려 넣는다. 우리 요청이 아니면 조용히 무시한다 —
 * 응답은 백엔드들에도 함께 방송되므로(orchestrator.respondPermission) 멱등해야 한다.
 */
export function resolveToolPermission(requestId: string, decision: PermissionDecision): void {
  const resolve = pending.get(requestId)
  if (!resolve) return
  pending.delete(requestId)
  resolve(decision)
}

/** 호스트가 죽거나 앱이 닫힐 때 매달린 요청을 정리한다. */
export function cancelToolPermissions(): void {
  for (const resolve of pending.values()) resolve({ behavior: 'deny' })
  pending.clear()
}

/**
 * 이 호출을 사용자에게 물어야 하는가.
 *
 * - 읽기 전용 도구는 묻지 않는다(Claude 쪽 정책과 같다 — 상태를 바꾸지 않으니 승인이 결정할
 *   것이 없고, 매번 카드가 뜨면 정작 물어야 할 것이 묻힌다).
 * - `fullAccess` 는 사용자가 "승인 없이 돌려라" 를 고른 모드다. 그 기대를 여기서만 뒤집지 않는다.
 */
function needsApproval(workspace: Workspace, tool: string): boolean {
  if (isReadOnlyToolName(tool)) return false
  if (workspace.permissionMode === 'fullAccess') return false
  return true
}

/**
 * 승인을 받는다. 거부면 throw 해서 도구가 실행되지 않게 한다 — 던진 문장은 도구 오류로
 * 모델에게 가므로, 모델이 "사용자가 거절했다" 를 알고 다른 길을 찾을 수 있다.
 */
export async function ensureToolApproved(
  workspace: Workspace,
  tool: string,
  args: unknown
): Promise<void> {
  if (!needsApproval(workspace, tool)) return
  if (!deps) throw new Error('Wooi cannot ask for permission right now.')

  const requestId = randomUUID()
  const decision = await new Promise<PermissionDecision>((resolve) => {
    pending.set(requestId, resolve)
    deps!.dispatch({
      requestId,
      workspaceId: workspace.id,
      toolName: `mcp__wooi__${tool}`,
      displayName: TOOL_LABELS[tool] ?? tool,
      title: titleFor(tool, args, workspace),
      input: (args ?? {}) as Record<string, unknown>
    })
  })

  if (decision.behavior !== 'allow') {
    throw new Error('The user declined this action.')
  }
}

/** 버튼 라벨용 짧은 명사구. 카탈로그의 annotations.title 과 같은 문구를 쓴다. */
const TOOL_LABELS: Record<string, string> = {
  create_stacked_workspace: 'Create a stacked workspace',
  report_to_parent: 'Report to the parent workspace',
  open_pull_request: 'Open a pull request'
}

/** 카드 한 줄 설명. 무엇이 일어나는지 사용자가 보고 판단할 수 있어야 한다. */
function titleFor(tool: string, args: unknown, workspace: Workspace): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (tool === 'create_stacked_workspace') {
    const name = typeof a.name === 'string' && a.name.trim() ? ` on \`${a.name.trim()}\`` : ''
    // 셋업 스크립트 실행은 사용자가 알고 승인해야 하는 부분이라 문장에 남긴다.
    return `The agent wants to create a stacked workspace${name} — this makes a branch, a worktree, and runs the repository's setup script.`
  }
  if (tool === 'report_to_parent') {
    return 'The agent wants to report this workspace’s result back to the workspace it was stacked on.'
  }
  if (tool === 'open_pull_request') {
    const draft = a.draft === true ? 'draft ' : ''
    // base 는 모델의 인자가 아니라 앱이 정한다. 사용자가 판단하는 지점이 바로 그 값이므로
    // 핸들러와 **같은 함수**로 다시 구해 보여 준다 — 카드의 base 와 실제 base 가 갈리면
    // 승인이 승인이 아니게 된다.
    return `The agent wants to open a ${draft}pull request from \`${workspace.branch}\` into \`${resolvePrBase(workspace)}\`.`
  }
  return `The agent wants to run the Wooi tool \`${tool}\`.`
}
