import * as acp from '@agentclientprotocol/sdk'
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { detectCopilot } from './executable'
import { log } from '../logger'

/**
 * GitHub Copilot CLI 와의 ACP(Agent Client Protocol) 배선. **프로토콜만 안다** — 워크스페이스도,
 * 서브런도, 리뷰도 모른다.
 *
 * 세 호출부가 같은 배선을 쓴다:
 *  - `subagent/runAcp.ts`  — teammate 위임(일회성)
 *  - `review/runCopilot.ts` — PR 리뷰(일회성, 읽기 전용)
 *  - `copilot/manager.ts`   — 워크스페이스를 구동하는 메인 에이전트(장수명, 다중 세션)
 *
 * 앞의 둘은 프로세스를 하나 띄워 세션 하나를 돌리고 버리지만, 매니저는 **한 프로세스가 여러
 * 세션**을 든다(실측: 서로 다른 cwd 의 두 세션이 같은 연결에서 병렬로 돌았다). 그래서 이 모듈은
 * 프로세스와 연결만 만들어 주고 세션 수명은 호출부가 정한다.
 */

/** ACP 세션 모드 id. Copilot 이 `session/new` 응답의 availableModes 로 알려 주는 값 그대로다. */
const MODE_PREFIX = 'https://agentclientprotocol.com/protocol/session-modes#'

export const COPILOT_SESSION_MODES = {
  agent: `${MODE_PREFIX}agent`,
  plan: `${MODE_PREFIX}plan`,
  autopilot: `${MODE_PREFIX}autopilot`
} as const

export type CopilotSessionModeName = keyof typeof COPILOT_SESSION_MODES

/**
 * Copilot 이 `session/new` 응답의 configOptions 로 노출하는 설정 id.
 *
 * `mode` 는 `session/set_mode` 와 같은 축이고, `allow_all` 은 **그와 직교하는 두 번째 축**이다
 * (승인 프롬프트를 아예 끈다). 둘의 조합이 Wooi 의 PermissionMode 가 된다 — [[copilot/modes]].
 */
export const COPILOT_CONFIG_IDS = { mode: 'mode', allowAll: 'allow_all' } as const

/** readOnly/plan 에서 사용자에게 묻기 전에 통과시킬 수 있는 ACP ToolKind. */
export const READ_ONLY_TOOL_KINDS = new Set<acp.ToolKind>([
  'read',
  'search',
  'think',
  'fetch',
  'switch_mode'
])

/**
 * 도구 승인 콜백. `subagent/run.ts` 의 `SubAgentPermission` 이 이 모양을 만족한다 —
 * 프로토콜 계층이 서브에이전트 타입을 거꾸로 import 하지 않으려고 여기 따로 적는다.
 */
export type AcpToolPermission = (
  toolName: string,
  input: Record<string, unknown>,
  options: { title?: string; displayName?: string; decisionReason?: string }
  // ACP 는 승인 결과로 옵션 하나를 고를 뿐이라 `behavior` 밖의 필드(updatedInput 등)를 실어
  // 보낼 자리가 없다. 그래서 계약도 딱 그만큼만 요구한다.
) => Promise<{ behavior: 'allow' | 'deny' }>

// ── 프로세스 ─────────────────────────────────────────────────────────────

export interface CopilotAcpProcess {
  proc: ChildProcess
  stream: acp.Stream
  /** 지금까지 모인 stderr. 실패 메시지에 붙여 사람이 읽을 이유를 남긴다. */
  stderr(): string
  /** stdin 을 닫고 프로세스를 정리한다. 여러 번 불러도 안전하다. */
  dispose(): void
}

export class CopilotUnavailableError extends Error {}

/**
 * `copilot --acp --stdio` 를 띄우고 ndjson 스트림을 물린다.
 *
 * `cwd` 는 **프로세스의** 작업 디렉터리일 뿐이다 — 실제 작업 루트는 세션이 `session/new` 의
 * cwd 로 각자 정한다(실측: 프로세스 cwd 와 다른 두 세션이 각자의 경로를 정확히 보고했다).
 */
