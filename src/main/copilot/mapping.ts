import type * as acp from '@agentclientprotocol/sdk'
import type { ChatItem, PermissionRequest, SlashCommandInfo } from '@shared/types'
import { describeToolKind, isRecord } from './acp'
import { unifiedDiff } from '../claude/editDiff'

/**
 * ACP `session/update` → Wooi 의 대화 아이템.
 *
 * 순수 함수만 둔다 — store·트랜스크립트·방송은 [[copilot/session]] 의 몫이다. 그래야 실제로
 * 받은 페이로드를 픽스처로 박아 테스트할 수 있다(mapping.test.ts 의 값들은 전부 CLI v1.0.80
 * 에서 실제로 받은 것이다).
 */

/** 한 도구 호출의 아이템 id. `tool_call` 과 뒤이은 `tool_call_update` 가 같은 카드로 접힌다. */
export function toolItemId(toolCallId: string): string {
  return `copilot:tool:${toolCallId}`
}

export function toolResultItemId(toolCallId: string): string {
  return `copilot:toolres:${toolCallId}`
}

type ToolUpdate = Extract<acp.SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

/**
 * 도구 이름. 실측에서 Copilot 은 `name` 을 보내지 않고 `title` 만 보내므로 그게 사실상 정본이다
 * ('Editing /tmp/a.txt', 'List files in current directory'). 둘 다 없을 때만 kind 로 떨어진다.
 */
export function toolNameOf(update: {
  name?: string | null
  title?: string | null
  kind?: acp.ToolKind | null
}): string {
  return update.name || update.title || describeToolKind(update.kind)
}

/**
 * `tool_call` → tool_use 아이템.
 *
 * diff 는 **실행 전에만** 만들 수 있어 아이템에 함께 저장한다(대화를 다시 열어도 그때 무엇이
 * 바뀌었는지 보인다 — [[shared/types]] ChatItem 의 diff 주석). Copilot 은 편집 호출의
 * `content` 에 `{type:'diff', path, oldText, newText}` 를 실어 준다(실측).
 */
export function toolUseItem(update: ToolUpdate, ts: number): ChatItem {
  const diff = diffFromToolContent(update.content)
  return {
    id: toolItemId(update.toolCallId),
    type: 'tool_use',
    toolId: update.toolCallId,
    name: toolNameOf(update),
    input: isRecord(update.rawInput) ? update.rawInput : {},
    ...(diff ? { diff } : {}),
    ts
  }
}

/**
 * `tool_call_update` 가 종료 상태를 알릴 때의 tool_result 아이템. 아직 도는 중이면 null.
 *
 * Copilot 은 같은 내용의 `tool_call_update` 를 여러 번 보낸다(스트리밍). id 가 고정이라
 * upsert 로 접히므로 여기서 중복을 걸러 낼 필요는 없다.
 */
export function toolResultItem(update: ToolUpdate, ts: number): ChatItem | null {
  if (update.status !== 'completed' && update.status !== 'failed') return null
  return {
    id: toolResultItemId(update.toolCallId),
    type: 'tool_result',
    toolId: update.toolCallId,
    text: toolOutputText(update),
    isError: update.status === 'failed',
    ts
  }
}

/**
 * 도구 결과 본문. `content` 의 텍스트를 먼저 보고, 없으면 `rawOutput.content` 로 떨어진다 —
 * 읽기 도구는 `content` 없이 `rawOutput` 만 보내는 경우가 있다(실측).
 */
export function toolOutputText(update: ToolUpdate): string {
  const fromContent = (update.content ?? [])
    .map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n')
  if (fromContent) return fromContent
  const raw = update.rawOutput
  if (isRecord(raw) && typeof raw.content === 'string') return raw.content
  return ''
}

