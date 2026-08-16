import * as acp from '@agentclientprotocol/sdk'
import {
  CopilotUnavailableError,
  READ_ONLY_TOOL_KINDS,
  decideAcpPermission,
  describeAcpFailure,
  describeToolKind,
  initializeAcp,
  isRecord,
  spawnCopilotAcp
} from '../copilot/acp'
import { log } from '../logger'
import { describeArg, truncate } from '../review/artifact'
import type { SubAgentActivity, SubAgentRunDeps, SubAgentResult } from './run'

// 프로토콜 배선은 [[copilot/acp]] 로 옮겼다(메인 에이전트·리뷰 경로와 공유한다). 이 파일에는
// **일회성 위임 서브런의** 턴 루프와 결과 계약만 남는다.
export { READ_ONLY_TOOL_KINDS, decideAcpPermission }

/**
 * ACP 의 메시지 청크는 **토큰 단위**로 온다(실측: 짧은 답 하나에 수십 건). 그대로 활동으로
 * 올리면 청크마다 사이드바 목록을 통째로 다시 방송하게 된다 — Claude 경로가 텍스트 **블록**당
 * 한 번 올리는 것과 자릿수가 다르다. 패널이 텍스트를 그리지도 않으므로 그 방송은 순수 낭비다.
 *
 * 그래서 청크는 모아 두고 **도구 호출이 끼어들 때** 한 줄로 flush 한다. Claude 의 블록 경계와
 * 같은 굵기가 되고, 타이머 같은 장치도 필요 없다. 최종 텍스트는 어차피 결과로 따로 돌아간다.
 */
export function activityFromAcpUpdate(update: acp.SessionUpdate): SubAgentActivity | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    return null
  // kind 는 사람이 읽는 이름이 아니다 — 'other' 를 도구 이름으로 올리면 사이드바에 "other" 가
  // 그대로 뜬다. 이름도 제목도 없으면 그 백엔드 이름으로 정직하게 적는다.
  const toolName = update.name || update.title || describeToolKind(update.kind)
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
  let handle
  try {
    handle = await spawnCopilotAcp(deps.cwd)
  } catch (err) {
    if (err instanceof CopilotUnavailableError) {
      return { text: '', sessionId: null, error: err.message }
    }
    throw err
  }

  // `deps.model` 과 `deps.effort` 를 **둘 다 무시한다.** 조용히 버리는 게 아니라 넘길 방법이 없다 —
  // 이유는 [[copilot/acp]] 의 spawnCopilotAcp 주석에 적어 뒀다.
  const { proc, stream } = handle
  let text = ''
  /** 아직 활동으로 안 내보낸 메시지 청크. 도구 호출 경계에서 한 줄로 flush 한다. */
  let pending = ''
  let sessionId: string | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  try {
    return await acp
      .client({ name: 'wooi' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        decideAcpPermission(deps, ctx.params)
      )
      .connectWith(stream, async (ctx) => {
        await initializeAcp(ctx)
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
                  pending += update.content.text
                }
                const activity = activityFromAcpUpdate(update)
                if (activity) {
                  // 모아 둔 청크를 도구 호출 **앞에** 한 줄로 내보낸다(activityFromAcpUpdate 주석).
                  if (pending.trim())
                    deps.onActivity({ kind: 'text', text: truncate(pending.trim()) })
                  pending = ''
                  deps.onActivity(activity)
                }
                continue
              }
              return resultFromAcpStop(
                text,
                sessionId,
                message.stopReason,
                deps.abort.signal.aborted,
                handle.stderr()
              )
            }
          } finally {
            deps.abort.signal.removeEventListener('abort', cancel)
          }
        })
      })
  } catch (err) {
    log.error('subagent: copilot ACP failed', err)
    return { text: '', sessionId: null, error: describeAcpFailure(err, handle.stderr()) }
  } finally {
    if (graceTimer) clearTimeout(graceTimer)
    handle.dispose()
  }
}
