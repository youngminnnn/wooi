import { randomUUID } from 'node:crypto'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_BACKEND_LABELS,
  workspaceDisplayName,
  type AgentBackendId,
  type PermissionDecision,
  type PermissionRequest,
  type Repo,
  type Workspace
} from '@shared/types'
import { getStore } from '../../store'
import { isReadOnlyToolName } from './catalog'
import { resolvePrBase } from './pullRequest'
import { scriptCommandFor } from './script'

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

/**
 * 위임된 서브에이전트의 **내부** 도구 호출을 승인받는다.
 *
 * 위임 도구 호출 자체(`claude_subagent`)는 ensureToolApproved 가 이미 물었다. 여기는 그 서브에이전트가
 * 일하면서 부르는 도구들이다 — 파일을 고치고 명령을 돌리므로 부모와 같은 기준으로 물어야 한다.
 *
 * 부모 세션의 canUseTool(session.ts)을 그대로 쓰지 못하는 이유는 실행 위치다. 서브런은 메인에서
 * 돌고 그 함수는 agent-host 안에 있다. 대신 같은 권한 카드를 쓰고, 누가 부른 것인지 문장에 적어
 * 사용자가 부모의 요청과 헷갈리지 않게 한다.
 *
 * `fullAccess`·`readOnly` 판단은 부모 워크스페이스 모드를 그대로 따른다(needsApproval 과 같은 규칙).
 */
export async function askSubAgentPermission(
  workspace: Workspace,
  backend: AgentBackendId,
  toolName: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  // 사용자가 "승인 없이 돌려라" 를 고른 모드에서 위임만 따로 묻지 않는다.
  if (workspace.permissionMode === 'fullAccess') return { behavior: 'allow', updatedInput: input }
  if (!deps) return { behavior: 'deny', message: 'Wooi cannot ask for permission right now.' }

  const label = AGENT_BACKEND_LABELS[backend] ?? backend
  const requestId = randomUUID()
  const decision = await new Promise<PermissionDecision>((resolve) => {
    pending.set(requestId, resolve)
    deps!.dispatch({
      requestId,
      workspaceId: workspace.id,
      toolName,
      displayName: toolName,
      title: `The ${label} subagent wants to use \`${toolName}\`.`,
      input: clampForCard(input)
    })
  })

  if (decision.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
  }
  return { behavior: 'deny', message: 'The user declined this tool call.' }
}

/**
 * 카드에 실을 입력만 줄인다. 거대한 입력(큰 Write 본문 등)이 IPC 직렬화 경계에서 메인을
 * 터뜨리는 것을 막는다 — 원본은 그대로 서브런에 돌려준다.
 */
function clampForCard(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  }
  return out
}

/** 버튼 라벨용 짧은 명사구. 카탈로그의 annotations.title 과 같은 문구를 쓴다. */
const TOOL_LABELS: Record<string, string> = {
  create_stacked_workspace: 'Create a stacked workspace',
  report_to_parent: 'Report to the parent workspace',
  notify_child: 'Message a stacked workspace',
  open_pull_request: 'Open a pull request',
  run_script: 'Run a repository script',
  stop_script: 'Stop a repository script',
  create_workspace: 'Create a workspace',
  archive_workspace: 'Archive a workspace'
}

/** 카드가 지목된 대상을 이름으로 부를 수 있게 한다. 못 찾으면 핸들러가 어차피 거절한다. */
function targetWorkspace(id: unknown): Workspace | undefined {
  if (typeof id !== 'string' || !id.trim()) return undefined
  return getStore()
    .getState()
    .workspaces.find((w) => w.id === id.trim())
}

function repoOf(workspace: Workspace): Repo | undefined {
  return getStore()
    .getState()
    .repos.find((r) => r.id === workspace.repoId)
}

/** 독립 워크스페이스가 갈라질 브랜치. 핸들러와 같은 근거를 본다(workspaces.ts createWorkspace). */
function defaultBranchFor(workspace: Workspace): string {
  return repoOf(workspace)?.defaultBranch ?? 'the default branch'
}

