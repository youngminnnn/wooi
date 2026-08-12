import * as acp from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { detectCopilot } from '../copilot/executable'
import { log } from '../logger'
import { describeArg, truncate } from '../review/artifact'
import type { SubAgentActivity, SubAgentRunDeps, SubAgentResult } from './run'

/** readOnly/plan 에서 사용자에게 묻기 전에 통과시킬 수 있는 ACP ToolKind. */
export const READ_ONLY_TOOL_KINDS = new Set<acp.ToolKind>([
  'read',
  'search',
  'think',
  'fetch',
  'switch_mode'
])

export function copilotEffort(effort: SubAgentRunDeps['effort']): string | null {
  if (!effort) return null
  if (effort === 'minimal') return 'low'
  if (effort === 'ultracode') return 'xhigh'
  return effort
}

type PermissionResponse = acp.RequestPermissionResponse

export async function decideAcpPermission(
  deps: Pick<SubAgentRunDeps, 'permissionMode' | 'canUseTool'>,
  params: acp.RequestPermissionRequest
): Promise<PermissionResponse> {
  const tool = params.toolCall
  const restricted = deps.permissionMode === 'readOnly' || deps.permissionMode === 'plan'
  // ACP 에 OS 샌드박스라는 두 번째 방어선은 없다. Copilot 이 승인 요청 없이 도구를 실행하는
  // 구현으로 바뀌면 이 계층에서는 막을 수 없다는 한계를 감수하고 요청 경계에서 최대한 좁힌다.
  if (restricted && (!tool.kind || !READ_ONLY_TOOL_KINDS.has(tool.kind))) {
    return rejectPermission(params.options)
  }

  const input = isRecord(tool.rawInput) ? tool.rawInput : {}
  const toolName = tool.name || tool.title || tool.kind || 'other'
  const decision = deps.canUseTool
    ? await deps.canUseTool(toolName, input, { title: tool.title ?? undefined })
    : { behavior: 'allow' as const, updatedInput: input }
  if (decision.behavior === 'allow') {
    const option =
      params.options.find((o) => o.kind === 'allow_once') ??
      params.options.find((o) => o.kind === 'allow_always') ??
      params.options.find((o) => o.kind.startsWith('allow'))
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
  return rejectPermission(params.options)
}

function rejectPermission(options: acp.PermissionOption[]): PermissionResponse {
  const option =
    options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function activityFromAcpUpdate(update: acp.SessionUpdate): SubAgentActivity | null {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return update.content.text.trim()
      ? { kind: 'text', text: truncate(update.content.text.trim()) }
      : null
  }
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    return null
  const toolName = update.name || update.title || update.kind || 'other'
  const input = 'rawInput' in update && isRecord(update.rawInput) ? update.rawInput : {}
  const hint = describeArg(
    input.file_path,
    input.path,
    input.pattern,
    input.command,
    input.description,
    input.prompt
  )
  // ACP 는 이름을 구조적으로 주므로 Codex 용 activity.toolName ?? activity.text 폴백이 필요 없다.
  return { kind: 'tool', toolName, text: truncate(hint ? `${toolName}: ${hint}` : toolName) }
}

export function resultFromAcpStop(
  text: string,
  sessionId: string | null,
  stopReason: acp.StopReason,
  aborted: boolean,
  stderr = ''
): SubAgentResult {
  if (aborted || stopReason === 'cancelled') return { text, sessionId, error: null }
  const output = text.trim()
  return {
    text: output,
    sessionId,
    error:
      output || stopReason === 'end_turn'
        ? null
        : `GitHub Copilot stopped without a response (${stopReason}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`
  }
}

/**
 * Copilot ACP 서버는 세션 턴 수 상한을 제공하지 않는다. 검증되지 않은 프로토콜 필드를 만들지 않고
 * 부모 인터럽트와 ACP cancel 을 폭주를 끊는 경계로 쓴다.
 */
export async function runAcpSubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  const install = await detectCopilot()
  if (!install.usable || !install.path) {
    return {
      text: '',
      sessionId: null,
      error: install.reason ?? 'GitHub Copilot CLI is unavailable.'
    }
  }

  const effort = copilotEffort(deps.effort)
  const args = ['--acp', '--stdio', ...(effort ? [`--effort=${effort}`] : [])]
  // ACP v1 session/new 과 서버 플래그 모두 모델 선택을 제공하지 않으므로 deps.model 은 의도적으로
  // 무시한다. 존재하지 않는 설정을 도구 설명에 노출하면 매 요청의 프롬프트만 늘어난다.
  const proc = spawn(install.path, args, { cwd: deps.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => (stderr += chunk))
  // spawn 실패(ENOENT·EACCES)는 **비동기 'error' 이벤트**로 온다. 리스너가 없으면 EventEmitter
  // 규약대로 throw 되는데, 그 시점은 이미 try 블록 밖이라 메인 프로세스의 uncaught exception 이
  // 된다(실측 확인). detectCopilot 의 경로는 10초 캐시라 그 사이 CLI 가 사라질 수 있으므로
  // 닿을 수 있는 경로다. 여기서 받아 두면 stdout 이 닫히며 ACP 연결이 끊기고, 아래 catch 가
  // 이 문장을 사람이 읽는 error 로 돌려준다.
  proc.on('error', (err) => {
    stderr += `${stderr ? '\n' : ''}${err.message}`
    log.error('subagent: copilot spawn failed', err)
  })

  let text = ''
  let sessionId: string | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))
    return await acp
      .client({ name: 'wooi' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        decideAcpPermission(deps, ctx.params)
      )
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // 파일·터미널 기능을 광고하지 않아 Copilot 자체 도구를 쓰게 하고, 그 접근이 모두
          // session/request_permission 을 지나 Wooi 카드에 나타나게 한다.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        })
        return ctx.buildSession(deps.cwd).withSession(async (session) => {
          sessionId = session.sessionId
          const cancel = (): void => {
            void ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
            // 정상 서버는 cancelled stop 을 보낸다. 파이프가 망가진 경우에만 짧게 기다린 뒤 kill 한다.
            graceTimer = setTimeout(() => proc.kill('SIGTERM'), 1_500)
          }
          deps.abort.signal.addEventListener('abort', cancel, { once: true })
          if (deps.abort.signal.aborted) cancel()
          try {
            void session.prompt(deps.prompt).catch(() => {})
            for (;;) {
              const message = await session.nextUpdate()
              if (message.kind === 'session_update') {
                const update = message.update
                if (
                  update.sessionUpdate === 'agent_message_chunk' &&
                  update.content.type === 'text'
                ) {
                  text += update.content.text
                }
                const activity = activityFromAcpUpdate(update)
                if (activity) deps.onActivity(activity)
                continue
              }
              return resultFromAcpStop(
                text,
                sessionId,
                message.stopReason,
                deps.abort.signal.aborted,
                stderr
              )
            }
          } finally {
            deps.abort.signal.removeEventListener('abort', cancel)
          }
        })
      })
  } catch (err) {
    const detail = stderr.trim()
    const message = err instanceof Error ? err.message : String(err)
    const auth = /auth_required/i.test(message)
    const error = auth
      ? 'GitHub Copilot authentication is required. Run `copilot` in a terminal and sign in.'
      : `GitHub Copilot ACP session failed: ${message}${detail ? ` ${detail}` : ''}`
    log.error('subagent: copilot ACP failed', err)
    return { text: '', sessionId: null, error }
  } finally {
    if (graceTimer) clearTimeout(graceTimer)
    proc.stdin.end()
    if (!proc.killed) proc.kill('SIGTERM')
  }
}