/** 편집 호출의 `content` 에서 통합 diff 를 만든다. Claude 경로와 같은 렌더러를 타게 된다. */
export function diffFromToolContent(
  content: acp.ToolCallContent[] | null | undefined
): string | null {
  const parts = (content ?? [])
    .filter((c): c is acp.Diff & { type: 'diff' } => c.type === 'diff')
    .map((c) => unifiedDiff(c.path, c.oldText ?? '', c.newText))
    .filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

/** 이 도구가 작업 트리를 건드렸는가 — Changes 패널에 "다시 읽어라" 신호를 보낼지 가른다. */
export function touchesWorkingTree(kind: acp.ToolKind | null | undefined): boolean {
  return kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'execute'
}

// ── 승인 카드 ─────────────────────────────────────────────────────────────

/**
 * 승인 요청의 성격. 렌더링이 갈린다(명령은 명령 줄, 파일 변경은 diff).
 *
 * 실측: `execute` 는 `rawInput.command` 를, `edit` 은 `rawInput.diff`(git 스타일 통합 diff)를
 * 싣고 온다. 승인 요청의 `title` 은 'Edit file' 처럼 일반적이라, 구체적인 이름은 앞서 받은
 * `tool_call` 에서 가져온다([[copilot/session]] 이 toolCallId 로 짝지어 넘긴다).
 */
export function permissionRequestFrom(
  params: acp.RequestPermissionRequest,
  requestId: string,
  workspaceId: string,
  /** 같은 toolCallId 의 `tool_call` 에서 얻은 구체적 이름(있으면 카드 제목이 훨씬 낫다). */
  knownToolName?: string
): PermissionRequest {
  const tool = params.toolCall
  const input = isRecord(tool.rawInput) ? tool.rawInput : {}
  const diff = typeof input.diff === 'string' ? input.diff.trim() : ''
  const kind: PermissionRequest['kind'] =
    tool.kind === 'execute' ? 'command' : diff ? 'fileChange' : 'tool'

  return {
    requestId,
    workspaceId,
    toolName: knownToolName || toolNameOf(tool),
    ...(tool.title ? { displayName: tool.title } : {}),
    input,
    kind,
    ...(diff ? { diff } : {}),
    options: params.options.map((o) => ({
      id: o.optionId,
      label: o.name,
      behavior: o.kind.startsWith('allow') ? ('allow' as const) : ('deny' as const),
      // `allow_always`·`reject_always` 는 이 **세션 동안** 같은 종류를 기억한다. 프로젝트 파일에
      // 규칙을 남기는 Claude 의 'project' 스코프와는 다르므로 'session' 으로만 적는다.
      ...(o.kind.endsWith('_always')
        ? { rememberForSession: true, rememberScope: 'session' as const }
        : {})
    }))
  }
}

// ── 슬래시 명령 ───────────────────────────────────────────────────────────

/**
 * `available_commands_update` → 입력창 자동완성 목록.
 *
 * Copilot 은 세션 시작 직후 32개를 `name`·`description`·`input.hint` 와 함께 보낸다(실측).
 * 이 명령들은 프롬프트 텍스트로 그대로 보내면 **모델을 거치지 않고** 실행된다 — 그래서 Codex 처럼
 * Wooi 가 손으로 확장할 필요가 없다.
 */
export function commandsFrom(update: acp.AvailableCommandsUpdate): SlashCommandInfo[] {
  return update.availableCommands.map((c) => {
    const hint = c.input && 'hint' in c.input ? c.input.hint : undefined
    return {
      name: c.name,
      description: c.description ?? '',
      ...(hint ? { argumentHint: hint } : {})
    }
  })
}

// ── 못 알아본 것 ──────────────────────────────────────────────────────────

/**
 * 이 업데이트를 우리가 해석하는가. 아니면 `unknown` 카드로 올릴 이름을 돌려준다.
 *
 * 매핑하지 못한 입력을 조용히 버리면 사용자는 대화에 구멍이 났다는 사실조차 모른다
 * ([[shared/types]] ChatItem 의 'unknown' 주석). 여기서 이름을 붙여 눈에 보이게 만든다.
 */
export function unknownUpdateName(update: acp.SessionUpdate): string | null {
  switch (update.sessionUpdate) {
    // 대화로 옮기는 것들.
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
      return null
    // 대화 아이템은 아니지만 세션이 제어 정보로 소비하는 것들.
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'usage_update':
    case 'session_info_update':
      return null
    // 계획(todo) 목록. Wooi 에 대응 UI 가 없어 지금은 흘려보낸다 — 카드로 알리기에는
    // 매 턴 여러 번 갱신돼 대화가 통째로 잠긴다.
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
      return null
    default:
      return `session update "${(update as { sessionUpdate: string }).sessionUpdate}"`
  }
}