/** 카드 한 줄 설명. 무엇이 일어나는지 사용자가 보고 판단할 수 있어야 한다. */
function titleFor(tool: string, args: unknown, workspace: Workspace): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (tool === 'create_stacked_workspace') {
    const name = typeof a.name === 'string' && a.name.trim() ? ` on \`${a.name.trim()}\`` : ''
    // 셋업 스크립트 실행은 사용자가 알고 승인해야 하는 부분이라 문장에 남긴다.
    return `The agent wants to create a stacked workspace${name} — this makes a branch, a worktree, and runs the repository's setup script.`
  }
  if (tool === 'create_workspace') {
    const name = typeof a.name === 'string' && a.name.trim() ? ` on \`${a.name.trim()}\`` : ''
    // 스택과 달리 "무엇 위에 쌓이는지" 가 없으므로, 사용자가 판단할 거리는 어디서 갈라지는가다.
    return `The agent wants to create a new workspace${name} branching off \`${defaultBranchFor(workspace)}\` — this makes a branch, a worktree, and runs the repository's setup script.`
  }
  if (tool === 'archive_workspace') {
    const target = targetWorkspace(a.workspaceId)
    // 어느 워크스페이스인지가 이 카드의 전부다 — 잘못 지목된 호출을 사람이 잡을 수 있는 곳은
    // 여기뿐이다. 이름과 브랜치를 함께 적어 같은 이름의 워크스페이스와 헷갈리지 않게 한다.
    const which = target
      ? `${workspaceDisplayName(target)} (\`${target.branch}\`)`
      : 'another workspace'
    // 아카이브 스크립트는 사용자가 알고 승인해야 하는 부분이라 문장에 남긴다
    // (create_stacked_workspace 가 셋업 스크립트를 적는 것과 같은 이유).
    const script = target ? repoOf(target)?.archiveScript.trim() : ''
    const runs = script ? ` and runs the repository's archive script (\`${script}\`)` : ''
    return `The agent wants to archive ${which} — this removes its worktree${runs}. Its branch and conversation are kept.`
  }
  if (tool === 'report_to_parent') {
    return 'The agent wants to report this workspace’s result back to the workspace it was stacked on.'
  }
  if (tool === 'notify_child') {
    // 사용자가 판단할 지점은 "어디를 깨우는가" 다 — archive_workspace 와 같은 이유로 이름과
    // 브랜치를 함께 적는다. 대상 검증은 핸들러가 하므로 여기서는 조회만 한다(잘못 지목된
    // 호출이면 승인을 받은 뒤 도구 오류로 떨어진다).
    const target = targetWorkspace(a.workspaceId)
    const which = target
      ? `${workspaceDisplayName(target)} (\`${target.branch}\`)`
      : 'another workspace stacked on this one'
    return `The agent wants to send a message to ${which} — that starts a turn there.`
  }
  if (tool === 'open_pull_request') {
    const draft = a.draft === true ? 'draft ' : ''
    // base 는 모델의 인자가 아니라 앱이 정한다. 사용자가 판단하는 지점이 바로 그 값이므로
    // 핸들러와 **같은 함수**로 다시 구해 보여 준다 — 카드의 base 와 실제 base 가 갈리면
    // 승인이 승인이 아니게 된다.
    return `The agent wants to open a ${draft}pull request from \`${workspace.branch}\` into \`${resolvePrBase(workspace)}\`.`
  }
  if (tool === 'run_script' || tool === 'stop_script') {
    const name = typeof a.name === 'string' ? a.name : typeof a.kind === 'string' ? a.kind : ''
    const repo = getStore()
      .getState()
      .repos.find((r) => r.id === workspace.repoId)
    const scriptId =
      name.toLowerCase() === 'setup'
        ? 'setup'
        : (repo?.runScripts.find((s) => s.name.toLowerCase() === name.toLowerCase())?.id ?? '')
    // 사용자가 승인하는 대상은 "dev 스크립트" 라는 이름이 아니라 그 안에서 돌아갈 명령이다.
    const command = scriptCommandFor(workspace, scriptId)
    const what = command ? `\`${command}\`` : `the ${name} script`
    const verb = tool === 'run_script' ? 'run' : 'stop'
    return `The agent wants to ${verb} this repository’s ${name} script (${what}).`
  }
  return `The agent wants to run the Wooi tool \`${tool}\`.`
}