export async function spawnCopilotAcp(cwd?: string): Promise<CopilotAcpProcess> {
  const install = await detectCopilot()
  if (!install.usable || !install.path) {
    throw new CopilotUnavailableError(install.reason ?? 'GitHub Copilot CLI is unavailable.')
  }

  // `--effort` 는 넘기지 않는다. 서버 옵션으로 존재하지만 **모델마다 지원 범위가 다른데 어느
  // 모델이 뽑힐지 우리가 정할 수 없다** — 실측에서 턴 전체가 이 한 줄로 깨졌다:
  //   `Reasoning effort 'low' is not supported for model 'claude-haiku-4.5'.`
  // auto model selection 만 되는 플랜에서는 사용자도 모델을 못 고르므로 피할 방법이 없다.
  const proc = spawn(install.path, ['--acp', '--stdio'], {
    ...(cwd ? { cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => (stderr += chunk))
  // spawn 실패(ENOENT·EACCES)는 **비동기 'error' 이벤트**로 온다. 리스너가 없으면 EventEmitter
  // 규약대로 throw 되는데, 그 시점은 이미 호출부의 try 블록 밖이라 메인 프로세스의 uncaught
  // exception 이 된다(실측 확인). detectCopilot 의 경로는 10초 캐시라 그 사이 CLI 가 사라질 수
  // 있으므로 닿을 수 있는 경로다. 여기서 받아 두면 stdout 이 닫히며 ACP 연결이 끊기고, 호출부는
  // 그 끊김을 사람이 읽는 오류로 바꾼다.
  proc.on('error', (err) => {
    stderr += `${stderr ? '\n' : ''}${err.message}`
    log.error('copilot: acp spawn failed', err)
  })

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin as NonNullable<typeof proc.stdin>),
    Readable.toWeb(proc.stdout as NonNullable<typeof proc.stdout>)
  )

  let disposed = false
  return {
    proc,
    stream,
    stderr: () => stderr,
    dispose: () => {
      if (disposed) return
      disposed = true
      proc.stdin?.end()
      if (!proc.killed) proc.kill('SIGTERM')
    }
  }
}

// ── 핸드셰이크 ───────────────────────────────────────────────────────────

/**
 * ACP `initialize`. 파일·터미널 기능을 광고하지 **않아** Copilot 이 자기 도구를 쓰게 하고,
 * 그 접근이 모두 `session/request_permission` 을 지나 Wooi 의 승인 카드에 나타나게 한다.
 * 우리가 fs 기능을 광고하면 Copilot 이 우리를 통해 파일을 읽고 써 승인 경계가 사라진다.
 */
export function initializeAcp(ctx: acp.ClientContext): Promise<acp.InitializeResponse> {
  return ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
  })
}

/**
 * ACP 오류를 사용자에게 보여 줄 한 문장으로. 인증 실패만 따로 집어낸다 — 그것만이 사용자가
 * 지금 할 수 있는 일이 있는 경우이기 때문이다.
 */
export function describeAcpFailure(err: unknown, stderr = ''): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/auth_required/i.test(message)) {
    return 'GitHub Copilot authentication is required. Run `copilot login` in a terminal and sign in.'
  }
  const detail = stderr.trim()
  return `GitHub Copilot ACP session failed: ${message}${detail ? ` ${detail}` : ''}`
}

// ── 승인 ─────────────────────────────────────────────────────────────────

/**
 * 일회성 실행(위임 서브런·리뷰)의 승인 판정.
 *
 * 메인 에이전트 경로는 이 함수를 쓰지 않는다 — 그쪽은 렌더러에 승인 카드를 띄우고 사용자의
 * 응답을 기다리는 비동기 왕복이라 모양이 다르다([[copilot/session]]).
 */
export async function decideAcpPermission(
  deps: { permissionMode: string; canUseTool?: AcpToolPermission },
  params: acp.RequestPermissionRequest
): Promise<acp.RequestPermissionResponse> {
  const tool = params.toolCall
  const restricted = deps.permissionMode === 'readOnly' || deps.permissionMode === 'plan'
  // ACP 에 OS 샌드박스라는 두 번째 방어선은 없다. Copilot 이 승인 요청 없이 도구를 실행하는
  // 구현으로 바뀌면 이 계층에서는 막을 수 없다는 한계를 감수하고 요청 경계에서 최대한 좁힌다.
  if (restricted && (!tool.kind || !READ_ONLY_TOOL_KINDS.has(tool.kind))) {
    return rejectPermission(params.options)
  }

  const input = isRecord(tool.rawInput) ? tool.rawInput : {}
  // 카드에 그대로 실리는 이름이다("… wants to use `X`"). 실측에서 Copilot 은 name 을 안 보내고
  // title('Create file')만 보내므로 그게 사실상 정본이고, 둘 다 없을 때만 kind 로 떨어진다.
  const toolName = tool.name || tool.title || describeToolKind(tool.kind)
  const decision = deps.canUseTool
    ? await deps.canUseTool(toolName, input, { title: tool.title ?? undefined })
    : { behavior: 'allow' as const, updatedInput: input }
  if (decision.behavior === 'allow') return allowPermission(params.options)
  return rejectPermission(params.options)
}

/**
 * 승인 옵션 하나를 고른다. 실측에서 Copilot 이 보내는 kind 는
 * `allow_once`·`allow_always`·`reject_once` 셋이다(`reject_always` 는 오지 않았다) — 그래서
 * 특정 kind 가 반드시 있다고 가정하지 않고 접두사까지 훑은 뒤 마지막에 cancel 로 떨어진다.
 */
export function allowPermission(options: acp.PermissionOption[]): acp.RequestPermissionResponse {
  const option =
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind.startsWith('allow'))
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

export function rejectPermission(options: acp.PermissionOption[]): acp.RequestPermissionResponse {
  const option =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    options.find((o) => o.kind.startsWith('reject'))
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

/** ToolKind 를 사람이 읽는 이름으로. 실측에서 Copilot 은 title 없이 kind 만 보내는 호출이 있다. */
export function describeToolKind(kind: acp.ToolKind | null | undefined): string {
  return kind && kind !== 'other' ? kind : 'GitHub Copilot CLI tool'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
